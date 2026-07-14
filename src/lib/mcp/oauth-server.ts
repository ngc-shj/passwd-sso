/**
 * MCP OAuth 2.1 Authorization Code + PKCE server.
 *
 * Handles:
 * - Authorization code generation (for /api/mcp/authorize)
 * - PKCE verification (S256)
 * - Token exchange (for /api/mcp/token)
 * - Token validation (for /api/mcp tool calls)
 */

import { randomBytes, createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { PrismaClient, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/crypto/crypto-server";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { getLogger } from "@/lib/logger";
import {
  MCP_TOKEN_PREFIX,
  MCP_CODE_EXPIRY_SEC,
  MCP_TOKEN_EXPIRY_SEC,
  MCP_REFRESH_TOKEN_PREFIX,
  MCP_REFRESH_TOKEN_EXPIRY_SEC,
  MCP_REFRESH_TOKEN_FAMILY_ABSOLUTE_TIMEOUT_SEC,
  MAX_MCP_TOKEN_LAST_USED_THROTTLE_MS,
  MCP_AUTHORIZATION_CODE_MAX_LENGTH,
  MCP_CLIENT_ID_MAX_LENGTH,
  MCP_PRESENTED_TOKEN_MAX_LENGTH,
  REFRESH_EXCHANGE_REASON,
  type McpScope,
  type RefreshExchangeReason,
} from "@/lib/constants/auth/mcp";
import { MS_PER_SECOND } from "@/lib/constants/time";
import {
  derivePasskeyState,
  passkeyEnforcementBlocks,
} from "@/lib/auth/policy/passkey-enforcement";

export interface McpTokenData {
  tokenId: string;
  tenantId: string;
  clientId: string;        // Internal DB UUID (McpClient FK)
  mcpClientId: string;     // Public client ID (mcpc_xxx)
  userId: string | null;
  serviceAccountId: string | null;
  scopes: McpScope[];
}

export type McpTokenValidationResult =
  | { ok: true; data: McpTokenData }
  | { ok: false; error: string };

// ─── PKCE helpers ────────────────────────────────────────────

/** Compute S256 code challenge from plain verifier. */
export function computeS256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Verify PKCE S256: challenge must equal base64url(SHA-256(verifier)). */
export function verifyPkceS256(challenge: string, verifier: string): boolean {
  const expected = computeS256Challenge(verifier);
  return safeEqual(expected, challenge);
}

/** Same-length constant-time string comparison. Callers must ensure equal length. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * RFC 7009 §2.1: confidential clients must authenticate at revoke.
 * Returns true if the client is public or the secret matches.
 */
function verifyRevokeClientAuth(storedHash: string, providedHash?: string): boolean {
  if (storedHash === "") return true; // public client
  return !!providedHash && safeEqual(storedHash, providedHash);
}

// ─── Authorization code ───────────────────────────────────────

export interface CreateAuthCodeParams {
  clientId: string; // McpClient.id (UUID)
  tenantId: string;
  userId?: string;
  serviceAccountId?: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  codeChallengeMethod?: string;
}

export interface AuthCodeResult {
  code: string; // plaintext
  expiresAt: Date;
}

export async function createAuthorizationCode(
  params: CreateAuthCodeParams,
): Promise<AuthCodeResult> {
  const plainCode = randomBytes(32).toString("base64url");
  const codeHash = hashToken(plainCode);
  const expiresAt = new Date(Date.now() + MCP_CODE_EXPIRY_SEC * MS_PER_SECOND);

  await withBypassRls(prisma, async (tx) =>
    tx.mcpAuthorizationCode.create({
      data: {
        codeHash,
        clientId: params.clientId,
        tenantId: params.tenantId,
        userId: params.userId ?? null,
        serviceAccountId: params.serviceAccountId ?? null,
        redirectUri: params.redirectUri,
        scope: params.scope,
        codeChallenge: params.codeChallenge,
        codeChallengeMethod: params.codeChallengeMethod ?? "S256",
        expiresAt,
      },
    }),
  BYPASS_PURPOSE.TOKEN_LIFECYCLE);

  return { code: plainCode, expiresAt };
}

// ─── Token exchange ───────────────────────────────────────────

export interface ExchangeCodeParams {
  code: string;
  clientId: string; // McpClient.clientId (not UUID)
  clientSecretHash: string;
  redirectUri: string;
  codeVerifier: string;
  tokenExpirySeconds?: number;
}

export interface TokenExchangeResult {
  accessToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  scope: string;
  tokenId: string;
  clientDbId: string;
  tenantId: string;
  userId: string | null;
  serviceAccountId: string | null;
}

export type TokenExchangeError =
  | "invalid_grant"
  | "invalid_client"
  | "invalid_request"
  | "access_denied";

export type TokenExchangeOutcome =
  | { ok: true; data: TokenExchangeResult }
  | {
      ok: false;
      error: TokenExchangeError;
      errorDescription?: string;
      // Populated only on the passkey-enforcement (access_denied) path so the
      // route can emit the PASSKEY_ENFORCEMENT_BLOCKED audit.
      userId?: string | null;
      tenantId?: string;
    };

/**
 * Read-only tenant resolution for the token endpoint's IP-access gate. The token
 * endpoint must enforce the tenant's allowed-CIDR / Tailscale policy BEFORE the
 * side-effecting exchange (mint / rotation) — otherwise a stolen code or refresh
 * token could be redeemed / rotated from an off-network IP, and post-mint denial
 * would strand a legitimate client whose refresh chain was already rotated. These
 * helpers resolve the grant's tenantId without consuming or mutating anything, so
 * the caller can run enforceAccessRestriction with a tenantIdOverride first. A
 * grant that resolves to no tenant returns null; the caller lets the real
 * exchange produce the authoritative invalid_grant / invalid_client error (the
 * IP gate only ever restricts, never grants).
 */
export async function resolveCodeTenantId(code: string): Promise<string | null> {
  if (!code || code.length > MCP_AUTHORIZATION_CODE_MAX_LENGTH) return null;
  const codeHash = hashToken(code);
  return withBypassRls(
    prisma,
    async (tx) => {
      const row = await tx.mcpAuthorizationCode.findUnique({
        where: { codeHash },
        select: { tenantId: true },
      });
      return row?.tenantId ?? null;
    },
    BYPASS_PURPOSE.TOKEN_LIFECYCLE,
  );
}

export interface RefreshTokenGate {
  tenantId: string;
  /**
   * True when the presented token was already rotated (a replay). The caller MUST
   * NOT apply the IP gate to a replayed token: replay is a strong theft signal, and
   * exchangeRefreshToken revokes the whole family on replay. Gating a replay on IP
   * would short-circuit before that family revocation runs, suppressing the alarm
   * for an off-network attacker — the exact suppression the mint-point passkey
   * ordering (see exchangeRefreshToken) is written to avoid. Live-rotation requests
   * (alreadyRotated === false) are still IP-gated before their rotation.
   */
  alreadyRotated: boolean;
}

export async function resolveRefreshTokenGate(
  refreshToken: string,
): Promise<RefreshTokenGate | null> {
  if (!refreshToken || refreshToken.length > MCP_PRESENTED_TOKEN_MAX_LENGTH) return null;
  const tokenHash = hashToken(refreshToken);
  return withBypassRls(
    prisma,
    async (tx) => {
      const row = await tx.mcpRefreshToken.findUnique({
        where: { tokenHash },
        select: { tenantId: true, rotatedAt: true },
      });
      if (!row) return null;
      return { tenantId: row.tenantId, alreadyRotated: row.rotatedAt !== null };
    },
    BYPASS_PURPOSE.TOKEN_LIFECYCLE,
  );
}

export async function exchangeCodeForToken(
  params: ExchangeCodeParams,
): Promise<TokenExchangeOutcome> {
  if (!params.code || params.code.length > MCP_AUTHORIZATION_CODE_MAX_LENGTH) {
    return { ok: false, error: "invalid_grant" };
  }
  if (!params.clientId || params.clientId.length > MCP_CLIENT_ID_MAX_LENGTH) {
    return { ok: false, error: "invalid_client" };
  }
  const codeHash = hashToken(params.code);

  const result = await withBypassRls(prisma, async (tx) => {
    const authCode = await tx.mcpAuthorizationCode.findUnique({
      where: { codeHash },
      include: { mcpClient: true },
    });

    if (!authCode) return { error: "invalid_grant" as const };
    if (authCode.usedAt) return { error: "invalid_grant" as const };
    if (authCode.expiresAt < new Date()) return { error: "invalid_grant" as const };

    // Verify client identity (public clients have empty clientSecretHash)
    if (authCode.mcpClient.clientId !== params.clientId)
      return { error: "invalid_client" as const };
    const isPublicClient = authCode.mcpClient.clientSecretHash === "";
    if (!isPublicClient && !safeEqual(authCode.mcpClient.clientSecretHash, params.clientSecretHash))
      return { error: "invalid_client" as const };
    if (!authCode.mcpClient.isActive) return { error: "invalid_client" as const };

    // Null guard for DCR clients (must be claimed before token exchange)
    if (!authCode.tenantId || !authCode.mcpClient.tenantId) {
      return { error: "invalid_client" as const };
    }

    // Tenant boundary guard
    if (authCode.tenantId !== authCode.mcpClient.tenantId)
      return { error: "invalid_grant" as const };

    // Verify redirect_uri matches
    if (authCode.redirectUri !== params.redirectUri)
      return { error: "invalid_grant" as const };

    // PKCE S256 verification
    if (authCode.codeChallengeMethod !== "S256")
      return { error: "invalid_request" as const };
    if (!verifyPkceS256(authCode.codeChallenge, params.codeVerifier))
      return { error: "invalid_grant" as const };

    // Passkey enforcement at the auth_code → token MINT point. The code was
    // gated at consent creation, but enforcement can flip (or a passkey be
    // removed) within the code TTL, so re-derive here before minting. This runs
    // BEFORE the consume so a blocked exchange does NOT burn the code — the user
    // can retry within the code TTL after satisfying enforcement. (Mirrors the
    // refresh path, which also gates passkey before its CAS claim.) SA-bound
    // (userId null) skip.
    if (authCode.userId !== null) {
      const pk = await derivePasskeyState({
        userId: authCode.userId,
        tenantId: authCode.tenantId,
        tx,
      });
      if (passkeyEnforcementBlocks(pk)) {
        return {
          error: "access_denied" as const,
          userId: authCode.userId,
          tenantId: authCode.tenantId,
        };
      }
    }

    // Mark code as used via compare-and-swap. The findUnique above takes no
    // row lock (Read Committed), so two concurrent exchanges can both observe
    // usedAt === null; gating the consume on `usedAt: null` makes the loser's
    // count === 0 and aborts it, preventing double-redemption of one code into
    // multiple independent token families. Mirrors the refresh-token CAS below.
    const consumed = await tx.mcpAuthorizationCode.updateMany({
      where: { id: authCode.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (consumed.count === 0) return { error: "invalid_grant" as const };

    // Issue access token
    const plainToken = MCP_TOKEN_PREFIX + randomBytes(32).toString("base64url");
    const tokenHash = hashToken(plainToken);
    const expirySeconds = Math.min(
      params.tokenExpirySeconds ?? MCP_TOKEN_EXPIRY_SEC,
      MCP_TOKEN_EXPIRY_SEC,
    );
    const expiresAt = new Date(Date.now() + expirySeconds * MS_PER_SECOND);

    const newAccessToken = await tx.mcpAccessToken.create({
      data: {
        tokenHash,
        clientId: authCode.clientId,
        tenantId: authCode.tenantId,
        userId: authCode.userId,
        serviceAccountId: authCode.serviceAccountId,
        scope: authCode.scope,
        expiresAt,
      },
    });

    return {
      ok: true as const,
      accessToken: plainToken,
      expiresIn: expirySeconds,
      scope: authCode.scope,
      tokenId: newAccessToken.id,
      clientDbId: authCode.clientId,
      tenantId: authCode.tenantId,
      userId: authCode.userId,
      serviceAccountId: authCode.serviceAccountId,
    };
  }, BYPASS_PURPOSE.TOKEN_LIFECYCLE);

  if ("error" in result) {
    return {
      ok: false,
      error: result.error as TokenExchangeError,
      // Carry the passkey-path identifiers (present only on access_denied) so
      // the route can emit the block audit; undefined for all other errors.
      userId: "userId" in result ? result.userId : undefined,
      tenantId: "tenantId" in result ? result.tenantId : undefined,
    };
  }
  return {
    ok: true,
    data: {
      accessToken: result.accessToken,
      tokenType: "Bearer",
      expiresIn: result.expiresIn,
      scope: result.scope,
      tokenId: result.tokenId,
      clientDbId: result.clientDbId,
      tenantId: result.tenantId,
      userId: result.userId,
      serviceAccountId: result.serviceAccountId,
    },
  };
}

// ─── Refresh token ────────────────────────────────────────────

/**
 * Create a refresh token for an MCP client.
 * familyId groups tokens in a rotation chain for bulk revocation.
 * familyCreatedAt records the family's birth time for absolute-cap enforcement.
 */
export async function createRefreshToken(params: {
  accessTokenId: string;
  clientId: string; // McpClient.id (UUID)
  tenantId: string;
  userId?: string | null;
  serviceAccountId?: string | null;
  scope: string;
  familyId?: string; // Reuse for rotation, generate new for initial issue
}): Promise<{ refreshToken: string; expiresAt: Date }> {
  const token = MCP_REFRESH_TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const familyId = params.familyId ?? randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + MCP_REFRESH_TOKEN_EXPIRY_SEC * MS_PER_SECOND);

  await withBypassRls(prisma, async (tx) => {
    await tx.mcpRefreshToken.create({
      data: {
        tokenHash,
        familyId,
        familyCreatedAt: now,
        accessTokenId: params.accessTokenId,
        clientId: params.clientId,
        tenantId: params.tenantId,
        userId: params.userId ?? undefined,
        serviceAccountId: params.serviceAccountId ?? undefined,
        scope: params.scope,
        expiresAt,
      },
    });
  }, BYPASS_PURPOSE.TOKEN_LIFECYCLE);

  return { refreshToken: token, expiresAt };
}

/**
 * Exchange a refresh token for a new access + refresh token pair.
 *
 * Implements refresh-token rotation with fail-closed family revocation per
 * RFC 9700 §4.14.2 (extended to concurrent rotation case — see plan
 * docs/archive/review/adversarial-crypto-tenant-tests-plan.md Contract 2).
 *
 * Phase 1 (transactional): validate + atomic CAS to claim rotation slot +
 * create new tokens on win. On replay (already-rotated token) or race-loss
 * (CAS count===0), Phase 1 returns a typed marker without mutating tokens.
 *
 * Phase 2 (separate transaction): on replay/race-loss, fire family
 * revocation. The separate transaction commits regardless of Phase 1
 * outcome, eliminating the rollback window where attacker tokens would
 * survive.
 *
 * `options.prisma` allows tests to inject independent connection pools
 * (Contract 6) so Promise.all of two exchangeRefreshToken calls actually
 * races on distinct connections.
 */
export async function exchangeRefreshToken(
  params: {
    refreshToken: string;
    clientId: string; // McpClient.clientId (mcpc_xxx)
    clientSecretHash: string;
    now?: () => number; // Injectable clock for deterministic cap tests
  },
  options: { prisma?: PrismaClient } = {},
): Promise<
  | {
      ok: true;
      accessToken: string;
      accessTokenId: string;
      refreshToken: string;
      refreshTokenId: string;
      familyId: string;
      expiresIn: number;
      scope: string;
      tenantId: string;
      userId: string | null;
    }
  | {
      ok: false;
      error: "invalid_grant" | "invalid_client" | "access_denied";
      reason?: RefreshExchangeReason;
      tenantId?: string;
      familyId?: string;
      userId?: string | null;
      // Token-row-derived McpClient public id (mcpc_...) for replay/race_lost
      // outcomes — the authoritative attribution for audit metadata, as
      // opposed to the caller-supplied params.clientId which an attacker
      // replaying a stolen token controls. Server-side audit use only; never
      // included in the HTTP response body.
      storedClientId?: string;
    }
> {
  if (!params.refreshToken || params.refreshToken.length > MCP_PRESENTED_TOKEN_MAX_LENGTH) {
    return { ok: false, error: "invalid_grant" };
  }
  if (!params.clientId || params.clientId.length > MCP_CLIENT_ID_MAX_LENGTH) {
    return { ok: false, error: "invalid_client" };
  }
  const dbClient = options.prisma ?? prisma;
  const tokenHash = hashToken(params.refreshToken);
  const nowMs = params.now ? params.now() : Date.now();

  // Phase 1: validate + CAS + create new tokens (or detect race/replay).
  // The `tx` argument from withBypassRls is the transaction-scoped client
  // with bypass_rls + token_lifecycle GUCs already set on its connection.
  // Per Contract 1: do NOT call dbClient.$transaction(...) inside — that
  // would open a second transaction on a different connection where the
  // GUCs are not set, and FORCE-RLS tables would silently filter to zero
  // rows (test injection path with raw client).
  const phase1 = await withBypassRls(
    dbClient,
    async (tx) => {
      const rt = await tx.mcpRefreshToken.findUnique({
        where: { tokenHash },
        select: {
          id: true,
          tokenHash: true,
          rotatedAt: true,
          revokedAt: true,
          expiresAt: true,
          clientId: true,
          tenantId: true,
          userId: true,
          serviceAccountId: true,
          familyId: true,
          familyCreatedAt: true,
          accessTokenId: true,
          scope: true,
          mcpClient: true,
        },
      });

      if (!rt) return { type: "not_found" as const };

      // Replay: caller presented an already-rotated token
      if (rt.rotatedAt) {
        return {
          type: "replay" as const,
          tenantId: rt.tenantId,
          familyId: rt.familyId,
          accessTokenId: rt.accessTokenId,
          storedClientId: rt.mcpClient.clientId,
        };
      }

      if (rt.revokedAt) return { type: "revoked" as const };
      if (rt.expiresAt < new Date()) return { type: "expired" as const };

      // Validate client identity (public clients have empty clientSecretHash)
      const isPublicClient = rt.mcpClient.clientSecretHash === "";
      if (
        rt.mcpClient.clientId !== params.clientId ||
        (!isPublicClient && !safeEqual(rt.mcpClient.clientSecretHash, params.clientSecretHash)) ||
        !rt.mcpClient.isActive
      ) {
        return { type: "invalid_client" as const };
      }

      // Defensive tenant-boundary check: do not propagate a divergent tenantId
      // from a corrupted source row into the freshly minted token pair.
      if (rt.mcpClient.tenantId !== rt.tenantId) {
        return { type: "invalid_client" as const };
      }

      // C8 absolute family cap: refuse rotation when the family has exceeded its
      // maximum lifetime, regardless of individual token validity. Mirrors the
      // ExtensionToken.familyCreatedAt cap (30 d) for MCP token-lifetime parity.
      if (
        nowMs - rt.familyCreatedAt.getTime() >
        MCP_REFRESH_TOKEN_FAMILY_ABSOLUTE_TIMEOUT_SEC * MS_PER_SECOND
      ) {
        return { type: "family_cap_exceeded" as const };
      }

      // C13: reject deactivated users before issuing new tokens.
      // SA-bound tokens (userId === null) skip — no TenantMember row.
      if (rt.userId !== null) {
        const memberStatus = await checkTenantMembership(tx, rt.tenantId, rt.userId);
        if (!memberStatus) return { type: "deactivated_user" as const };
      }

      // Passkey enforcement at the MINT point — AFTER replay/revoked/expired/
      // client/cap/deactivated validation (so theft-detection family-revocation
      // for a replayed token is never suppressed), BEFORE minting. SA-bound
      // tokens (userId null) skip — passkeys are a human-identity ceremony.
      if (rt.userId !== null) {
        const pk = await derivePasskeyState({ userId: rt.userId, tenantId: rt.tenantId, tx });
        if (passkeyEnforcementBlocks(pk)) {
          return { type: "passkey_required" as const, tenantId: rt.tenantId, userId: rt.userId };
        }
      }

      // Generate new tokens up-front so we can include the new hash in the CAS
      const newAccessToken = MCP_TOKEN_PREFIX + randomBytes(32).toString("base64url");
      const newAccessTokenHash = hashToken(newAccessToken);
      const accessExpiresAt = new Date(Date.now() + MCP_TOKEN_EXPIRY_SEC * MS_PER_SECOND);

      const newRefreshToken = MCP_REFRESH_TOKEN_PREFIX + randomBytes(32).toString("base64url");
      const newRefreshTokenHash = hashToken(newRefreshToken);
      const refreshExpiresAt = new Date(Date.now() + MCP_REFRESH_TOKEN_EXPIRY_SEC * MS_PER_SECOND);

      // Atomic compare-and-swap: claim the rotation slot.
      // UPDATE ... WHERE rotatedAt IS NULL acquires a row-level lock; concurrent
      // transactions block here and after winner commits, see count===0.
      const claim = await tx.mcpRefreshToken.updateMany({
        where: { id: rt.id, rotatedAt: null },
        data: { rotatedAt: new Date(), replacedByHash: newRefreshTokenHash },
      });

      if (claim.count === 0) {
        // Race lost — another transaction won the CAS between our findUnique and updateMany.
        return {
          type: "race_lost" as const,
          tenantId: rt.tenantId,
          familyId: rt.familyId,
          accessTokenId: rt.accessTokenId,
          storedClientId: rt.mcpClient.clientId,
        };
      }

      // Won the race — create new tokens.
      const newAccess = await tx.mcpAccessToken.create({
        data: {
          tokenHash: newAccessTokenHash,
          clientId: rt.clientId,
          tenantId: rt.tenantId,
          userId: rt.userId,
          serviceAccountId: rt.serviceAccountId,
          scope: rt.scope,
          expiresAt: accessExpiresAt,
        },
      });

      const newRefresh = await tx.mcpRefreshToken.create({
        data: {
          tokenHash: newRefreshTokenHash,
          familyId: rt.familyId,
          familyCreatedAt: rt.familyCreatedAt, // Carry forward the family's original birth time
          accessTokenId: newAccess.id,
          clientId: rt.clientId,
          tenantId: rt.tenantId,
          userId: rt.userId,
          serviceAccountId: rt.serviceAccountId,
          scope: rt.scope,
          expiresAt: refreshExpiresAt,
        },
      });

      // Revoke the OLD access token (the one paired with the now-rotated refresh).
      await tx.mcpAccessToken.update({
        where: { id: rt.accessTokenId },
        data: { revokedAt: new Date() },
      });

      return {
        type: "success" as const,
        accessToken: newAccessToken,
        accessTokenId: newAccess.id,
        refreshToken: newRefreshToken,
        refreshTokenId: newRefresh.id,
        familyId: rt.familyId,
        expiresIn: MCP_TOKEN_EXPIRY_SEC,
        scope: rt.scope,
        tenantId: rt.tenantId,
        userId: rt.userId,
      };
    },
    BYPASS_PURPOSE.TOKEN_LIFECYCLE,
  );

  // Phase 2: handle outcomes
  switch (phase1.type) {
    case "success":
      return {
        ok: true,
        accessToken: phase1.accessToken,
        accessTokenId: phase1.accessTokenId,
        refreshToken: phase1.refreshToken,
        refreshTokenId: phase1.refreshTokenId,
        familyId: phase1.familyId,
        expiresIn: phase1.expiresIn,
        scope: phase1.scope,
        tenantId: phase1.tenantId,
        userId: phase1.userId,
      };
    case "not_found":
      return { ok: false, error: "invalid_grant" };
    case "revoked":
      return { ok: false, error: "invalid_grant", reason: REFRESH_EXCHANGE_REASON.REVOKED };
    case "expired":
      return { ok: false, error: "invalid_grant", reason: REFRESH_EXCHANGE_REASON.EXPIRED };
    case "invalid_client":
      return { ok: false, error: "invalid_client" };
    case "family_cap_exceeded":
      return { ok: false, error: "invalid_grant" };
    case "deactivated_user":
      return { ok: false, error: "invalid_grant" };
    case "passkey_required":
      return {
        ok: false,
        error: "access_denied",
        reason: REFRESH_EXCHANGE_REASON.PASSKEY_REQUIRED,
        tenantId: phase1.tenantId,
        userId: phase1.userId,
      };
    case "replay":
    case "race_lost": {
      // Fail-closed family revocation in a transaction independent of Phase 1
      // so it commits regardless of business-tx outcome (Contract 2).
      await revokeFamilyOutOfBand(dbClient, phase1.familyId, phase1.accessTokenId);
      return {
        ok: false,
        error: "invalid_grant",
        reason:
          phase1.type === "replay"
            ? REFRESH_EXCHANGE_REASON.REPLAY
            : REFRESH_EXCHANGE_REASON.CONCURRENT_ROTATION_REVOKED,
        tenantId: phase1.tenantId,
        familyId: phase1.familyId,
        storedClientId: phase1.storedClientId,
      };
    }
  }
}

/**
 * Fail-closed family revocation. Runs in a transaction independent of the
 * caller's business transaction so it commits regardless of business-tx
 * outcome (Contract 2). On revocation transaction failure, log and return
 * — the caller's response (invalid_grant) is already semantically correct.
 */
async function revokeFamilyOutOfBand(
  dbClient: PrismaClient,
  familyId: string,
  accessTokenId: string,
): Promise<void> {
  try {
    await withBypassRls(
      dbClient,
      async (tx) => {
        const familyTokens = await tx.mcpRefreshToken.findMany({
          where: { familyId },
          select: { accessTokenId: true },
        });
        const accessTokenIds = [
          ...new Set([accessTokenId, ...familyTokens.map((t) => t.accessTokenId)]),
        ];

        await tx.mcpRefreshToken.updateMany({
          where: { familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        if (accessTokenIds.length > 0) {
          await tx.mcpAccessToken.updateMany({
            where: { id: { in: accessTokenIds }, revokedAt: null },
            data: { revokedAt: new Date() },
          });
        }
      },
      BYPASS_PURPOSE.TOKEN_LIFECYCLE,
    );
  } catch (err) {
    getLogger().error(
      { err, familyId, accessTokenId },
      "mcp.refresh_token.family_revocation_failed",
    );
  }
}

// ─── Shared membership helper ─────────────────────────────────

/**
 * Returns true iff the user has an active TenantMember row in the given
 * tenant (deactivatedAt IS NULL). Used by both validateMcpToken and
 * exchangeRefreshToken to enforce C13 deactivated-user rejection.
 *
 * Accepts a transactional or plain Prisma client so callers can reuse
 * their existing bypass-RLS transaction instead of opening a new one.
 */
async function checkTenantMembership(
  tx: Prisma.TransactionClient,
  tenantId: string,
  userId: string,
): Promise<boolean> {
  const member = await tx.tenantMember.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
    select: { deactivatedAt: true },
  });
  return member !== null && member.deactivatedAt === null;
}

// ─── Token validation ─────────────────────────────────────────

export async function validateMcpToken(
  token: string,
): Promise<McpTokenValidationResult> {
  if (
    !token.startsWith(MCP_TOKEN_PREFIX) ||
    token.length > MCP_PRESENTED_TOKEN_MAX_LENGTH
  ) {
    return { ok: false, error: "invalid_token" };
  }

  const tokenHash = hashToken(token);

  const record = await withBypassRls(prisma, async (tx) =>
    tx.mcpAccessToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        tenantId: true,
        clientId: true,
        mcpClient: { select: { clientId: true, isActive: true, tenantId: true } },
        userId: true,
        serviceAccountId: true,
        scope: true,
        expiresAt: true,
        revokedAt: true,
        lastUsedAt: true,
      },
    }),
  BYPASS_PURPOSE.TOKEN_LIFECYCLE);

  if (!record) return { ok: false, error: "invalid_token" };
  if (record.revokedAt) return { ok: false, error: "token_revoked" };
  if (record.expiresAt < new Date()) return { ok: false, error: "token_expired" };
  // A07-4: third McpClient lookup site — reject inactive clients so an admin's
  // "Deactivate client" action takes immediate effect, not just after token TTL.
  if (!record.mcpClient.isActive) return { ok: false, error: "invalid_token" };
  // Defensive tenant-boundary check: the token's denormalized tenantId must match
  // its parent client's own tenantId. Issuance keeps them consistent; a mismatch
  // means a corrupted row — fail closed rather than trust the token's tenantId.
  if (record.mcpClient.tenantId !== record.tenantId) {
    return { ok: false, error: "invalid_token" };
  }

  // C13: reject deactivated users — tenant-scoped to the token's own tenant.
  // SA-bound tokens (userId === null) skip the membership check: they are
  // non-human identities with no TenantMember row.
  // Fail-closed: no active membership row ⇒ invalid (cross-tenant bypass guard).
  if (record.userId !== null) {
    const active = await withBypassRls(prisma, (tx) =>
      checkTenantMembership(tx, record.tenantId, record.userId as string),
    BYPASS_PURPOSE.TOKEN_LIFECYCLE);
    if (!active) return { ok: false, error: "invalid_token" };
  }

  // Throttled lastUsedAt update (fire-and-forget)
  const shouldUpdate =
    !record.lastUsedAt ||
    Date.now() - record.lastUsedAt.getTime() > MAX_MCP_TOKEN_LAST_USED_THROTTLE_MS;
  if (shouldUpdate) {
    void withBypassRls(prisma, (tx) =>
      tx.mcpAccessToken.update({
        where: { id: record.id },
        data: { lastUsedAt: new Date() },
      }),
    BYPASS_PURPOSE.TOKEN_LIFECYCLE).catch((err) => {
      getLogger().warn({ err }, "mcp.token.lastUsedAt.update_failed");
    });
  }

  return {
    ok: true,
    data: {
      tokenId: record.id,
      tenantId: record.tenantId,
      clientId: record.clientId,
      mcpClientId: record.mcpClient.clientId,
      userId: record.userId,
      serviceAccountId: record.serviceAccountId,
      scopes: record.scope.split(",").map((s) => s.trim()).filter(Boolean) as McpScope[],
    },
  };
}

// ─── Token revocation (RFC 7009) ─────────────────────────────

/**
 * Revoke an access token or refresh token.
 * If a refresh token is revoked, all tokens in its rotation family
 * and their associated access tokens are also revoked.
 *
 * Per RFC 7009 §2.2, always succeeds (even if the token is unknown
 * or already revoked) — the caller should return 200 regardless.
 */
export async function revokeToken(params: {
  token: string;
  tokenTypeHint?: "access_token" | "refresh_token";
  clientId: string;
  clientSecretHash?: string;
}): Promise<void> {
  if (
    !params.token ||
    params.token.length > MCP_PRESENTED_TOKEN_MAX_LENGTH ||
    !params.clientId ||
    params.clientId.length > MCP_CLIENT_ID_MAX_LENGTH
  ) {
    return;
  }
  const tokenHash = hashToken(params.token);

  await withBypassRls(prisma, async (tx) => {
    // Try refresh token first (if hint says so or no hint)
    if (params.tokenTypeHint !== "access_token") {
      const rt = await tx.mcpRefreshToken.findUnique({
        where: { tokenHash },
        include: { mcpClient: { select: { clientId: true, clientSecretHash: true } } },
      });

      if (rt && rt.mcpClient.clientId === params.clientId) {
        if (!verifyRevokeClientAuth(rt.mcpClient.clientSecretHash, params.clientSecretHash)) return;
        // Revoke entire rotation family
        await tx.mcpRefreshToken.updateMany({
          where: { familyId: rt.familyId, tenantId: rt.tenantId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        // Revoke all associated access tokens in the family
        const familyTokens = await tx.mcpRefreshToken.findMany({
          where: { familyId: rt.familyId, tenantId: rt.tenantId },
          select: { accessTokenId: true },
        });
        const accessTokenIds = [...new Set(familyTokens.map((t) => t.accessTokenId))];
        if (accessTokenIds.length > 0) {
          await tx.mcpAccessToken.updateMany({
            where: { id: { in: accessTokenIds }, tenantId: rt.tenantId, revokedAt: null },
            data: { revokedAt: new Date() },
          });
        }
        return;
      }
    }

    // Try access token
    const at = await tx.mcpAccessToken.findUnique({
      where: { tokenHash },
      include: { mcpClient: { select: { clientId: true, clientSecretHash: true } } },
    });

    if (at && at.mcpClient.clientId === params.clientId) {
      if (!verifyRevokeClientAuth(at.mcpClient.clientSecretHash, params.clientSecretHash)) return;
      await tx.mcpAccessToken.update({
        where: { id: at.id, tenantId: at.tenantId },
        data: { revokedAt: new Date() },
      });
    }

    // Unknown/already revoked token → silent success per RFC 7009
  }, BYPASS_PURPOSE.TOKEN_LIFECYCLE);
}
