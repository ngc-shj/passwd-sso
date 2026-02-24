import { createRateLimiter } from "@/lib/rate-limit";

/**
 * SCIM-specific rate limiter.
 * 200 requests / 60 seconds per org, keyed by `rl:scim:${orgId}`.
 */
const limiter = createRateLimiter({ windowMs: 60_000, max: 200 });

/** Returns true if allowed, false if rate-limited. */
export function checkScimRateLimit(orgId: string): Promise<boolean> {
  return limiter.check(`rl:scim:${orgId}`);
}
