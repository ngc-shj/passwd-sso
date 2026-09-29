import type { NextRequest } from "next/server";
import { createHash, randomUUID } from "node:crypto";
import { EXTENSION_TOKEN_LAST_USED_IP_MAX_LENGTH } from "@/lib/validations/common.server";
import { prisma } from "@/lib/prisma";
import { generateShareToken, hashToken } from "@/lib/crypto/crypto-server";
import { withBypassRls, BYPASS_PURPOSE, advisoryXactLock } from "@/lib/tenant-rls";
import { withUserTenantRls } from "@/lib/tenant-context";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import {
  IOS_TOKEN_DEFAULT_SCOPES,
  EXTENSION_TOKEN_SCOPE,
} from "@/lib/constants/auth/extension-token";
import { MS_PER_DAY, MS_PER_MINUTE, MS_PER_SECOND } from "@/lib/constants/time";
import {
  verifyDpopProof,
  computeAth,
  DPOP_VERIFY_ERROR,
  type DpopVerifyError,
} from "@/lib/auth/dpop/verify";
import { getJtiCache } from "@/lib/auth/dpop/jti-cache";
import { extractClientIp } from "@/lib/auth/policy/ip-access";
import {
  derivePasskeyState,
  passkeyEnforcementBlocks,
} from "@/lib/auth/policy/passkey-enforcement";
import {
  revokeExtensionTokenFamily,
  enforceActiveFamilyCap,
  emitRevokedFamilyAudits,
  type RevokedFamily,
  EXTENSION_TOKEN_REVOKE_REASON,
  parseScopes,
  type ValidatedExtensionToken,
} from "./extension-token";
import { computeClientTokenExpiry, getFamilyPresenceAt } from "./client-token-expiry";
import {
  EXTENSION_TOKEN_IDLE_TIMEOUT_DEFAULT,
  EXTENSION_TOKEN_ABSOLUTE_TIMEOUT_DEFAULT,
} from "@/lib/validations/common";

// ─── iOS-specific TTL constants ──────────────────────────────────
//
// C8: idle/absolute are the same tenant-configurable
// `extensionTokenIdleTimeoutMinutes` / `extensionTokenAbsoluteTimeoutMinutes`
// fields the browser extension uses (D2) — the caller reads them from the
// tenant row and passes them into `issueIosToken` / `refreshIosToken`'s
// tenant-policy read. Only the access-token TTL stays a fixed code-layer
// constant: it is a ceiling on how long a single access-token row lives
// between rotations, not a security boundary on its own (the family's
// presence/absolute caps — C3 — are the actual boundary).

export const IOS_ACCESS_TOKEN_TTL_MS = MS_PER_DAY;

/**
 * TTL for the single-purpose AutoFill upload token (passkey registration).
 * Deliberately short: it exists only to cover the seconds-long registration
 * ceremony. Not refreshable; a fresh one is minted by the host on each unlock.
 */
export const IOS_AUTOFILL_TOKEN_TTL_MS = 5 * MS_PER_MINUTE;

/** Replay-disambiguation window for legitimate retry-after-network-failure. */
export const REFRESH_REPLAY_GRACE_MS = 5 * MS_PER_SECOND;

// ─── Issuance ────────────────────────────────────────────────

export interface IssueIosTokenParams {
  userId: string;
  tenantId: string;
  /**
   * RFC 7638 JWK thumbprint (P-256, base64url, 43 chars). Bound to the proof
   * via DPoP's `cnf.jkt` and to the row's `cnf_jkt` column. Replaces the
   * former `devicePubkey` (base64url SPKI-DER) which was structurally
   * incompatible with the DPoP verifier's JWK-thumbprint output.
   */
  deviceJkt: string;
  /** SHA-256 thumbprint of the JWK (RFC 7638), base64url. */
  cnfJkt: string;
  /** Present on refresh-rotation; absent on initial exchange. */
  familyId?: string;
  /** Family-creation timestamp; preserved across refresh-rotation. */
  familyCreatedAt?: Date;
  /**
   * Tenant's `extensionTokenIdleTimeoutMinutes` / `extensionTokenAbsoluteTimeoutMinutes`
   * (C8) — this helper does not read the tenant row itself; the caller
   * (`/api/mobile/token` for initial issuance, `refreshIosToken` for
   * rotation) does, so both share one fail-closed tenant lookup site each.
   */
  idleMinutes: number;
  absoluteMinutes: number;
  /**
   * Presence timestamp powering C3/C4's caps: `now` for a brand-new family
   * (the bridge-code exchange itself counts as presence, mirroring
   * `issueExtensionToken`), or the family's MAX(lastPresenceAt) (C4) on
   * refresh-rotation.
   */
  presenceAt: Date;
  ip?: string | null;
  userAgent?: string | null;
}

