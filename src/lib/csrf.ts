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
import { API_ERROR } from "./api-error-codes";

/**
 * Assert that the request's Origin header matches the application URL.
 * Returns null if valid, or a 403 NextResponse if invalid.
 *
 * Usage in route handlers:
 *   const originError = assertOrigin(request);
 *   if (originError) return originError;
 */
export function assertOrigin(request: Request): NextResponse | null {
  const origin = request.headers.get("origin");
  const appUrl = process.env.APP_URL || process.env.AUTH_URL;

  if (!appUrl) {
    // If APP_URL is not configured, skip check (dev convenience)
    return null;
  }

  if (!origin) {
    // Missing Origin header — reject for destructive endpoints
    return NextResponse.json(
      { error: API_ERROR.INVALID_ORIGIN },
      { status: 403 },
    );
  }

  try {
    const originUrl = new URL(origin);
    const expectedUrl = new URL(appUrl);
    if (originUrl.origin !== expectedUrl.origin) {
      return NextResponse.json(
        { error: API_ERROR.INVALID_ORIGIN },
        { status: 403 },
      );
    }
  } catch {
    return NextResponse.json(
      { error: API_ERROR.INVALID_ORIGIN },
      { status: 403 },
    );
  }

  return null;
}
