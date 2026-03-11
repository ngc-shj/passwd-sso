const NETWORK_ERROR_PATTERN = /failed to fetch|networkerror|load failed/i;

/**
 * Normalize browser-specific fetch error messages into a stable error code.
 * Covers Chrome ("Failed to fetch"), Firefox ("NetworkError when attempting
 * to fetch resource."), and Safari ("Load failed").
 */
export function normalizeErrorCode(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : "";
  if (NETWORK_ERROR_PATTERN.test(raw)) {
    return "NETWORK_ERROR";
  }
  return raw || fallback;
}
