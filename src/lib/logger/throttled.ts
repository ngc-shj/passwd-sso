import { getLogger } from "@/lib/logger";

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
