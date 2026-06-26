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
 * Method + exact-path Bearer-bypass allowlist.
 *
 * The proxy lets a cookieless Bearer request through without session
 * validation ONLY for an exact (method, path) pair below. This is the
 * structural Bearer gate: a route is Bearer-reachable IFF its
 * (method, exact-path) appears here. A handler-level
 * `checkAuth(req, {scope})` with a write scope is SAFE without a matching
 * entry — the proxy fails closed (cookieless Bearer → session-required →
 * 401) before the handler runs. To enable Bearer access for a new route,
 * add its (method, exact-path) pair here.
 *
 * Each rule's `match` is an EXACT matcher (no trailing wildcard): a literal
 * string for static paths, or an anchored regex with `[^/]+` for id
 * segments. Mutating children (bulk-*, empty-trash, attachments, history,
 * etc.) are deliberately absent — they are session-only and stay
 * proxy-unreachable via Bearer.
 */
type BearerRule = { methods: ReadonlySet<string>; match: (pathname: string) => boolean };

const exact = (route: string) => (pathname: string) => pathname === route;
const re = (pattern: RegExp) => (pathname: string) => pattern.test(pathname);

const M = (...methods: string[]) => new Set(methods);

// Literal sub-routes that sit alongside the `[id]` dynamic segment under
// .../passwords/. A naive `[^/]+` id pattern would also match these (they ARE
// single segments), so a Bearer GET to e.g. /api/passwords/bulk-import would
// wrongly match the single-entry rule. Entry ids are CUID/UUID and never equal
// these literals, so excluding them is safe and keeps the mutating children
// (which are session-only) off the Bearer surface.
const PASSWORD_SUBROUTES: ReadonlySet<string> = new Set([
  "bulk-archive",
  "bulk-import",
  "bulk-purge",
  "bulk-restore",
  "bulk-trash",
  "empty-trash",
  "generate",
]);

// Match a single-entry path via a STATIC regex whose capture group 1 is the
// entry-id segment, excluding reserved sub-route literals (bulk-*, etc.). The
// regex is passed as a literal — never built from string concatenation — so
// there is no escaping/injection surface.
const entryMatch = (pattern: RegExp) => (pathname: string) => {
  const m = pattern.exec(pathname);
  return m !== null && !PASSWORD_SUBROUTES.has(m[1]);
};

const BEARER_RULES: readonly BearerRule[] = [
  // Personal passwords — list + create + single-entry read/update/soft-delete.
  { methods: M("GET", "POST"), match: exact(API_PATH.PASSWORDS) },
  { methods: M("GET", "PUT", "DELETE"), match: entryMatch(/^\/api\/passwords\/([^/]+)$/) },

  // Teams — list (read) + member-key (wrapped key) + team password read.
  { methods: M("GET"), match: exact(API_PATH.TEAMS) },
  { methods: M("GET"), match: re(/^\/api\/teams\/[^/]+\/member-key$/) },
  { methods: M("GET"), match: re(/^\/api\/teams\/[^/]+\/passwords$/) },
  { methods: M("GET"), match: entryMatch(/^\/api\/teams\/[^/]+\/passwords\/([^/]+)$/) },

  // Vault — status + unlock data (read); delegation check + SSH sign (CLI agent).
  { methods: M("GET"), match: exact(API_PATH.VAULT_STATUS) },
  { methods: M("GET"), match: exact(API_PATH.VAULT_UNLOCK_DATA) },
  { methods: M("GET"), match: exact(`${API_PATH.VAULT_DELEGATION}/check`) },
  { methods: M("POST"), match: exact(API_PATH.VAULT_SSH_SIGN_AUTHORIZE) },

  // Extension token lifecycle (Bearer + DPoP, no session cookie).
  { methods: M("DELETE"), match: exact(API_PATH.EXTENSION_TOKEN) },
  { methods: M("POST"), match: exact(API_PATH.EXTENSION_TOKEN_REFRESH) },
  { methods: M("POST"), match: exact(API_PATH.EXTENSION_KEY_RESET) },

  // Service-account self-service JIT — create only (GET is session-only).
  { methods: M("POST"), match: exact(API_PATH.TENANT_ACCESS_REQUESTS) },
];

/**
 * Method-aware Bearer-bypass test. Returns true IFF `(method, pathname)`
 * is an explicit allowlist entry. Used by the proxy bypass branch.
 */
export function isBearerBypassRoute(pathname: string, method: string): boolean {
  return BEARER_RULES.some((rule) => rule.methods.has(method) && rule.match(pathname));
}

/**
 * Path-only (any-method) Bearer-bypass test. Used for the OPTIONS preflight
 * `allowExtension` decision: an OPTIONS request's method is "OPTIONS" (never
 * an allowlisted method), so the preflight must check path-eligibility
 * regardless of method. The actual GET/PUT/DELETE request that follows still
 * goes through the method-aware `isBearerBypassRoute` gate — CORS preflight
 * grants no server-side auth.
 */
export function isBearerBypassPath(pathname: string): boolean {
  return BEARER_RULES.some((rule) => rule.match(pathname));
}

/**
 * Documentation/diagnostic list of the base paths that accept a Bearer token
 * as alternative auth. This is NOT the matcher — `BEARER_RULES` is the
 * authoritative (method, exact-path) gate. Kept as a hand-maintained summary
 * for readers; the only test on it asserts it is non-empty.
 */
export const EXTENSION_TOKEN_ROUTES: readonly string[] = [
  API_PATH.PASSWORDS,
  API_PATH.VAULT_STATUS,
  API_PATH.VAULT_UNLOCK_DATA,
  API_PATH.EXTENSION_TOKEN,
  API_PATH.EXTENSION_TOKEN_REFRESH,
  API_PATH.EXTENSION_KEY_RESET,
  API_PATH.TENANT_ACCESS_REQUESTS,
  API_PATH.VAULT_DELEGATION,
  API_PATH.VAULT_SSH_SIGN_AUTHORIZE,
];

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
