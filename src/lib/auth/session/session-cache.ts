import * as crypto from "node:crypto";
import type Redis from "ioredis";
import { z } from "zod";
import { getMasterKeyByVersion } from "@/lib/crypto/crypto-server";
import { createThrottledErrorLogger } from "@/lib/logger/throttled";
import { getRedis } from "@/lib/redis";
import {
  NEGATIVE_CACHE_TTL_MS,
  SESSION_CACHE_KEY_PREFIX,
  SESSION_CACHE_TTL_MS,
  TOMBSTONE_TTL_MS,
} from "@/lib/validations/common.server";

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
export const SessionInfoSchema = z.object({
  valid: z.literal(true),
  userId: z.string(),
  tenantId: z.string().optional(),
  hasPasskey: z.boolean().optional(),
  requirePasskey: z.boolean().optional(),
  requirePasskeyEnabledAt: z.string().nullable().optional(),
  passkeyGracePeriodDays: z.number().nullable().optional(),
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
  30_000,
  "session-cache.redis.fallback",
);

function cacheKey(token: string): string {
  return `${SESSION_CACHE_KEY_PREFIX}${hashSessionToken(token)}`;
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
  if (info.valid && info.userId && ttlMs < 1000) return;

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
  const redis = getRedis();
  if (!redis) return true;
  try {
    await redis.set(
      cacheKey(token),
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
  if (tokens.length === 0) return { total: 0, failed: 0 };
  const redis = getRedis();
  if (!redis) return { total: tokens.length, failed: 0 };
  const pipeline = redis.pipeline();
  for (const token of tokens) {
    pipeline.set(
      cacheKey(token),
      JSON.stringify({ tombstone: true }),
      "PX",
      TOMBSTONE_TTL_MS,
    );
  }
  try {
    await pipeline.exec();
    return { total: tokens.length, failed: 0 };
  } catch (err) {
    logRedisError((err as { code?: string } | undefined)?.code);
    return { total: tokens.length, failed: tokens.length };
  }
}
