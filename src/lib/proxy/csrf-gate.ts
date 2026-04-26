/**
 * Baseline CSRF defense for session-cookie-bearing mutating API requests.
 *
 * Design: request-attribute-gated, NOT path-classification-gated.
 * The gate fires whenever a request matches the cookie-CSRF attack
 * surface (browser sends session cookie + state-mutating method),
 * regardless of which route classification the path falls into.
 *
 * This is the architectural choice that makes the gap impossible to
 * recreate: any future cookie-auth API route — whether classified as
 * api-session-required, falling through to api-default, or living in
 * /api/internal/* / /api/folders/* — gets CSRF protection automatically.
 *
 * Routes that need stricter origin checks (e.g., requiring APP_URL to
 * be explicitly set, no Host-header fallback) keep those route-level
 * additions on top of this baseline. See vault/admin-reset.
 *
 * Routes outside the cookie-CSRF threat model (pre-auth flows that
 * receive cookieless requests, public receivers like csp-report,
 * Bearer-only flows like api-v1) are short-circuited by the orchestrator
 * BEFORE this gate runs.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { assertOrigin } from "@/lib/auth/session/csrf";

const MUTATING_METHODS: ReadonlySet<string> = new Set([
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
]);

/**
 * Returns true when the request matches the cookie-CSRF attack surface.
 *
 * Bearer-only callers (extension, MCP, SCIM, SA, API key) don't carry
 * session cookies, so they pass `hasSessionCookie === false` and skip
 * the check naturally.
 */
export function shouldEnforceCsrf(
  request: NextRequest,
  hasSessionCookie: boolean,
): boolean {
  return hasSessionCookie && MUTATING_METHODS.has(request.method);
}

/**
 * Run the Origin assertion. Returns null for pass-through, or a 403
 * NextResponse if Origin mismatch. Delegates to the existing
 * `assertOrigin` helper for the actual comparison logic.
 */
export function assertSessionCsrf(request: NextRequest): NextResponse | null {
  return assertOrigin(request);
}
