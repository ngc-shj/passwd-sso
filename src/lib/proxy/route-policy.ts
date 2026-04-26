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

/**
 * RoutePolicy kind constants. Use these instead of string literals so a
 * typo is a compile error, not a silently-unreachable branch.
 *
 * Note: there is intentionally no separate "api-bearer-bypass" kind.
 * Routes that accept extension Bearer as alternative auth (e.g., /api/passwords)
 * are still fundamentally session-required. The Bearer-bypass is a code-path
 * concern (which dispatch branch the orchestrator takes), NOT a classification
 * concern. The orchestrator uses `isBearerBypassRoute(pathname)` from
 * cors-gate to decide whether the bypass dispatch is eligible for a given
 * request, while `api-session-required` covers all session-cookie-protected
 * routes (including bypass-eligible ones).
 */
export const ROUTE_POLICY_KIND = {
  PREFLIGHT: "preflight",
  PUBLIC_SHARE: "public-share",
  PUBLIC_RECEIVER: "public-receiver",
  API_V1: "api-v1",
  API_EXTENSION_EXCHANGE: "api-extension-exchange",
  API_SESSION_REQUIRED: "api-session-required",
  API_DEFAULT: "api-default",
  PAGE: "page",
} as const;

export type RoutePolicyKind = typeof ROUTE_POLICY_KIND[keyof typeof ROUTE_POLICY_KIND];

export type RoutePolicy =
  | { kind: typeof ROUTE_POLICY_KIND.PREFLIGHT }                // OPTIONS preflight (method-checked separately)
  | { kind: typeof ROUTE_POLICY_KIND.PUBLIC_SHARE }             // /api/share-links/*/content, /verify-access
  | { kind: typeof ROUTE_POLICY_KIND.PUBLIC_RECEIVER }          // /api/csp-report — public POST receiver
  | { kind: typeof ROUTE_POLICY_KIND.API_V1 }                   // /api/v1/* — Bearer (API key) authenticated
  | { kind: typeof ROUTE_POLICY_KIND.API_EXTENSION_EXCHANGE }   // /api/extension/token/exchange — bootstraps Bearer
  | { kind: typeof ROUTE_POLICY_KIND.API_SESSION_REQUIRED }     // session-cookie-protected API routes (incl. Bearer-bypass-eligible)
  | { kind: typeof ROUTE_POLICY_KIND.API_DEFAULT }              // other /api/* — default cache-control only
  | { kind: typeof ROUTE_POLICY_KIND.PAGE };                    // non-API path

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
    return { kind: ROUTE_POLICY_KIND.PAGE };
  }

  // Public share-link viewer endpoints (no auth, no CSRF).
  if (
    pathname === `${API_PATH.SHARE_LINKS}/verify-access` ||
    /^\/api\/share-links\/[^/]+\/content$/.test(pathname)
  ) {
    return { kind: ROUTE_POLICY_KIND.PUBLIC_SHARE };
  }

  // Public POST receiver — CSP violation reports. Browsers may attach
  // session cookies on these (top-level navigation reports), but the
  // route is intentionally public and accepts cross-origin / null Origin.
  if (pathname === API_PATH.CSP_REPORT) {
    return { kind: ROUTE_POLICY_KIND.PUBLIC_RECEIVER };
  }

  // /api/v1/* — API-key-authenticated REST API. CSRF gate skips it
  // because v1 routes do not authenticate via session cookies.
  if (pathname.startsWith(`${API_PATH.API_ROOT}/v1/`)) {
    return { kind: ROUTE_POLICY_KIND.API_V1 };
  }

  // Bridge-code exchange — bootstraps a Bearer token from a one-time
  // code. No session, no Bearer on the request.
  if (pathname === API_PATH.EXTENSION_TOKEN_EXCHANGE) {
    return { kind: ROUTE_POLICY_KIND.API_EXTENSION_EXCHANGE };
  }

  // Session-required API routes. This includes Bearer-bypass-eligible
  // routes (PASSWORDS, API_KEYS, VAULT_DELEGATION etc.) — they're
  // fundamentally session-required, with optional Bearer as alternative
  // auth. Every EXTENSION_TOKEN_ROUTES entry (cors-gate.ts) is already
  // covered by a SESSION_REQUIRED_PREFIXES match, so we don't import
  // isBearerBypassRoute here — keeping route-policy as a pure pathname
  // classifier with no dependency on cors-gate. The orchestrator calls
  // isBearerBypassRoute(pathname) directly to decide whether the
  // bypass dispatch is taken for a given request; the classification
  // stays "api-session-required" either way.
  if (SESSION_REQUIRED_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return { kind: ROUTE_POLICY_KIND.API_SESSION_REQUIRED };
  }

  // Other /api/* routes (e.g., /api/internal/*, /api/maintenance/*,
  // /api/admin/*, /api/scim/*, /api/auth/*). The proxy applies only
  // default cache-control headers; the route handler is responsible for
  // its own auth.
  return { kind: ROUTE_POLICY_KIND.API_DEFAULT };
}

/**
 * Helper exported for the orchestrator: quickly check whether a path is
 * inside the API root (i.e. needs API auth handling rather than page
 * intl handling).
 */
export function isApiRoute(pathname: string): boolean {
  return pathname.startsWith(`${API_PATH.API_ROOT}/`);
}