export interface IssuedIosToken {
  /** Plaintext access token; returned to the client, never persisted. */
  accessToken: string;
  /** Plaintext refresh token; returned to the client, never persisted. */
  refreshToken: string;
  /** Access-token expiry: min(now + IOS_ACCESS_TOKEN_TTL_MS, C3-capped refresh-row expiry). */
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
 *
 * Active-family cap (C3): when `familyId` is NOT supplied (a brand-new
 * family), `enforceActiveFamilyCap` supersedes any active family from the
 * same device (same `cnfJkt`) and, if the user is still at
 * `CLIENT_TOKEN_MAX_ACTIVE_FAMILIES`, evicts the family with the oldest
 * presence. When `familyId` IS supplied (refresh-rotation), neither runs —
 * a refresh never evicts another family.
 */
export async function issueIosToken(
  params: IssueIosTokenParams,
): Promise<IssuedIosToken> {
  const {
    userId,
    tenantId,
    deviceJkt,
    cnfJkt,
    familyId: existingFamilyId,
    familyCreatedAt: existingFamilyCreatedAt,
    idleMinutes,
    absoluteMinutes,
    presenceAt,
    ip,
    userAgent,
  } = params;
  // The legacy `devicePubkey` column is retained as nullable but we no longer
  // populate it for new iOS rows — `cnfJkt` is the single source of truth for
  // the device-key binding. Refresh-time "sameDeviceKey" forensics compare
  // cnfJkt across rotations instead.
  void deviceJkt; // expose the binding via cnfJkt below; retained in params API for clarity

  const now = new Date();
  const familyId = existingFamilyId ?? randomUUID();
  const familyCreatedAt = existingFamilyCreatedAt ?? now;
  // C3: the refresh row's own expiry IS the tenant idle/absolute/presence cap.
  const refreshExpiresAt = computeClientTokenExpiry({
    now,
    presenceAt,
    familyCreatedAt,
    idleMinutes,
    absoluteMinutes,
  });
  // The access token is additionally capped at IOS_ACCESS_TOKEN_TTL_MS (24h) —
  // it must never outlive the refresh row that will eventually rotate it.
  const expiresAt = new Date(
    Math.min(now.getTime() + IOS_ACCESS_TOKEN_TTL_MS, refreshExpiresAt.getTime()),
  );
  const scopeCsv = IOS_TOKEN_DEFAULT_SCOPES.join(",");

  const accessPlaintext = generateShareToken();
  const refreshPlaintext = generateShareToken();
  const accessHash = hashToken(accessPlaintext);
  const refreshHash = hashToken(refreshPlaintext);

  // Cap enforcement runs only for a brand-new family (bridge-code exchange,
  // no existingFamilyId). Refresh-rotation (existingFamilyId supplied) skips
  // supersede + cap entirely — a refresh must never evict another family.
  // Instead it revokes its own family's rows and creates the new pair in the
  // same locked transaction: were the revoke committed separately, a
  // concurrent new-family issuance could run the cap while this family has
  // no active row, miss it, and leave the user one family over the cap.
  const isNewFamily = !existingFamilyId;

  const created = await withUserTenantRls(userId, async () =>
    prisma.$transaction(async (tx) => {
      // Serialize concurrent token issuance for this user (count-then-evict-then-create cap race).
      await advisoryXactLock(tx, userId);
      let revokedFamilies: RevokedFamily[] = [];
      if (isNewFamily) {
        revokedFamilies = await enforceActiveFamilyCap(tx, {
          userId,
          clientKind: "IOS_APP",
          cnfJkt,
          now,
        });
      } else {
        await tx.extensionToken.updateMany({
          where: { familyId, userId, revokedAt: null },
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
          // devicePubkey: omitted — cnfJkt is the device-binding SoT.
          cnfJkt,
          lastPresenceAt: presenceAt,
          lastUsedIp: ip?.slice(0, EXTENSION_TOKEN_LAST_USED_IP_MAX_LENGTH) ?? null,
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
          // Refresh token's row expiresAt IS the C3 cap (tenant
          // idle/absolute + presence) — refresh-rotation will revoke this
          // row anyway, but if the family hits its cap first, the row will
          // not validate either.
          expiresAt: refreshExpiresAt,
          familyId,
          familyCreatedAt,
          clientKind: "IOS_APP",
          // devicePubkey: omitted — cnfJkt is the device-binding SoT.
          cnfJkt,
          lastPresenceAt: presenceAt,
          lastUsedIp: ip?.slice(0, EXTENSION_TOKEN_LAST_USED_IP_MAX_LENGTH) ?? null,
          lastUsedUserAgent: userAgent ?? null,
        },
      });

      return { access, revokedFamilies };
    }),
  );

  await emitRevokedFamilyAudits(created.revokedFamilies, { userId, tenantId });

  return {
    accessToken: accessPlaintext,
    refreshToken: refreshPlaintext,
    expiresAt: created.access.expiresAt,
    familyId: created.access.familyId,
    familyCreatedAt: created.access.familyCreatedAt,
    tokenId: created.access.id,
  };
}

// ─── AutoFill upload token (passkey registration) ──────────────

export interface IssueAutofillTokenParams {
  userId: string;
  tenantId: string;
  /**
   * RFC 7638 JWK thumbprint of the AutoFill EXTENSION's own DPoP key (NOT the
   * host's). The minted token's DPoP `cnf.jkt` binds to this so only the
   * extension (which holds the matching SE key in the shared Keychain group)
   * can present the token.
   */
  cnfJkt: string;
}

export interface IssuedAutofillToken {
  /** Plaintext bearer token; returned once, never persisted. */
  token: string;
  expiresAt: Date;
  cnfJkt: string;
  /** CSV scope ("passwords:write"). */
  scope: string;
}

/**
 * Mint a short-lived, `passwords:write`-only, DPoP-bound token for the iOS
 * AutoFill extension's passkey-registration upload. Validated by the SAME
 * `validateExtensionToken` DPoP path as the other client kinds (no special
 * branch); `POST /api/passwords` accepts it via the shared scope check.
 *
 * Only one active AutoFill token per user — any prior one is revoked first.
 * IOS_AUTOFILL rows are excluded from `enforceActiveFamilyCap`'s count
 * entirely (C3), so minting never evicts the host's own IOS_APP families.
 */
export async function issueAutofillToken(
  params: IssueAutofillTokenParams,
): Promise<IssuedAutofillToken> {
  const { userId, tenantId, cnfJkt } = params;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + IOS_AUTOFILL_TOKEN_TTL_MS);
  const scopeCsv = EXTENSION_TOKEN_SCOPE.PASSWORDS_WRITE;

