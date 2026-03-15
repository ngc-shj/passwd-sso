import { BASE_PATH } from "./url-helpers";

const DEFAULT_PATH = `${BASE_PATH}/dashboard`;

/**
 * Validate and resolve a callbackUrl parameter to a safe redirect target.
 *
 * - Accepts relative paths starting with "/" (rejects protocol-relative, backslash, and dangerous schemes)
 * - Accepts same-origin absolute URLs (extracts pathname + search)
 * - Falls back to /dashboard for null, empty, cross-origin, or malformed input
 *
 * Pure function — safe for both client and server.
 * Client: pass window.location.origin
 * Server: pass origin from getAppOrigin() env vars.
 *         When origin is "" (env var unset), only relative paths pass through;
 *         all absolute URLs are rejected (fail-closed).
 */
export function resolveCallbackUrl(
  raw: string | null,
  origin: string,
): string {
  if (!raw) return DEFAULT_PATH;

  // Reject non-HTTP(S) schemes (e.g. javascript:, data:, vbscript:)
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !raw.startsWith("http")) {
    return DEFAULT_PATH;
  }

  // Relative path: normalize through URL constructor to neutralize path traversal
  // tricks like "/./evil.com" → "//evil.com" or tab/newline injection
  if (raw.startsWith("/")) {
    if (raw.startsWith("//") || raw.startsWith("/\\")) return DEFAULT_PATH;
    try {
      const normalized = new URL(raw, "http://placeholder.invalid");
      // After normalization, ensure it didn't become a different origin
      if (normalized.origin !== "http://placeholder.invalid") return DEFAULT_PATH;
      // Return normalized pathname + search (strips fragment)
      return normalized.pathname + normalized.search;
    } catch {
      return DEFAULT_PATH;
    }
  }

  // Absolute URL: must be same-origin
  try {
    const url = new URL(raw);
    if (url.origin === origin) {
      return url.pathname + url.search;
    }
  } catch {
    // Malformed URL
  }

  return DEFAULT_PATH;
}
