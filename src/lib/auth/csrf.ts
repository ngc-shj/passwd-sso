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
import { API_ERROR } from "../api-error-codes";
import { getAppOrigin } from "@/lib/url-helpers";

const forbidden = (): NextResponse =>
  NextResponse.json({ error: API_ERROR.INVALID_ORIGIN }, { status: 403 });

/**
 * Assert that the request's Origin header matches the application URL.
 * Returns null if valid, or a 403 NextResponse if invalid.
 *
 * Destructive endpoints always require an Origin header. When APP_URL /
 * AUTH_URL is not configured, the expected origin is derived from the Host
 * header. Note: `x-forwarded-proto` is only honored as a scheme hint — the
 * origin comparison still requires Host to match, so a spoofed proto alone
 * cannot forge a same-origin request.
 *
 * Usage in route handlers:
 *   const originError = assertOrigin(request);
 *   if (originError) return originError;
 */
export function assertOrigin(request: Request): NextResponse | null {
  const origin = request.headers.get("origin");
  if (!origin) return forbidden();

  let expectedOrigin: string;
  const appUrl = getAppOrigin();
  if (appUrl) {
    expectedOrigin = appUrl;
  } else {
    const host = request.headers.get("host");
    if (!host) return forbidden();
    const proto = request.headers.get("x-forwarded-proto") || "http";
    expectedOrigin = `${proto}://${host}`;
  }

  try {
    if (new URL(origin).origin !== new URL(expectedOrigin).origin) {
      return forbidden();
    }
  } catch {
    return forbidden();
  }

  return null;
}