  const plaintext = generateShareToken();
  const tokenHash = hashToken(plaintext);

  await withUserTenantRls(userId, async () =>
    prisma.$transaction(async (tx) => {
      // Serialize concurrent AutoFill mints for this user: without the lock two
      // mints each revoke the (same) priors and both create, leaving two
      // active AutoFill tokens.
      await advisoryXactLock(tx, userId);
      // Single active AutoFill token per user (short-lived, single-purpose).
      // IOS_AUTOFILL is outside the active-family cap, so this never evicts
      // the host's IOS_APP family.
      await tx.extensionToken.updateMany({
        where: { userId, clientKind: "IOS_AUTOFILL", revokedAt: null },
        data: { revokedAt: now },
      });
      await tx.extensionToken.create({
        data: {
          userId,
          tenantId,
          tokenHash,
          scope: scopeCsv,
          expiresAt,
          familyId: randomUUID(),
          familyCreatedAt: now,
          clientKind: "IOS_AUTOFILL",
          cnfJkt,
        },
      });
    }),
  );

  return { token: plaintext, expiresAt, cnfJkt, scope: scopeCsv };
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
 * iOS-specific variant of DPoP validation. Distinct from the shared
 * `validateExtensionTokenDpop` because the iOS caller (mobile/token route)
 * derives `expectedHtm`/`expectedHtu` explicitly from the route signature
 * (not from req.url). The shared helper at
 * `src/lib/auth/dpop/validate-token-dpop.ts` is used by `validateExtensionToken`'s
 * dispatch for BOTH iOS_APP and BROWSER_EXTENSION rows — that path is the
 * preferred consumer. Future refactor: extend the shared helper to accept
 * optional expectedHtm/Htu overrides, enabling a re-export here.
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

