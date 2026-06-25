/**
 * CORS / Bearer-bypass detection for the proxy layer.
 *
 * Wraps the lower-level utilities in `src/lib/http/cors.ts` with the
 * route-set knowledge that the proxy needs (which paths accept extension
 * Bearer tokens, which is the bridge-code exchange route, etc.).
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { API_PATH } from "@/lib/constants";
import { handlePreflight, applyCorsHeaders } from "@/lib/http/cors";

/**
 * Routes that accept extension Bearer tokens as alternative auth.
 * The proxy lets these through without session validation when only
 * a Bearer header is present (no session cookie).
 *
 * IMPROVE(#39): harden allowlist matching — add edge-case tests for child paths
 */
export const EXTENSION_TOKEN_ROUTES: readonly string[] = [
  API_PATH.PASSWORDS,
  API_PATH.VAULT_STATUS,
  API_PATH.VAULT_UNLOCK_DATA,
  API_PATH.EXTENSION_TOKEN,         // DELETE (revoke) — validated by route handler
  API_PATH.EXTENSION_TOKEN_REFRESH, // POST (refresh) — validated by route handler
  API_PATH.EXTENSION_KEY_RESET,     // POST (key reset) — Bearer + DPoP, no session cookie
  API_PATH.TENANT_ACCESS_REQUESTS,  // SA self-service JIT — validated by route handler via authOrToken
  API_PATH.VAULT_DELEGATION,        // Delegation check — CLI agent uses Bearer for /check
  API_PATH.VAULT_SSH_SIGN_AUTHORIZE, // SSH agent per-signature authorize — CLI uses Bearer
];

/**
 * Narrow Bearer-bypass matcher for /api/teams paths.
 *
 * iOS/extension only need:
 *   - /api/teams                         (exact) — team list
 *   - /api/teams/<teamId>/member-key     (exact, leaf) — wrapped key
 *   - /api/teams/<teamId>/passwords/**   (prefix) — entry list + single entry
 *
 * S1 LOCKED CONSTRAINT: the passwords prefix makes mutating children
 * (bulk-import, empty-trash, bulk-*) Bearer-REACHABLE. Safe today — those
 * handlers are auth()-only (session) and 401 a cookieless Bearer. Do NOT
 * migrate any teams/<teamId>/passwords mutating child to checkAuth with a
 * write scope (PASSWORDS_WRITE / TEAM_PASSWORDS_WRITE) without narrowing this
 * matcher — it would make them Bearer-WRITABLE.
 */
function isBearerBypassTeamPath(pathname: string): boolean {
  return (
    /^\/api\/teams$/.test(pathname) ||
    /^\/api\/teams\/[^/]+\/member-key$/.test(pathname) ||
    /^\/api\/teams\/[^/]+\/passwords(\/.*)?$/.test(pathname)
  );
}

/**
 * Match a request path against the Bearer-bypass route list.
 * Extension token endpoints are exact-match only; password/vault routes
 * allow child paths.
 */
export function isBearerBypassRoute(pathname: string): boolean {
  return (
    isBearerBypassTeamPath(pathname) ||
    EXTENSION_TOKEN_ROUTES.some((route) => {
      if (
        route === API_PATH.EXTENSION_TOKEN ||
        route === API_PATH.EXTENSION_TOKEN_REFRESH ||
        route === API_PATH.EXTENSION_KEY_RESET
      ) {
        return pathname === route;
      }
      return pathname === route || pathname.startsWith(route + "/");
    })
  );
}

/**
 * Whether this is the bridge-code exchange route. The route bootstraps a
 * Bearer token from a one-time code; no session, no Bearer on the request.
 */
export function isExtensionExchangeRoute(pathname: string): boolean {
  return pathname === API_PATH.EXTENSION_TOKEN_EXCHANGE;
}

/**
 * Handle CORS preflight (OPTIONS). Allows chrome-extension:// origins for
 * Bearer-bypass routes and the bridge-code exchange route.
 */
export function handleApiPreflight(
  request: NextRequest,
  opts: { isBearerRoute: boolean; isExchangeRoute: boolean; isBridgeCodeRoute?: boolean },
): NextResponse {
  return handlePreflight(request, {
    allowExtension: opts.isBearerRoute || opts.isExchangeRoute,
    allowExtensionCredentials: opts.isBridgeCodeRoute,
  });
}

// Re-export the lower-level utility so the orchestrator only imports from
// this module for CORS concerns.
export { applyCorsHeaders };
