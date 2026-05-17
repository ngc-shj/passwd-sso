/**
 * Shared `extractClientIp + rateLimiter.check` glue.
 *
 * The pattern was repeated across 10 route handlers and the original
 * implementations collapsed all IP-less requests into a single bucket
 * keyed by the literal string `"unknown"` — a documented DoS-on-others
 * vector (one bad actor at any IP without a usable IP-source consumed
 * the shared quota for every legitimate IP-less request fleet-wide).
 *
 * This helper applies the same fail-open + structured-warn decision used
 * by the OAuth callback rate limit at
 * `src/app/api/auth/[...nextauth]/route.ts:withCallbackRateLimit`:
 *   - When the client IP is null, skip the limiter and emit a warn so
 *     operators detect proxy misconfiguration (TRUST_PROXY_HEADERS
 *     unset behind a proxy is the common cause).
 *   - When the client IP is present, key per-IP via
 *     `rateLimitKeyFromIp` (IPv6 → /64 normalization).
 *
 * Returns `RateLimitResult` (including the optional `redisErrored` field
 * propagated from `failClosedOnRedisError: true` limiters) so opt-in
 * call sites can branch on the fail-closed signal at the route handler.
 */

import { getLogger } from "@/lib/logger";
import { rateLimitKeyFromIp } from "@/lib/auth/policy/ip-access";
import type { RateLimiter, RateLimitResult } from "@/lib/security/rate-limit";

// Subset of RateLimiter the wrapper actually needs. Pulled from the canonical
// type so the result-shape (including the optional `redisErrored` flag) stays
// in lockstep automatically — no parallel inline interface to drift.
type RateLimitProbe = Pick<RateLimiter, "check">;

interface CheckIpRateLimitArgs {
  /** Result of extractClientIp / extractClientIpFromHeaders — null when the IP cannot be determined. */
  ip: string | null;
  /** Used in the warn log for operator-visible context. */
  pathname: string;
  /** Inserted into the rate-key as `rl:<scope>:<ip>`. Must be short, lower-snake_case. */
  scope: string;
  /** A rate-limiter from `createRateLimiter`. */
  limiter: RateLimitProbe;
  /**
   * Optional extra-key segment appended after the IP, e.g. a per-resource
   * hash to bound the limiter by (ip, resource) instead of (ip) alone.
   * Final key shape: `rl:<scope>:<ip>:<keySuffix>`.
   */
  keySuffix?: string;
}

export async function checkIpRateLimit(
  args: CheckIpRateLimitArgs,
): Promise<RateLimitResult> {
  if (args.ip == null) {
    getLogger().warn(
      { pathname: args.pathname, scope: args.scope },
      "rate_limit_skipped_unknown_ip",
    );
    return { allowed: true };
  }
  const ipPart = rateLimitKeyFromIp(args.ip);
  const tail = args.keySuffix != null ? `:${args.keySuffix}` : "";
  return args.limiter.check(`rl:${args.scope}:${ipPart}${tail}`);
}
