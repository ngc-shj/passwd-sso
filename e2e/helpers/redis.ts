/**
 * Redis-side test helpers — currently focused on rate-limit key resets so
 * tests that fire multiple rate-limited round-trips back-to-back can run
 * within their own clean budget rather than competing with prior tests in
 * the same CI window.
 *
 * Production rate limiters use the same key pattern; tests reset by deleting
 * the key entirely (the limiter then treats the next request as the first
 * in a fresh window). This module is gated on REDIS_URL — calls become
 * no-ops when Redis is unavailable, matching the limiter's own fallback.
 */
import Redis from "ioredis";

/**
 * Delete an arbitrary Redis key. Use the per-route helpers below when the key
 * shape is well-known; this raw form is for one-off / future patterns.
 */
export async function resetRedisKey(key: string): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url) return;
  const r = new Redis(url, { lazyConnect: true });
  try {
    await r.connect();
    await r.del(key);
  } finally {
    r.disconnect();
  }
}

/**
 * Reset the per-user vault-rotation rate-limit key.
 *
 * Production: 15 min / max 3, shared between
 *   GET /api/vault/rotate-key/data
 *   POST /api/vault/rotate-key
 * Tests that fire both routes back-to-back (especially the
 * acknowledge-attachments two-rotation flow) can exhaust the budget within
 * a single test; reset to keep each test's quota independent.
 */
export async function resetRotationRateLimit(userId: string): Promise<void> {
  await resetRedisKey(`rl:vault_rotate:${userId}`);
}

/**
 * Reset the per-user PRF rebootstrap rate-limit keys.
 *
 * Production: 60 sec / max 10, separate keys for
 *   POST /api/webauthn/credentials/[id]/prf/options
 *   POST /api/webauthn/credentials/[id]/prf
 * Reserved for future E2E tests that drive the PRF rebootstrap UI; current
 * tests do not hit it, but the helper is here so the next contributor finds
 * the pattern by searching this file.
 */
export async function resetPrfRebootstrapRateLimits(userId: string): Promise<void> {
  await Promise.all([
    resetRedisKey(`rl:webauthn_prf_rebootstrap:${userId}`),
    resetRedisKey(`rl:webauthn_prf_rebootstrap_opts:${userId}`),
  ]);
}
