/**
 * Pure-function classifier mapping a request URL pathname to a
 * RoutePolicy discriminated union.
 *
 * Used by the proxy orchestrator to dispatch each API request to the
 * right handling branch. The classifier is pathname-only — it does not
 * inspect headers, cookies, or method (those are gating concerns of the
 * orchestrator and the CSRF gate).
 *
 * Naming MUST be consistent: every `policy.kind === "..."` comparison in
 * the orchestrator MUST use a string from this union.
 */

import { API_PATH } from "@/lib/constants";
import { isBearerBypassRoute } from "./cors-gate";

export type RoutePolicy =
  | { kind: "preflight" }                               // OPTIONS preflight (method-checked separately)
  | { kind: "public-share" }                            // /api/share-links/*/content, /verify-access
  | { kind: "public-receiver" }                         // /api/csp-report — public POST receiver
  | { kind: "api-v1" }                                  // /api/v1/* — Bearer (API key) authenticated
  | { kind: "api-bearer-bypass" }                       // Routes that accept session OR extension Bearer
  | { kind: "api-extension-exchange" }                  // /api/extension/token/exchange — bootstraps Bearer
  | { kind: "api-session-required" }                    // session-cookie-protected API routes
  | { kind: "api-default" }                             // other /api/* — default cache-control only
  | { kind: "page" };                                   // non-API path

const SESSION_REQUIRED_PREFIXES: readonly string[] = [
  API_PATH.PASSWORDS,
  API_PATH.TAGS,
  API_PATH.WATCHTOWER,
  API_PATH.TEAMS,
  API_PATH.AUDIT_LOGS,
  API_PATH.SHARE_LINKS,
  API_PATH.SENDS,
  API_PATH.EMERGENCY_ACCESS,
  API_PATH.SESSIONS,
  API_PATH.NOTIFICATIONS,
  API_PATH.USER_LOCALE,
  API_PATH.USER_MCP_TOKENS,
  API_PATH.USER_AUTH_PROVIDER,
  API_PATH.EXTENSION,
  API_PATH.TENANT,
  API_PATH.API_KEYS,
  API_PATH.TRAVEL_MODE,
  API_PATH.DIRECTORY_SYNC,
  API_PATH.VAULT,
  API_PATH.FOLDERS,
  API_PATH.WEBAUTHN,
];

/**
 * Classify a request pathname. The CALLER is responsible for handling
 * preflight (OPTIONS method) before consulting this function — the
 * `preflight` kind is only returned when the caller pre-flags the
 * method, which classifyRoute itself does not inspect.
 *
 * Returns `kind: "page"` for non-API paths.
 */
export function classifyRoute(pathname: string): RoutePolicy {
  // Non-API paths are page routes (handled by the page-side branch).
  if (!pathname.startsWith(`${API_PATH.API_ROOT}/`)) {
    return { kind: "page" };
  }

  // Public share-link viewer endpoints (no auth, no CSRF).
  if (
    pathname === `${API_PATH.SHARE_LINKS}/verify-access` ||
    /^\/api\/share-links\/[^/]+\/content$/.test(pathname)
  ) {
    return { kind: "public-share" };
  }

  // Public POST receiver — CSP violation reports. Browsers may attach
  // session cookies on these (top-level navigation reports), but the
  // route is intentionally public and accepts cross-origin / null Origin.
  if (pathname === API_PATH.CSP_REPORT) {
    return { kind: "public-receiver" };
  }

  // /api/v1/* — API-key-authenticated REST API. CSRF gate skips it
  // because v1 routes do not authenticate via session cookies.
  if (pathname.startsWith(`${API_PATH.API_ROOT}/v1/`)) {
    return { kind: "api-v1" };
  }

  // Bridge-code exchange — bootstraps a Bearer token from a one-time
  // code. No session, no Bearer on the request.
  if (pathname === API_PATH.EXTENSION_TOKEN_EXCHANGE) {
    return { kind: "api-extension-exchange" };
  }

  // Routes that accept either a session OR an extension Bearer token.
  // The proxy lets the route handler decide; CSRF gate fires only when
  // a session cookie is present.
  if (isBearerBypassRoute(pathname)) {
    return { kind: "api-bearer-bypass" };
  }

  // Session-required API routes — proxy validates session before
  // delegating to the route handler.
  if (SESSION_REQUIRED_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return { kind: "api-session-required" };
  }

  // Other /api/* routes (e.g., /api/internal/*, /api/maintenance/*,
  // /api/admin/*, /api/scim/*, /api/auth/*). The proxy applies only
  // default cache-control headers; the route handler is responsible for
  // its own auth.
  return { kind: "api-default" };
}

/**
 * Helper exported for the orchestrator: quickly check whether a path is
 * inside the API root (i.e. needs API auth handling rather than page
 * intl handling).
 */
export function isApiRoute(pathname: string): boolean {
  return pathname.startsWith(`${API_PATH.API_ROOT}/`);
}
