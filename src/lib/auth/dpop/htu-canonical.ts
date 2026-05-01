import { getAppOrigin } from "@/lib/url-helpers";

/**
 * Build the canonical `htu` value the server expects in a DPoP proof.
 *
 * RFC 9449 §4.3:
 *   The HTTP target URI of the request to which the JWT is attached
 *   without query and fragment parts.
 *
 * Canonicalization rules pinned by this implementation:
 *  - scheme: lowercase
 *  - host:   lowercase
 *  - port:   stripped if it is the scheme default (80/443)
 *  - path:   exactly the route as configured (proxy rewrites must NOT
 *            reach this layer — server records its canonical URL once)
 *  - query, fragment: removed
 *
 * The host is read from APP_URL/AUTH_URL at call time so that proxy
 * Host-header rewrites cannot influence what we accept.
 */
export function canonicalHtu(args: { route: string }): string {
  const origin = getAppOrigin();
  if (!origin) {
    throw new Error("canonicalHtu: APP_URL (or AUTH_URL) must be configured");
  }
  const url = new URL(origin);
  const scheme = url.protocol.toLowerCase(); // includes trailing ":"
  const host = url.hostname.toLowerCase();
  const port = url.port;
  const isDefaultPort =
    (scheme === "http:" && (port === "" || port === "80")) ||
    (scheme === "https:" && (port === "" || port === "443"));
  const authority = isDefaultPort ? host : `${host}:${port}`;

  const path = normalizePath(args.route);
  return `${scheme}//${authority}${path}`;
}

function normalizePath(route: string): string {
  if (!route.startsWith("/")) return `/${route}`;
  return route;
}

/**
 * Canonical-URL equality test for DPoP `htu` matching.
 *
 * RFC 9449 §4.3 says scheme+host comparison is case-insensitive but
 * path is exact. Both inputs are expected to be canonicalized via
 * `canonicalHtu` already, but we re-normalize defensively.
 */
export function htuMatches(provided: string, expected: string): boolean {
  try {
    const a = new URL(provided);
    const b = new URL(expected);
    if (a.protocol.toLowerCase() !== b.protocol.toLowerCase()) return false;
    if (a.hostname.toLowerCase() !== b.hostname.toLowerCase()) return false;
    if (normalizePort(a) !== normalizePort(b)) return false;
    if (a.pathname !== b.pathname) return false;
    // Reject any query/fragment on either side — htu must not carry them.
    if (a.search || a.hash) return false;
    return true;
  } catch {
    return false;
  }
}

function normalizePort(u: URL): string {
  if (u.port) return u.port;
  if (u.protocol === "http:") return "80";
  if (u.protocol === "https:") return "443";
  return "";
}
