import { getAppOrigin, resolveBasePath } from "@/lib/url-helpers";

/**
 * Build the canonical `htu` value the server expects in a DPoP proof.
 *
 * RFC 9449 §4.3:
 *   The HTTP target URI of the request to which the JWT is attached
 *   without query and fragment parts.
 *
 * Canonicalization rules pinned by this implementation:
 *  - scheme:    lowercase
 *  - host:      lowercase
 *  - port:      stripped if it is the scheme default (80/443)
 *  - basePath:  primary source = APP_URL/AUTH_URL pathname; fallback =
 *               `NEXT_PUBLIC_BASE_PATH` env (so deployments that put the
 *               sub-path in NEXT_PUBLIC_BASE_PATH instead of AUTH_URL still
 *               match the URL the client actually called)
 *  - path:      exactly the route as configured (proxy rewrites must NOT
 *               reach this layer — server records its canonical URL once)
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

  // basePath: APP_URL/AUTH_URL pathname → NEXT_PUBLIC_BASE_PATH env fallback.
  // See resolveBasePath in url-helpers.ts.
  const basePath = resolveBasePath(url);

  const path = normalizePath(args.route);
  // A route derived from req.url is externally visible and already contains
  // basePath. Keep this operation idempotent so a sub-path deployment never
  // validates DPoP against `/base/base/api/...`. Require a path-segment
  // boundary so `/passwd-sso-evil` is not mistaken for `/passwd-sso`.
  const canonicalPath =
    basePath && (path === basePath || path.startsWith(`${basePath}/`))
      ? path
      : `${basePath}${path}`;
  return `${scheme}//${authority}${canonicalPath}`;
}

function normalizePath(route: string): string {
  if (!route.startsWith("/")) return `/${route}`;
  return route;
}

/**
 * Build the canonical `htu` value the client (browser extension) should use
 * when constructing a DPoP proof for a call to this server.
 *
 * Produces the same output as `canonicalHtu` when `serverUrl` equals
 * APP_URL/AUTH_URL, ensuring client-server htu equivalence:
 *
 *   canonicalHtuClient(serverUrl, route) === canonicalHtu({ route })
 *   when getAppOrigin() === serverUrl AND `route` carries no basePath prefix.
 *
 * This function unconditionally prepends basePath, so it is NOT idempotent the
 * way `canonicalHtu` is — the equivalence holds only for basePath-free routes,
 * which is exactly the client contract (all callers pass hardcoded API routes
 * like `/api/extension/token/exchange`). The server needs the idempotency guard
 * only because ITS caller may derive `route` from `req.url` (basePath included).
 *
 * Algorithm (per plan §C-shared / Round-3 S23-r3):
 *  - Parse serverUrl with `new URL`.
 *  - `URL.origin` lowercases scheme/host AND strips default ports (:80/:443).
 *  - Preserve pathname as basePath (trailing slash stripped) so deployments
 *    mounted at a sub-path (e.g. `https://example.com/passwd-sso`) produce
 *    `https://example.com/passwd-sso/api/...` matching the server's htu.
 *  - Append route (must start with `/`).
 *
 * @param serverUrl  Full server URL, e.g. from extension settings ("serverUrl").
 * @param route      API route path, e.g. "/api/extension/token/exchange".
 */
export function canonicalHtuClient(serverUrl: string, route: string): string {
  const url = new URL(serverUrl);
  const basePath = resolveBasePath(url);
  const path = route.startsWith("/") ? route : `/${route}`;
  return `${url.origin}${basePath}${path}`;
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
