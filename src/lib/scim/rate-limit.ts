import { createRateLimiter } from "@/lib/rate-limit";

/**
 * SCIM-specific rate limiter.
 * 200 requests / 60 seconds per scope, keyed by `rl:scim:${scopeId}`.
 * Scope should be tenantId when available, otherwise orgId.
 */
const limiter = createRateLimiter({ windowMs: 60_000, max: 200 });

/** Returns true if allowed, false if rate-limited. */
export function checkScimRateLimit(scopeId: string): Promise<boolean> {
  return limiter.check(`rl:scim:${scopeId}`);
}
