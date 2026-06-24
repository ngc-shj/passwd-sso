/**
 * Shared URL validation helpers for webhook / delivery target endpoints.
 *
 * `isSsrfSafeWebhookUrl` rejects URLs that would cause SSRF against private
 * networks: non-HTTPS, localhost/loopback, IP literals (v4/v6), and .local/.internal TLDs.
 */

/** Reject URLs that target private/internal addresses or use non-HTTPS. */
export function isSsrfSafeWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    // Reject embedded credentials (https://user:pass@host) — they leak via
    // list views and delivery logs.
    if (parsed.username !== "" || parsed.password !== "") return false;
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") return false;
    if (host === "0.0.0.0" || host.endsWith(".local") || host.endsWith(".internal")) return false;
    // Block all IP address literals (IPv4 and IPv6) — only allow FQDNs.
    // URL.hostname strips brackets from IPv6 (e.g. "[::1]" → "::1"), so check for colons.
    if (/^[\d.]+$/.test(host) || host.includes(":")) return false;
    return true;
  } catch {
    return false;
  }
}

export const SSRF_URL_VALIDATION_MESSAGE =
  "URL must use HTTPS and must not point to private/internal addresses";

/**
 * Mask a URL for logging / list display: keep scheme + host + pathname,
 * drop userinfo, query string, and fragment (any of which may carry secrets).
 * Returns a safe placeholder if the input is not a parseable URL.
 */
export function maskUrlForDisplay(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "[invalid-url]";
  }
}
