/**
 * MCP OAuth 2.1 Authorization Code + PKCE server.
 *
 * Handles:
 * - Authorization code generation (for /api/mcp/authorize)
 * - PKCE verification (S256)
 * - Token exchange (for /api/mcp/token)
 * - Token validation (for /api/mcp tool calls)
 */

import { randomBytes, createHash, randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/crypto-server";
import { withBypassRls } from "@/lib/tenant-rls";
import { getLogger } from "@/lib/logger";
import {
  MCP_TOKEN_PREFIX,
  MCP_CODE_EXPIRY_SEC,
  MCP_TOKEN_EXPIRY_SEC,
  MCP_REFRESH_TOKEN_PREFIX,
  MCP_REFRESH_TOKEN_EXPIRY_SEC,
  MAX_MCP_TOKEN_LAST_USED_THROTTLE_MS,
  type McpScope,
} from "@/lib/constants/mcp";

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
  // Constant-time comparison
  if (expected.length !== challenge.length) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(challenge);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
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
  const expiresAt = new Date(Date.now() + MCP_CODE_EXPIRY_SEC * 1000);

  await withBypassRls(prisma, async () =>
    prisma.mcpAuthorizationCode.create({
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
  );

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
  | "invalid_request";

export type TokenExchangeOutcome =
  | { ok: true; data: TokenExchangeResult }
  | { ok: false; error: TokenExchangeError; errorDescription?: string };

export async function exchangeCodeForToken(
  params: ExchangeCodeParams,
): Promise<TokenExchangeOutcome> {
  const codeHash = hashToken(params.code);

  const result = await withBypassRls(prisma, async () =>
    prisma.$transaction(async (tx) => {
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
      if (!isPublicClient && authCode.mcpClient.clientSecretHash !== params.clientSecretHash)
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

      // Mark code as used (atomic within transaction)
      await tx.mcpAuthorizationCode.update({
        where: { id: authCode.id },
        data: { usedAt: new Date() },
      });

      // Issue access token
      const plainToken = MCP_TOKEN_PREFIX + randomBytes(32).toString("base64url");
      const tokenHash = hashToken(plainToken);
      const expirySeconds = Math.min(
        params.tokenExpirySeconds ?? MCP_TOKEN_EXPIRY_SEC,
        MCP_TOKEN_EXPIRY_SEC,
      );
      const expiresAt = new Date(Date.now() + expirySeconds * 1000);

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
    }),
  );

  if ("error" in result) {
    return { ok: false, error: result.error as TokenExchangeError };
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
  const expiresAt = new Date(Date.now() + MCP_REFRESH_TOKEN_EXPIRY_SEC * 1000);

  await withBypassRls(prisma, async () => {
    await prisma.mcpRefreshToken.create({
      data: {
        tokenHash,
        familyId,
        accessTokenId: params.accessTokenId,
        clientId: params.clientId,
        tenantId: params.tenantId,
        userId: params.userId ?? undefined,
        serviceAccountId: params.serviceAccountId ?? undefined,
        scope: params.scope,
        expiresAt,
      },
    });
  });

  return { refreshToken: token, expiresAt };
}

/**
 * Exchange a refresh token for a new access + refresh token pair.
 * Implements OAuth 2.1 rotation with replay detection.
 */
export async function exchangeRefreshToken(params: {
  refreshToken: string;
  clientId: string; // McpClient.clientId (mcpc_xxx)
  clientSecretHash: string;
}): Promise<
  | { ok: true; accessToken: string; refreshToken: string; expiresIn: number; scope: string; tenantId: string; userId: string | null }
  | { ok: false; error: "invalid_grant" | "invalid_client"; reason?: "replay" | "expired" | "revoked"; tenantId?: string; familyId?: string }
> {
  const tokenHash = hashToken(params.refreshToken);

  return await withBypassRls(prisma, async () =>
    prisma.$transaction(async (tx) => {
      const rt = await tx.mcpRefreshToken.findUnique({
        where: { tokenHash },
        include: { mcpClient: true },
      });

      if (!rt) return { ok: false as const, error: "invalid_grant" as const };

      // Replay detection: if already rotated, revoke entire family
      if (rt.rotatedAt) {
        await tx.mcpRefreshToken.updateMany({
          where: { familyId: rt.familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        // Also revoke associated access tokens
        const familyTokens = await tx.mcpRefreshToken.findMany({
          where: { familyId: rt.familyId },
          select: { accessTokenId: true },
        });
        const accessTokenIds = [...new Set(familyTokens.map((t) => t.accessTokenId))];
        if (accessTokenIds.length > 0) {
          await tx.mcpAccessToken.updateMany({
            where: { id: { in: accessTokenIds }, revokedAt: null },
            data: { revokedAt: new Date() },
          });
        }
        return { ok: false as const, error: "invalid_grant" as const, reason: "replay" as const, tenantId: rt.tenantId, familyId: rt.familyId };
      }

      // Validate: not expired, not revoked
      if (rt.revokedAt || rt.expiresAt < new Date()) {
        const reason = rt.revokedAt ? "revoked" as const : "expired" as const;
        return { ok: false as const, error: "invalid_grant" as const, reason };
      }

      // Validate client identity (public clients have empty clientSecretHash)
      const isPublicClient = rt.mcpClient.clientSecretHash === "";
      if (
        rt.mcpClient.clientId !== params.clientId ||
        (!isPublicClient && rt.mcpClient.clientSecretHash !== params.clientSecretHash) ||
        !rt.mcpClient.isActive
      ) {
        return { ok: false as const, error: "invalid_client" as const };
      }

      // Mark old refresh token as rotated
      const newAccessToken = MCP_TOKEN_PREFIX + randomBytes(32).toString("base64url");
      const newAccessTokenHash = hashToken(newAccessToken);
      const accessExpiresAt = new Date(Date.now() + MCP_TOKEN_EXPIRY_SEC * 1000);

      const newRefreshToken = MCP_REFRESH_TOKEN_PREFIX + randomBytes(32).toString("base64url");
      const newRefreshTokenHash = hashToken(newRefreshToken);
      const refreshExpiresAt = new Date(Date.now() + MCP_REFRESH_TOKEN_EXPIRY_SEC * 1000);

      // Create new access token
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

      // Create new refresh token (same family)
      await tx.mcpRefreshToken.create({
        data: {
          tokenHash: newRefreshTokenHash,
          familyId: rt.familyId,
          accessTokenId: newAccess.id,
          clientId: rt.clientId,
          tenantId: rt.tenantId,
          userId: rt.userId,
          serviceAccountId: rt.serviceAccountId,
          scope: rt.scope,
          expiresAt: refreshExpiresAt,
        },
      });

      // Mark old as rotated and revoke old access token
      await tx.mcpRefreshToken.update({
        where: { id: rt.id },
        data: { rotatedAt: new Date(), replacedByHash: newRefreshTokenHash },
      });
      await tx.mcpAccessToken.update({
        where: { id: rt.accessTokenId },
        data: { revokedAt: new Date() },
      });

      return {
        ok: true as const,
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
        expiresIn: MCP_TOKEN_EXPIRY_SEC,
        scope: rt.scope,
        tenantId: rt.tenantId,
        userId: rt.userId,
      };
    }),
  );
}

// ─── Token validation ─────────────────────────────────────────

export async function validateMcpToken(
  token: string,
): Promise<McpTokenValidationResult> {
  if (!token.startsWith(MCP_TOKEN_PREFIX)) {
    return { ok: false, error: "invalid_token" };
  }

  const tokenHash = hashToken(token);

  const record = await withBypassRls(prisma, async () =>
    prisma.mcpAccessToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        tenantId: true,
        clientId: true,
        mcpClient: { select: { clientId: true } },
        userId: true,
        serviceAccountId: true,
        scope: true,
        expiresAt: true,
        revokedAt: true,
        lastUsedAt: true,
      },
    }),
  );

  if (!record) return { ok: false, error: "invalid_token" };
  if (record.revokedAt) return { ok: false, error: "token_revoked" };
  if (record.expiresAt < new Date()) return { ok: false, error: "token_expired" };

  // Throttled lastUsedAt update (fire-and-forget)
  const shouldUpdate =
    !record.lastUsedAt ||
    Date.now() - record.lastUsedAt.getTime() > MAX_MCP_TOKEN_LAST_USED_THROTTLE_MS;
  if (shouldUpdate) {
    void withBypassRls(prisma, () =>
      prisma.mcpAccessToken.update({
        where: { id: record.id },
        data: { lastUsedAt: new Date() },
      }),
    ).catch((err) => {
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
}): Promise<void> {
  const tokenHash = hashToken(params.token);

  await withBypassRls(prisma, async () =>
    prisma.$transaction(async (tx) => {
      // Try refresh token first (if hint says so or no hint)
      if (params.tokenTypeHint !== "access_token") {
        const rt = await tx.mcpRefreshToken.findUnique({
          where: { tokenHash },
          include: { mcpClient: { select: { clientId: true } } },
        });

        if (rt && rt.mcpClient.clientId === params.clientId) {
          // Revoke entire rotation family
          await tx.mcpRefreshToken.updateMany({
            where: { familyId: rt.familyId, revokedAt: null },
            data: { revokedAt: new Date() },
          });
          // Revoke all associated access tokens in the family
          const familyTokens = await tx.mcpRefreshToken.findMany({
            where: { familyId: rt.familyId },
            select: { accessTokenId: true },
          });
          const accessTokenIds = [...new Set(familyTokens.map((t) => t.accessTokenId))];
          if (accessTokenIds.length > 0) {
            await tx.mcpAccessToken.updateMany({
              where: { id: { in: accessTokenIds }, revokedAt: null },
              data: { revokedAt: new Date() },
            });
          }
          return;
        }
      }

      // Try access token
      const at = await tx.mcpAccessToken.findUnique({
        where: { tokenHash },
        include: { mcpClient: { select: { clientId: true } } },
      });

      if (at && at.mcpClient.clientId === params.clientId) {
        await tx.mcpAccessToken.update({
          where: { id: at.id },
          data: { revokedAt: new Date() },
        });
      }

      // Unknown/already revoked token → silent success per RFC 7009
    }),
  );
}
