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
 * propagated from limiters with the fail-closed opt-in flag set) so
 * opt-in call sites can branch on the fail-closed signal at the route handler.
 */

import { getLogger } from "@/lib/logger";
import { rateLimitKeyFromIp } from "@/lib/auth/policy/ip-access";
import {
  createRateLimiter,
  type RateLimiter,
  type RateLimitResult,
} from "@/lib/security/rate-limit";
import { MS_PER_MINUTE } from "@/lib/constants/time";

/**
 * Standard shared budget for the unknown-IP bucket (M2). Deliberately small:
 * this ONE bucket backs every IP-less request in a scope, so the number is the
 * whole-scope ceiling for IP-less traffic, not a per-client allowance. Kept well
 * below any single per-IP limit (those are 10–60/min) so an IP-spoofing or
 * proxy-misconfig fleet is capped hard, while a genuinely misconfigured
 * single-instance deploy still degrades to a usable trickle rather than a hard
 * outage. Callers that need a different budget can build their own limiter.
 */
const UNKNOWN_IP_BUDGET_MAX = 30;

/**
 * Shared limiter for the unknown-IP bucket, passed as `unknownIpLimiter` to
 * `checkIpRateLimit` for high-risk scopes. A single instance is safe across all
 * scopes: `checkIpRateLimit` keys as `rl:<scope>:unknown-ip`, so each scope gets
 * its own budget even though they share this limiter object (and its in-memory
 * fallback map).
 *
 * Lazily constructed on first use, NOT at module load: eagerly calling
 * `createRateLimiter` here would register an extra factory call that route tests
 * mocking `createRateLimiter` attribute by call index (`results[0]`), shifting
 * their assertions. `getUnknownIpLimiter()` defers the single construction until
 * a request actually hits an IP-less path.
 */
let unknownIpLimiterSingleton: RateLimiter | null = null;

export function getUnknownIpLimiter(): RateLimiter {
  if (unknownIpLimiterSingleton == null) {
    unknownIpLimiterSingleton = createRateLimiter({
      windowMs: MS_PER_MINUTE,
      max: UNKNOWN_IP_BUDGET_MAX,
    });
  }
  return unknownIpLimiterSingleton;
}

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
  /**
   * High-risk opt-in (M2). Default (false/unset): when the client IP cannot be
   * determined the request is allowed through with a warn (fail-open — the
   * historical behavior, acceptable for low-risk scopes whose token/user limits
   * carry the load). Set true for pre-auth / public high-risk endpoints (OAuth
   * callback, magic link, passkey, extension bridge, public share access): an
   * IP-less request is then routed through ONE shared bounded bucket
   * (`rl:<scope>:unknown-ip`, via `getUnknownIpLimiter()`), so a
   * misconfigured-proxy or IP-spoofing fleet cannot make unlimited attempts.
   * The shared budget is deliberately tiny — NOT the generous per-IP limit — so
   * the "DoS-on-others" cost of collapsing IP-less traffic into one bucket is
   * capped. Callers needing a custom budget can pass `unknownIpLimiter` instead.
   */
  boundUnknownIp?: boolean;
  /**
   * Advanced override for `boundUnknownIp`: supply a specific limiter for the
   * unknown-IP bucket instead of the shared default. Mainly a test seam; when
   * set it takes precedence over `boundUnknownIp`.
   */
  unknownIpLimiter?: RateLimitProbe;
}

// Fixed key segment for the shared unknown-IP bucket. Not an IP, so it can never
// collide with a real `rateLimitKeyFromIp` output (those are IP/CIDR strings).
const UNKNOWN_IP_KEY = "unknown-ip";

export async function checkIpRateLimit(
  args: CheckIpRateLimitArgs,
): Promise<RateLimitResult> {
  if (args.ip == null) {
    getLogger().warn(
      { pathname: args.pathname, scope: args.scope },
      "rate_limit_skipped_unknown_ip",
    );
    const unknownLimiter =
      args.unknownIpLimiter ?? (args.boundUnknownIp ? getUnknownIpLimiter() : null);
    if (unknownLimiter == null) {
      return { allowed: true };
    }
    // High-risk scope: bound IP-less traffic with the shared budget instead of
    // waving it through. keySuffix still partitions by resource where supplied.
    const tail = args.keySuffix != null ? `:${args.keySuffix}` : "";
    return unknownLimiter.check(`rl:${args.scope}:${UNKNOWN_IP_KEY}${tail}`);
  }
  const ipPart = rateLimitKeyFromIp(args.ip);
  const tail = args.keySuffix != null ? `:${args.keySuffix}` : "";
  return args.limiter.check(`rl:${args.scope}:${ipPart}${tail}`);
}
