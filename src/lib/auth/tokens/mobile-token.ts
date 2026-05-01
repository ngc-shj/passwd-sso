import type { NextRequest } from "next/server";
import { createHash, randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { generateShareToken, hashToken } from "@/lib/crypto/crypto-server";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { withUserTenantRls } from "@/lib/tenant-context";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import {
  AUDIT_ACTION,
  AUDIT_TARGET_TYPE,
  EXTENSION_TOKEN_MAX_ACTIVE,
} from "@/lib/constants";
import { IOS_TOKEN_DEFAULT_SCOPES } from "@/lib/constants/auth/extension-token";
import {
  verifyDpopProof,
  computeAth,
  DPOP_VERIFY_ERROR,
  type DpopVerifyError,
} from "@/lib/auth/dpop/verify";
import { getJtiCache } from "@/lib/auth/dpop/jti-cache";
import { extractClientIp } from "@/lib/auth/policy/ip-access";
import {
  revokeExtensionTokenFamily,
  parseScopes,
  type ValidatedExtensionToken,
} from "./extension-token";

// ─── iOS-specific TTL constants (NOT tenant-configurable) ───────
//
// Per plan §S13/S25: iOS TTLs are pinned at the code layer to avoid the
// risk of an admin shortening them below what the AutoFill UX requires
// (idle 24h covers a typical user's day; absolute 7d forces re-auth at
// the host app weekly).

export const IOS_TOKEN_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const IOS_TOKEN_ABSOLUTE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;

/** Replay-disambiguation window for legitimate retry-after-network-failure. */
export const REFRESH_REPLAY_GRACE_MS = 5_000;

// ─── Issuance ────────────────────────────────────────────────

export interface IssueIosTokenParams {
  userId: string;
  tenantId: string;
  /** Base64url-encoded SubjectPublicKeyInfo (DER) of the device public key. */
  devicePubkey: string;
  /** SHA-256 thumbprint of the JWK (RFC 7638), base64url. */
  cnfJkt: string;
  /** Present on refresh-rotation; absent on initial exchange. */
  familyId?: string;
  /** Family-creation timestamp; preserved across refresh-rotation. */
  familyCreatedAt?: Date;
  ip?: string | null;
  userAgent?: string | null;
}

export interface IssuedIosToken {
  /** Plaintext access token; returned to the client, never persisted. */
  accessToken: string;
  /** Plaintext refresh token; returned to the client, never persisted. */
  refreshToken: string;
  /** Idle expiry (24h). */
  expiresAt: Date;
  familyId: string;
  familyCreatedAt: Date;
  /** Newly created ExtensionToken row id. */
  tokenId: string;
}

/**
 * Issue an iOS-host-app token row.
 *
 * Caller (the `/api/mobile/token` route) has already validated PKCE,
 * single-use bridge code, and DPoP-at-exchange. This helper just
 * persists the row + returns the plaintext bearer values.
 *
 * Scope is fixed to `IOS_TOKEN_DEFAULT_SCOPES` — there is no per-call
 * scope parameter because the host app holds a single broad token and
 * brokers all AutoFill-extension reads via the shared keychain.
 *
 * Note: the access token and refresh token are stored in DIFFERENT rows
 * sharing the same `familyId`. Refresh-rotation revokes both old rows
 * and creates two new rows in a single transaction.
 */
export async function issueIosToken(
  params: IssueIosTokenParams,
): Promise<IssuedIosToken> {
  const {
    userId,
    tenantId,
    devicePubkey,
    cnfJkt,
    familyId: existingFamilyId,
    familyCreatedAt: existingFamilyCreatedAt,
    ip,
    userAgent,
  } = params;

  const now = new Date();
  const familyId = existingFamilyId ?? randomUUID();
  const familyCreatedAt = existingFamilyCreatedAt ?? now;
  const expiresAt = new Date(now.getTime() + IOS_TOKEN_IDLE_TIMEOUT_MS);
  const familyAbsoluteExpiry = new Date(
    familyCreatedAt.getTime() + IOS_TOKEN_ABSOLUTE_TIMEOUT_MS,
  );
  // Refresh token expires when the family does — there is no separate
  // refresh-token TTL in the iOS flow.
  const scopeCsv = IOS_TOKEN_DEFAULT_SCOPES.join(",");

  const accessPlaintext = generateShareToken();
  const refreshPlaintext = generateShareToken();
  const accessHash = hashToken(accessPlaintext);
  const refreshHash = hashToken(refreshPlaintext);

  const accessRow = await withUserTenantRls(userId, async () =>
    prisma.$transaction(async (tx) => {
      // Enforce per-user active-token cap (covers BROWSER_EXTENSION + IOS_APP
      // rows; an iOS pair counts as 2 active rows). The cap is a defence
      // against issuance abuse — the host app's "one active token per device"
      // expectation is enforced separately by the caller.
      const active = await tx.extensionToken.findMany({
        where: { userId, revokedAt: null, expiresAt: { gt: now } },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
      const over = active.length + 2 - EXTENSION_TOKEN_MAX_ACTIVE;
      if (over > 0) {
        const toRevoke = active.slice(0, over).map((t) => t.id);
        await tx.extensionToken.updateMany({
          where: { id: { in: toRevoke } },
          data: { revokedAt: now },
        });
      }

      const access = await tx.extensionToken.create({
        data: {
          userId,
          tenantId,
          tokenHash: accessHash,
          scope: scopeCsv,
          expiresAt,
          familyId,
          familyCreatedAt,
          clientKind: "IOS_APP",
          devicePubkey,
          cnfJkt,
          lastUsedIp: ip ?? null,
          lastUsedUserAgent: userAgent ?? null,
        },
        select: { id: true, expiresAt: true, familyId: true, familyCreatedAt: true },
      });

      await tx.extensionToken.create({
        data: {
          userId,
          tenantId,
          tokenHash: refreshHash,
          scope: scopeCsv,
          // Refresh token's row expiresAt mirrors family absolute expiry —
          // refresh-rotation will revoke this row anyway, but if the family
          // hits its absolute cap, the row will not validate either.
          expiresAt: familyAbsoluteExpiry,
          familyId,
          familyCreatedAt,
          clientKind: "IOS_APP",
          devicePubkey,
          cnfJkt,
          lastUsedIp: ip ?? null,
          lastUsedUserAgent: userAgent ?? null,
        },
      });

      return access;
    }),
  );

  return {
    accessToken: accessPlaintext,
    refreshToken: refreshPlaintext,
    expiresAt: accessRow.expiresAt,
    familyId: accessRow.familyId,
    familyCreatedAt: accessRow.familyCreatedAt,
    tokenId: accessRow.id,
  };
}

// ─── Validation (DPoP) ──────────────────────────────────────────

export interface IosTokenRow {
  id: string;
  userId: string;
  tenantId: string;
  cnfJkt: string | null;
  scope: string;
  expiresAt: Date;
  familyId: string;
  familyCreatedAt: Date;
}

export interface ValidateIosTokenContext {
  req: NextRequest;
  /** Request method (uppercase). */
  expectedHtm: string;
  /** Canonical URL via `canonicalHtu`. */
  expectedHtu: string;
  /** The plaintext access token used as Bearer (for ath check). */
  accessToken: string;
  /** Loaded ExtensionToken row (already passed revoke / expiry gate). */
  row: IosTokenRow;
  /** Optional override for the DPoP nonce check. `null` disables. */
  expectedNonce?: string | null;
}

export type ValidateIosTokenResult =
  | { ok: true; data: ValidatedExtensionToken }
  | {
      ok: false;
      error: "EXTENSION_TOKEN_INVALID" | "EXTENSION_TOKEN_DPOP_INVALID";
      dpopError?: DpopVerifyError;
    };

/**
 * Validate an iOS-clientKind access token by verifying its DPoP proof.
 *
 * Caller has already loaded the row and confirmed `clientKind === 'IOS_APP'`,
 * `revokedAt === null`, and `expiresAt > now`.
 *
 * On success: best-effort updates `lastUsedIp` and `lastUsedUserAgent`
 * (fire-and-forget; never throws).
 */
export async function validateIosTokenDpop(
  ctx: ValidateIosTokenContext,
): Promise<ValidateIosTokenResult> {
  const { req, expectedHtm, expectedHtu, accessToken, row, expectedNonce } = ctx;

  if (!row.cnfJkt) {
    // Defensive: an IOS_APP row without cnfJkt cannot be DPoP-validated.
    // Treat as invalid rather than crashing.
    return { ok: false, error: "EXTENSION_TOKEN_INVALID" };
  }

  const dpopHeader = req.headers.get("dpop");
  const result = await verifyDpopProof(dpopHeader, {
    expectedHtm,
    expectedHtu,
    expectedAth: computeAth(accessToken),
    expectedCnfJkt: row.cnfJkt,
    expectedNonce: expectedNonce ?? null,
    jtiCache: getJtiCache(),
  });

  if (!result.ok) {
    return {
      ok: false,
      error: "EXTENSION_TOKEN_DPOP_INVALID",
      dpopError: result.error,
    };
  }

  // Best-effort `lastUsedIp` / `lastUsedUserAgent` update. Fire-and-forget.
  const ip = extractClientIp(req);
  const userAgent = req.headers.get("user-agent")?.slice(0, 512) ?? null;
  void withBypassRls(prisma, async () =>
    prisma.extensionToken.update({
      where: { id: row.id },
      data: {
        lastUsedAt: new Date(),
        lastUsedIp: ip,
        lastUsedUserAgent: userAgent,
      },
    }),
  BYPASS_PURPOSE.TOKEN_LIFECYCLE).catch(() => {});

  return {
    ok: true,
    data: {
      tokenId: row.id,
      userId: row.userId,
      tenantId: row.tenantId,
      scopes: parseScopes(row.scope),
      expiresAt: row.expiresAt,
      familyId: row.familyId,
      familyCreatedAt: row.familyCreatedAt,
    },
  };
}

// ─── Refresh + replay disambiguation ───────────────────────────

/**
 * Per-family cache entry for the legitimate retry-after-network-failure case.
 *
 * When a refresh request body's SHA-256 matches a recently issued rotation,
 * within the grace window, return the SAME new token previously issued.
 * Any other use of the now-revoked refresh token escalates to family revoke.
 */
interface RotationRecord {
  /** SHA-256(body bytes), hex. */
  bodyHash: string;
  /** Wall-clock time the rotation was committed. */
  issuedAt: number;
  /** The new token previously issued to the legitimate client. */
  token: IssuedIosToken;
}

const rotationCache = new Map<string, RotationRecord>();
// Hard cap so a misbehaving client looping on refresh cannot grow the
// Map without bound; entries naturally TTL out via REFRESH_REPLAY_GRACE_MS
// in the lazy sweep on each insert. Mirrors `IN_MEMORY_MAX` in jti-cache.
const ROTATION_CACHE_MAX = 10_000;

/** Test-only: clear the in-process rotation cache. */
export function _resetRotationCacheForTests(): void {
  rotationCache.clear();
}

function rotationKey(oldRefreshTokenHash: string): string {
  return `mobile:rot:${oldRefreshTokenHash}`;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface RefreshIosTokenParams {
  req: NextRequest;
  /** Raw POST body bytes — used for byte-identical replay-retry detection. */
  bodyBytes: Uint8Array;
  /**
   * The refresh-token row that authenticated this request. Loaded by the
   * route from the bearer-token hash; passed in so this helper does not
   * have to repeat that lookup.
   */
  oldRow: IosTokenRow & {
    revokedAt: Date | null;
    /** SHA-256 of the plaintext refresh token (used as cache key). */
    tokenHash: string;
    devicePubkey: string | null;
  };
  /** Device public key + thumbprint to thread through to the new row. */
  devicePubkey: string;
  cnfJkt: string;
  /** "now" injection point for tests. */
  now?: () => number;
}

export type RefreshIosTokenResult =
  | { ok: true; replayed?: boolean; token: IssuedIosToken }
  | {
      ok: false;
      error: "REFRESH_TOKEN_FAMILY_EXPIRED" | "REFRESH_REPLAY_DETECTED";
    };

/**
 * Refresh an iOS access+refresh token pair with rotation.
 *
 * Replay handling (per plan §S21):
 *  1. If the refresh row is already revoked AND the body matches a
 *     recently cached rotation within `REFRESH_REPLAY_GRACE_MS`, return
 *     the cached new token (legitimate network-retry case).
 *  2. Any other reuse of a revoked token → revoke the entire family,
 *     emit `MOBILE_TOKEN_REPLAY_DETECTED` with rich metadata, return error.
 *  3. If the family is older than `IOS_TOKEN_ABSOLUTE_TIMEOUT_MS`,
 *     revoke and return `REFRESH_TOKEN_FAMILY_EXPIRED`.
 *  4. Happy path: revoke old pair, issue new pair, emit `MOBILE_TOKEN_REFRESHED`.
 */
export async function refreshIosToken(
  params: RefreshIosTokenParams,
): Promise<RefreshIosTokenResult> {
  const { req, bodyBytes, oldRow, devicePubkey, cnfJkt } = params;
  const now = params.now ? params.now() : Date.now();
  const bodyHash = sha256Hex(bodyBytes);
  const cacheKey = rotationKey(oldRow.tokenHash);

  // ── 1. Replay-vs-retry disambiguation ─────────────────────────
  if (oldRow.revokedAt) {
    const cached = rotationCache.get(cacheKey);
    if (
      cached &&
      now - cached.issuedAt <= REFRESH_REPLAY_GRACE_MS &&
      cached.bodyHash === bodyHash
    ) {
      // Legitimate retry-after-network-failure: return same token, no audit.
      return { ok: true, replayed: true, token: cached.token };
    }

    // Genuine replay: revoke the family + emit forensic audit event.
    await revokeExtensionTokenFamily({
      familyId: oldRow.familyId,
      userId: oldRow.userId,
      tenantId: oldRow.tenantId,
      reason: "replay_detected",
    });
    await emitReplayDetected({
      req,
      oldRow,
      replayKind: "refresh_token_reuse",
      sameDeviceKey: oldRow.devicePubkey === devicePubkey,
    });
    return { ok: false, error: "REFRESH_REPLAY_DETECTED" };
  }

  // ── 2. Family absolute-expiry check ───────────────────────────
  const familyAgeMs = now - oldRow.familyCreatedAt.getTime();
  if (familyAgeMs > IOS_TOKEN_ABSOLUTE_TIMEOUT_MS) {
    await revokeExtensionTokenFamily({
      familyId: oldRow.familyId,
      userId: oldRow.userId,
      tenantId: oldRow.tenantId,
      reason: "family_expired",
    });
    return { ok: false, error: "REFRESH_TOKEN_FAMILY_EXPIRED" };
  }

  // ── 3. Happy path: rotate ─────────────────────────────────────
  // Atomically revoke ALL active rows in the family, then issue a new pair
  // sharing the same familyId / familyCreatedAt.
  const nowDate = new Date(now);
  await withUserTenantRls(oldRow.userId, async () =>
    prisma.extensionToken.updateMany({
      where: { familyId: oldRow.familyId, revokedAt: null },
      data: { revokedAt: nowDate },
    }),
  );

  const issued = await issueIosToken({
    userId: oldRow.userId,
    tenantId: oldRow.tenantId,
    devicePubkey,
    cnfJkt,
    familyId: oldRow.familyId,
    familyCreatedAt: oldRow.familyCreatedAt,
    ip: extractClientIp(req),
    userAgent: req.headers.get("user-agent"),
  });

  // Cache for the legitimate retry-after-network-failure window.
  rotationCache.set(cacheKey, { bodyHash, issuedAt: now, token: issued });
  // Bound the cache: lazily evict expired entries on each insert; if still
  // over the hard cap (e.g. a misbehaving client flooding refresh), drop
  // the entire Map. Worst-case effect: a legitimate retry within the grace
  // window receives a fresh rejection, which is the safe failure mode.
  for (const [k, v] of rotationCache) {
    if (now - v.issuedAt > REFRESH_REPLAY_GRACE_MS) {
      rotationCache.delete(k);
    }
  }
  if (rotationCache.size > ROTATION_CACHE_MAX) {
    rotationCache.clear();
  }

  await logAuditAsync({
    ...personalAuditBase(req, oldRow.userId),
    action: AUDIT_ACTION.MOBILE_TOKEN_REFRESHED,
    tenantId: oldRow.tenantId,
    targetType: AUDIT_TARGET_TYPE.EXTENSION_TOKEN,
    targetId: issued.tokenId,
    metadata: {
      familyId: oldRow.familyId,
      sameDeviceKey: oldRow.devicePubkey === devicePubkey,
    },
  });

  return { ok: true, token: issued };
}

// ─── Replay-detection audit emission ──────────────────────────

export type ReplayKind =
  | "access_token_reuse"
  | "refresh_token_reuse"
  | "dpop_jti_reuse";

interface EmitReplayParams {
  req: NextRequest;
  oldRow: IosTokenRow & { devicePubkey: string | null };
  replayKind: ReplayKind;
  sameDeviceKey: boolean;
  /** Optional clock-skew metric (ms) for SIEM forensics. */
  clockSkewMs?: number;
}

async function emitReplayDetected(params: EmitReplayParams): Promise<void> {
  const { req, oldRow, replayKind, sameDeviceKey, clockSkewMs } = params;
  const fingerprint = oldRow.devicePubkey
    ? createHash("sha256").update(oldRow.devicePubkey).digest("hex").slice(0, 16)
    : null;
  await logAuditAsync({
    ...personalAuditBase(req, oldRow.userId),
    action: AUDIT_ACTION.MOBILE_TOKEN_REPLAY_DETECTED,
    tenantId: oldRow.tenantId,
    targetType: AUDIT_TARGET_TYPE.EXTENSION_TOKEN,
    targetId: oldRow.familyId,
    metadata: {
      familyId: oldRow.familyId,
      devicePubkeyFingerprint: fingerprint,
      replayKind,
      sameDeviceKey,
      ...(typeof clockSkewMs === "number" ? { clockSkewMs } : {}),
    },
  });
}

// Re-export for tests / callers that want to assert on the symbol set.
export { DPOP_VERIFY_ERROR };