  const cnfJkt = row.cnfJkt;
  if (!cnfJkt) {
    // Defensive: an IOS_APP row without cnfJkt cannot be DPoP-validated.
    // Treat as invalid rather than crashing.
    return { ok: false, error: "EXTENSION_TOKEN_INVALID" };
  }

  const dpopHeader = req.headers.get("dpop");
  const result = await verifyDpopProof(dpopHeader, {
    expectedHtm,
    expectedHtu,
    expectedAth: computeAth(accessToken),
    expectedCnfJkt: cnfJkt,
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
  void withBypassRls(prisma, async (tx) =>
    tx.extensionToken.update({
      where: { id: row.id },
      data: {
        lastUsedAt: new Date(),
        lastUsedIp: ip?.slice(0, EXTENSION_TOKEN_LAST_USED_IP_MAX_LENGTH) ?? null,
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
      // cnfJkt is guaranteed non-null here: null guard above returned early.
      cnfJkt,
      // This validator is the IOS_APP-only DPoP path (the IOS_AUTOFILL kind is
      // validated via validateExtensionTokenDpop, not here).
      clientKind: "IOS_APP",
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
  };
  /** RFC 7638 JWK thumbprint of the device key, threaded into the new row. */
  deviceJkt: string;
  cnfJkt: string;
  /** "now" injection point for tests. */
  now?: () => number;
}

export type RefreshIosTokenResult =
  | { ok: true; replayed?: boolean; token: IssuedIosToken }
  | {
      ok: false;
      error: "REFRESH_TOKEN_FAMILY_EXPIRED" | "REFRESH_REPLAY_DETECTED" | "PASSKEY_REQUIRED";
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
 *  3. If the family is older than the tenant's absolute timeout (C8),
 *     revoke and return `REFRESH_TOKEN_FAMILY_EXPIRED`.
 *  4. C4: if the family's presence (MAX(lastPresenceAt)) is older than the
 *     tenant's idle timeout, revoke (reason `presence_expired`) and return
 *     the same `REFRESH_TOKEN_FAMILY_EXPIRED` — refresh activity alone does
 *     not keep a family alive; only a server-verified vault unlock does.
 *  5. Happy path: revoke old pair, issue new pair, emit `MOBILE_TOKEN_REFRESHED`.
 */
export async function refreshIosToken(
  params: RefreshIosTokenParams,
): Promise<RefreshIosTokenResult> {
  const { req, bodyBytes, oldRow, deviceJkt, cnfJkt } = params;
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
      reason: EXTENSION_TOKEN_REVOKE_REASON.REPLAY_DETECTED,
    });
    await emitReplayDetected({
      req,
      oldRow,
      replayKind: "refresh_token_reuse",
      sameDeviceKey: oldRow.cnfJkt === cnfJkt,
    });
    return { ok: false, error: "REFRESH_REPLAY_DETECTED" };
  }

  // Read tenant extension-token TTL policy (C8: iOS shares the browser
  // extension's tenant-configurable idle/absolute fields — D2). FAIL-CLOSED:
  // tenantId is FK-backed, so a vanished tenant row is data corruption, not
  // "no policy" (mirrors `issueExtensionToken` / the extension's own refresh
  // route) — refuse rather than default to a potentially longer TTL.
  const tenant = await withBypassRls(prisma, async (tx) =>
    tx.tenant.findUnique({
      where: { id: oldRow.tenantId },
      select: {
        extensionTokenIdleTimeoutMinutes: true,
        extensionTokenAbsoluteTimeoutMinutes: true,
      },
    }),
  BYPASS_PURPOSE.TOKEN_LIFECYCLE);
  if (!tenant) {
    throw new Error(`refreshIosToken: tenant ${oldRow.tenantId} not found`);
  }
  const idleMinutes =
    tenant.extensionTokenIdleTimeoutMinutes ?? EXTENSION_TOKEN_IDLE_TIMEOUT_DEFAULT;
  const absoluteMinutes =
    tenant.extensionTokenAbsoluteTimeoutMinutes ?? EXTENSION_TOKEN_ABSOLUTE_TIMEOUT_DEFAULT;

  // ── 2. Family absolute-expiry check (tenant-driven, C8) ────────
  const familyAgeMs = now - oldRow.familyCreatedAt.getTime();
  if (familyAgeMs > absoluteMinutes * MS_PER_MINUTE) {
    await revokeExtensionTokenFamily({
      familyId: oldRow.familyId,
      userId: oldRow.userId,
      tenantId: oldRow.tenantId,
      reason: EXTENSION_TOKEN_REVOKE_REASON.FAMILY_EXPIRED,
    });
    return { ok: false, error: "REFRESH_TOKEN_FAMILY_EXPIRED" };
  }

  // ── 2a. C4 presence gate: idle is "time since the last server-verified
  // vault unlock", not refresh activity — a token that keeps refreshing
  // itself without ever proving the passphrase again must still die `idle`
  // after the last real unlock (mirrors the extension's own refresh route).
  const presenceAt = await withBypassRls(prisma, async (tx) =>
    getFamilyPresenceAt(tx, oldRow.familyId, oldRow.familyCreatedAt),
  BYPASS_PURPOSE.TOKEN_LIFECYCLE);
  if (presenceAt.getTime() + idleMinutes * MS_PER_MINUTE <= now) {
    await revokeExtensionTokenFamily({
      familyId: oldRow.familyId,
      userId: oldRow.userId,
      tenantId: oldRow.tenantId,
      reason: EXTENSION_TOKEN_REVOKE_REASON.PRESENCE_EXPIRED,
    });
    return { ok: false, error: "REFRESH_TOKEN_FAMILY_EXPIRED" };
  }

  // ── 2b. Passkey enforcement at the MINT point ─────────────────
  // AFTER replay-vs-retry + family-expiry (so a replayed/revoked token still
  // triggers family revocation above, never short-circuited by this gate),
  // BEFORE rotating. Fail-closed: derivePasskeyState throws on DB error.
  const pk = await derivePasskeyState({ userId: oldRow.userId, tenantId: oldRow.tenantId });
  if (passkeyEnforcementBlocks(pk)) {
    return { ok: false, error: "PASSKEY_REQUIRED" };
  }

  // ── 3. Happy path: rotate ─────────────────────────────────────
  // issueIosToken revokes ALL active rows in the family and issues a new pair
  // sharing the same familyId / familyCreatedAt, in one locked transaction.
  const issued = await issueIosToken({
    userId: oldRow.userId,
    tenantId: oldRow.tenantId,
    deviceJkt,
    cnfJkt,
    familyId: oldRow.familyId,
    familyCreatedAt: oldRow.familyCreatedAt,
    idleMinutes,
    absoluteMinutes,
    // Carry the family's presence max forward (C4) — the new row's own
    // future presence writes only ever raise it.
    presenceAt,
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
      sameDeviceKey: oldRow.cnfJkt === cnfJkt,
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
  oldRow: IosTokenRow;
  replayKind: ReplayKind;
  sameDeviceKey: boolean;
  /** Optional clock-skew metric (ms) for SIEM forensics. */
  clockSkewMs?: number;
}

async function emitReplayDetected(params: EmitReplayParams): Promise<void> {
  const { req, oldRow, replayKind, sameDeviceKey, clockSkewMs } = params;
  // First 16 hex chars of SHA-256(cnfJkt) — opaque-enough for SIEM
  // forensics without exposing the full jkt in audit metadata.
  const fingerprint = oldRow.cnfJkt
    ? createHash("sha256").update(oldRow.cnfJkt).digest("hex").slice(0, 16)
    : null;
  await logAuditAsync({
    ...personalAuditBase(req, oldRow.userId),
    action: AUDIT_ACTION.MOBILE_TOKEN_REPLAY_DETECTED,
    tenantId: oldRow.tenantId,
    targetType: AUDIT_TARGET_TYPE.EXTENSION_TOKEN,
    targetId: oldRow.familyId,
    metadata: {
      familyId: oldRow.familyId,
      deviceJktFingerprint: fingerprint,
      replayKind,
      sameDeviceKey,
      ...(typeof clockSkewMs === "number" ? { clockSkewMs } : {}),
    },
  });
}

// Re-export for tests / callers that want to assert on the symbol set.
export { DPOP_VERIFY_ERROR };
