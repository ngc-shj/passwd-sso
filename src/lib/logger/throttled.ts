import { getLogger } from "@/lib/logger";
import { MS_PER_SECOND } from "@/lib/constants/time";

/**
 * Single throttle window used by every Redis-backed cache that uses
 * createThrottledErrorLogger for its fallback path. Centralized so the
 * forensic-responsiveness floor is uniform across session-cache, dpop
 * caches, and the rate-limit Redis path — changing the value here updates
 * all four call sites at once.
 */
export const REDIS_FALLBACK_LOG_THROTTLE_MS = 5 * MS_PER_SECOND;

/**
 * Throttled error logger factory. The returned function emits at most one
 * log line per intervalMs. Used by Redis-backed caches that must not flood
 * logs during sustained outages.
 *
 * The message is bound at construction time and CANNOT be overridden per
 * call — this prevents accidental token / secret leakage if a caller were
 * to construct messages from error contents.
 *
 * Optional errCode parameter lets callers pass a controlled allowlist of
 * error codes (e.g., "ECONNREFUSED", "NOAUTH") which carry no secrets.
 */
export function createThrottledErrorLogger(
  intervalMs: number,
  message: string,
): (errCode?: string) => void {
  let lastLogAt = 0;
  return (errCode?: string) => {
    const now = Date.now();
    if (now - lastLogAt < intervalMs) return;
    lastLogAt = now;
    getLogger().error({ code: errCode ?? "unknown" }, message);
  };
}
