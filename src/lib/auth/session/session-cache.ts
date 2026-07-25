import * as crypto from "node:crypto";
import type Redis from "ioredis";
import { z } from "zod";
import { getMasterKeyByVersion } from "@/lib/crypto/crypto-server";
import {
  REDIS_FALLBACK_LOG_THROTTLE_MS,
  createThrottledErrorLogger,
} from "@/lib/logger/throttled";
import { getRedis } from "@/lib/redis";
import {
  NEGATIVE_CACHE_TTL_MS,
  SESSION_CACHE_KEY_PREFIX,
  SESSION_CACHE_TTL_MS,
  TOMBSTONE_TTL_MS,
} from "@/lib/validations/common.server";
import { MS_PER_SECOND } from "@/lib/constants/time";

// ─── Types ──────────────────────────────────────────────────
export interface SessionInfo {
  valid: boolean;
  userId?: string;
  tenantId?: string;
  hasPasskey?: boolean;
  requirePasskey?: boolean;
  requirePasskeyEnabledAt?: string | null;
  passkeyGracePeriodDays?: number | null;
}

// Positive cache shape. Mutually exclusive with NegativeCacheSchema and
// TombstoneSchema by the presence of `userId` / absence of `tombstone`.
//
// The four passkey fields are REQUIRED (present-but-nullable where the domain
// allows null), NOT optional. getSessionInfo returns a cache hit verbatim
// before the fail-closed bundle substitution runs (that substitution is on the
// cache-MISS fetch path only), so a positive entry missing a passkey field
// would surface as `requirePasskey === undefined` → falsy → enforcement bypass
// at the page-route gate. Requiring the fields makes any partial/legacy/
// type-invalid positive entry fail safeParse → evict-as-poison → treated as a
// miss → the fetch path re-populates a complete, substituted entry. This is the
// read-side counterpart to the bundle substitution in auth-gate; the two
// together close the fail-open gap on both cache-miss and cache-hit paths.
export const SessionInfoSchema = z.object({
  valid: z.literal(true),
  userId: z.string(),
  tenantId: z.string().optional(),
  hasPasskey: z.boolean(),
  requirePasskey: z.boolean(),
  requirePasskeyEnabledAt: z.string().nullable(),
  passkeyGracePeriodDays: z.number().nullable(),
});

// Negative cache: `{ valid: false }` only. Bounded to NEGATIVE_CACHE_TTL_MS
// (5 s) to limit DoS-poisoning blast radius (S-Req-6).
export const NegativeCacheSchema = z.object({
  valid: z.literal(false),
});

// Tombstone marker written by invalidateCachedSession. Distinct shape (no
// `valid` key) so it parses unambiguously and survives populate-after-evict
// races for TOMBSTONE_TTL_MS.
export const TombstoneSchema = z.object({
  tombstone: z.literal(true),
});

export {
  NEGATIVE_CACHE_TTL_MS,
  SESSION_CACHE_KEY_PREFIX,
  SESSION_CACHE_TTL_MS,
  TOMBSTONE_TTL_MS,
};

// ─── HMAC subkey via HKDF (memoized) ────────────────────────
let _sessionCacheHmacKey: Buffer | null = null;

function getSessionCacheHmacKey(): Buffer {
  if (_sessionCacheHmacKey) return _sessionCacheHmacKey;
  // Pin to V1 forever: rotation of V1 itself is an out-of-band op requiring
  // a redis FLUSHDB. Routine bumps of SHARE_MASTER_KEY_CURRENT_VERSION
  // (V1→V2) do not change V1 bytes, so the cache subkey is rotation-stable.
  // hkdfSync returns ArrayBuffer; Buffer.from() wraps it zero-copy.
  const ikm = getMasterKeyByVersion(1);
  const okm = crypto.hkdfSync("sha256", ikm, "", "session-cache-hmac-v1", 32);
  _sessionCacheHmacKey = Buffer.from(okm);
  return _sessionCacheHmacKey;
}

// Test-only reset for vi.resetModules-style tests. NEVER export from any
// index barrel — keep file-local export so production code cannot reach it.
export function _resetSubkeyCacheForTests(): void {
  _sessionCacheHmacKey = null;
}

export function hashSessionToken(token: string): string {
  return crypto
    .createHmac("sha256", getSessionCacheHmacKey())
    .update(token)
    .digest("hex");
}

// ─── Throttled logger (single instance, all ops) ────────────
const logRedisError = createThrottledErrorLogger(
  REDIS_FALLBACK_LOG_THROTTLE_MS,
  "session-cache.redis.fallback",
);

function cacheKey(token: string): string {
  return `${SESSION_CACHE_KEY_PREFIX}${hashSessionToken(token)}`;
}

// H4: the DB now stores the digest (hashSessionToken output), which is exactly
// the value cacheKey() derives from a raw token — so a caller holding a stored
// digest must key the cache by PREFIX+digest DIRECTLY, without re-hashing (that
// would double-hash and silently miss the real cache key). Use this for any
// invalidation driven by a value read from Session.sessionToken.
function cacheKeyFromDigest(digest: string): string {
  return `${SESSION_CACHE_KEY_PREFIX}${digest}`;
}

async function safeDel(redis: Redis, token: string): Promise<void> {
  try {
    await redis.del(cacheKey(token));
  } catch (err) {
    logRedisError((err as { code?: string } | undefined)?.code);
  }
}

// ─── Public API ──────────────────────────────────────────────

