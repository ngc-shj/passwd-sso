/**
 * CORS policy helpers for API routes.
 *
 * Policy: same-origin only. Cross-origin requests receive no CORS headers,
 * causing the browser to block the response. Non-browser clients are not
 * affected by CORS — server-side auth (session / Bearer) and assertOrigin()
 * provide the actual access control.
 *
 * The browser extension communicates via Background Service Worker with
 * Bearer tokens, bypassing browser CORS entirely.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Resolve the canonical app origin from environment.
 * Matches the same priority as csrf.ts assertOrigin().
 *
 * APP_URL/AUTH_URL unset → null → no CORS headers (deny-equivalent for browsers).
 * CORS is a browser constraint only. Non-browser client defense is handled
 * by auth (session/Bearer) + assertOrigin().
 */
function getAppOrigin(): string | null {
  const url = process.env.APP_URL || process.env.AUTH_URL;
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Build CORS response headers for same-origin requests.
 *
 * - same-origin → full CORS headers + Vary: Origin
 * - cross-origin → empty (browser blocks; server-side auth is separate layer)
 * - Origin absent → empty (same-origin navigation, no CORS needed)
 * - APP_URL unset → empty (deny-equivalent for browsers)
 */
function corsHeaders(request: NextRequest): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!origin) return {};

  const appOrigin = getAppOrigin();
  if (!appOrigin) return {};

  if (origin === appOrigin) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    };
  }
  return {};
}

/**
 * Handle OPTIONS preflight for API routes.
 * Same-origin → 204 with CORS headers.
 * Cross-origin → 204 without CORS headers (browser blocks the actual request).
 */
export function handlePreflight(request: NextRequest): NextResponse {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(request),
  });
}

/**
 * Apply CORS headers to an existing response.
 * Use this as a single exit point for all API responses in proxy
 * to prevent header omission on any return path.
 */
export function applyCorsHeaders(
  request: NextRequest,
  response: NextResponse,
): NextResponse {
  for (const [key, value] of Object.entries(corsHeaders(request))) {
    if (key === "Vary") {
      // Merge into existing Vary with case-insensitive dedup
      // e.g. "Accept-Encoding" → "Accept-Encoding, Origin"
      const existing = response.headers.get("Vary") ?? "";
      const tokens = new Map(
        existing
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
          .map((t) => [t.toLowerCase(), t] as const),
      );
      if (!tokens.has(value.toLowerCase())) {
        tokens.set(value.toLowerCase(), value);
      }
      response.headers.set("Vary", [...tokens.values()].join(", "));
    } else {
      response.headers.set(key, value);
    }
  }
  return response;
}
