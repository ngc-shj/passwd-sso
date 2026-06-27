import { createRateLimiter, type RateLimitResult } from "@/lib/security/rate-limit";
import { RATE_WINDOW_MS } from "@/lib/validations/common.server";

/**
 * SCIM-specific rate limiter.
 * 200 requests / 60 seconds per scope, keyed by `rl:scim:${scopeId}`.
 * Scope should be tenantId when available, otherwise teamId.
 *
 * fail-closed: SCIM is an admin provisioning/deprovisioning surface; on a Redis
 * outage a per-Pod in-memory fallback would not actually cap the limit across a
 * multi-Pod deployment, so the limiter signals redisErrored and the caller
 * returns 503 instead of failing open.
 */
const limiter = createRateLimiter({
  windowMs: RATE_WINDOW_MS,
  max: 200,
  failClosedOnRedisError: true,
});

/**
 * Returns the full RateLimitResult so the caller can distinguish
 * over-limit (429) from a Redis failure (redisErrored → 503).
 */
export async function checkScimRateLimit(scopeId: string): Promise<RateLimitResult> {
  return limiter.check(`rl:scim:${scopeId}`);
}
