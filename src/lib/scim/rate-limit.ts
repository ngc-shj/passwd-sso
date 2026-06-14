import { createRateLimiter } from "@/lib/security/rate-limit";
import { RATE_WINDOW_MS } from "@/lib/validations/common.server";

/**
 * SCIM-specific rate limiter.
 * 200 requests / 60 seconds per scope, keyed by `rl:scim:${scopeId}`.
 * Scope should be tenantId when available, otherwise teamId.
 */
const limiter = createRateLimiter({ windowMs: RATE_WINDOW_MS, max: 200 });

/** Returns true if allowed, false if rate-limited. */
export async function checkScimRateLimit(scopeId: string): Promise<boolean> {
  const { allowed } = await limiter.check(`rl:scim:${scopeId}`);
  return allowed;
}