export async function getCachedSession(
  token: string,
): Promise<SessionInfo | null> {
  const redis = getRedis();
  if (!redis) return null;

  let raw: string | null;
  try {
    raw = await redis.get(cacheKey(token));
  } catch (err) {
    logRedisError((err as { code?: string } | undefined)?.code);
    return null;
  }
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await safeDel(redis, token);
    return null;
  }

  // ORDER MATTERS (S-12): tombstone must be checked first so we report a
  // miss WITHOUT evicting it. Evicting would re-open the populate-after-
  // invalidate window the tombstone exists to close.
  if (TombstoneSchema.safeParse(parsed).success) return null;

  const negative = NegativeCacheSchema.safeParse(parsed);
  if (negative.success) return { valid: false };

  const positive = SessionInfoSchema.safeParse(parsed);
  if (positive.success) return positive.data;

  // Schema mismatch on a non-tombstone, non-negative shape — evict the poison.
  await safeDel(redis, token);
  return null;
}

export async function setCachedSession(
  token: string,
  info: SessionInfo,
  ttlMs: number,
): Promise<void> {
  const redis = getRedis();
  if (!redis) return;

  // Sub-1 s TTL on a positive entry → skip entirely (S-Req-5).
  // Checked before cacheKey() so a no-cache path costs zero HMAC.
  if (info.valid && info.userId && ttlMs < MS_PER_SECOND) return;

  // cacheKey() throws if the KeyProvider has not yet warmed share-master
  // (S-5 / S-11 cold-start). Catch here so the call never propagates.
  try {
    const key = cacheKey(token);

    if (!info.valid || !info.userId) {
      // Negative cache: short fixed TTL, asymmetric to positive ceiling.
      await redis.set(
        key,
        JSON.stringify({ valid: false }),
        "PX",
        NEGATIVE_CACHE_TTL_MS,
        "NX",
      );
      return;
    }

    const clamped = Math.min(ttlMs, SESSION_CACHE_TTL_MS);
    await redis.set(key, JSON.stringify(info), "PX", clamped, "NX");
  } catch (err) {
    logRedisError((err as { code?: string } | undefined)?.code);
  }
}

/**
 * Tombstone-write a single session. Returns `true` when the tombstone is
 * either written or unnecessary (Redis not configured); returns `false`
 * ONLY when Redis was reachable-by-config but the SET call errored.
 *
 * Callers in security-sensitive flows (vault reset, member removal) MUST
 * propagate the `false` return into audit metadata so that a silent Redis
 * outage during an invalidation flow is forensically visible — the throttled
 * logger alone is insufficient for incident reconstruction.
 */
export async function invalidateCachedSession(token: string): Promise<boolean> {
  // keyFn deferred so a sync throw from cacheKey()/hashSessionToken()
  // (KeyProvider cold-start) is contained as a tombstone-write failure.
  return tombstoneByKey(() => cacheKey(token));
}

/**
 * H4 digest-native tombstone. Input is a stored digest (Session.sessionToken),
 * NOT a raw cookie token — keyed directly via cacheKeyFromDigest (no re-hash).
 */
export async function invalidateCachedSessionByDigest(
  digest: string,
): Promise<boolean> {
  return tombstoneByKey(() => cacheKeyFromDigest(digest));
}

async function tombstoneByKey(keyFn: () => string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return true;
  try {
    await redis.set(
      keyFn(),
      JSON.stringify({ tombstone: true }),
      "PX",
      TOMBSTONE_TTL_MS,
    );
    return true;
  } catch (err) {
    logRedisError((err as { code?: string } | undefined)?.code);
    return false;
  }
}

/**
 * Bulk tombstone-write via Redis pipeline (single round-trip).
 *
 * Used by tenant policy change (PATCH /api/tenant/policy) to invalidate
 * thousands of sessions for an enterprise tenant in one network hop —
 * required so the route latency stays bounded (S-13). Behaviorally
 * equivalent to calling invalidateCachedSession on each token, but
 * with constant network cost.
 *
 * Returns `{ total, failed }`. `total` is the input length. `failed` is
 * the number of tokens whose tombstone write did not land — currently
 * either 0 (success / no-Redis) or `total` (pipeline.exec threw),
 * because pipeline failure is all-or-nothing at the network layer.
 */
export async function invalidateCachedSessionsBulk(
  tokens: ReadonlyArray<string>,
): Promise<{ total: number; failed: number }> {
  return tombstoneBulkByKeys(tokens.map(cacheKey));
}

/**
 * H4 digest-native bulk tombstone. Inputs are stored digests
 * (Session.sessionToken), keyed directly (no re-hash).
 */
export async function invalidateCachedSessionsBulkByDigest(
  digests: ReadonlyArray<string>,
): Promise<{ total: number; failed: number }> {
  return tombstoneBulkByKeys(digests.map(cacheKeyFromDigest));
}

async function tombstoneBulkByKeys(
  keys: ReadonlyArray<string>,
): Promise<{ total: number; failed: number }> {
  if (keys.length === 0) return { total: 0, failed: 0 };
  const redis = getRedis();
  if (!redis) return { total: keys.length, failed: 0 };
  const pipeline = redis.pipeline();
  for (const key of keys) {
    pipeline.set(key, JSON.stringify({ tombstone: true }), "PX", TOMBSTONE_TTL_MS);
  }
  try {
    await pipeline.exec();
    return { total: keys.length, failed: 0 };
  } catch (err) {
    logRedisError((err as { code?: string } | undefined)?.code);
    return { total: keys.length, failed: keys.length };
  }
}
