/**
 * CSRF protection helpers for destructive API endpoints.
 *
 * Existing 3-layer defense (all API routes):
 *   1. JSON body — request.json() requires Content-Type: application/json (preflight)
 *   2. SameSite=lax cookie — cross-origin POST won't send session cookie
 *   3. CSP connect-src 'self' — blocks XHR/fetch from external origins
 *
 * This module adds explicit Origin header validation for destructive endpoints
 * (recovery key generate, recover, vault reset) as defense-in-depth.
 */

import { NextResponse } from "next/server";
import { API_ERROR } from "../../http/api-error-codes";
import { errorResponse } from "../../http/api-response";
import { getAppOrigin } from "@/lib/url-helpers";

const forbidden = (): NextResponse =>
  errorResponse(API_ERROR.INVALID_ORIGIN, 403);

/**
 * Assert that the request's Origin header matches the application URL.
 * Returns null if valid, or a 403 NextResponse if invalid.
 *
 * Destructive endpoints always require an Origin header. The expected
 * origin must come from APP_URL / AUTH_URL; if neither is configured we
 * fail closed rather than trusting request headers to define "same origin".
 *
 * Usage in route handlers:
 *   const originError = assertOrigin(request);
 *   if (originError) return originError;
 */
export function assertOrigin(request: Request): NextResponse | null {
  const origin = request.headers.get("origin");
  if (!origin) return forbidden();

  const appUrl = getAppOrigin();
  if (!appUrl) return forbidden();

  try {
    if (new URL(origin).origin !== new URL(appUrl).origin) {
      return forbidden();
    }
  } catch {
    return forbidden();
  }

  return null;
}
