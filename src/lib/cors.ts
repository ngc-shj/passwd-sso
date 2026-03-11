/**
 * CORS policy helpers for API routes.
 *
 * Policy: same-origin only by default. Cross-origin requests receive no CORS
 * headers, causing the browser to block the response. Non-browser clients are
 * not affected by CORS — server-side auth (session / Bearer) and assertOrigin()
 * provide the actual access control.
 *
 * Browser extension exception: Service Worker fetch with an Authorization
 * header triggers a CORS preflight. For Bearer-authenticated routes, the
 * preflight handler permits chrome-extension:// origins so that the actual
 * request can proceed.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getAppOrigin } from "@/lib/url-helpers";

/**
 * Resolve the canonical app origin for CORS comparison.
 *
 * APP_URL/AUTH_URL unset → null → no CORS headers (deny-equivalent for browsers).
 * CORS is a browser constraint only. Non-browser client defense is handled
 * by auth (session/Bearer) + assertOrigin().
 */
function resolveOrigin(): string | null {
  const url = getAppOrigin();
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
function isExtensionOrigin(origin: string): boolean {
  return /^chrome-extension:\/\/[a-z]{32}$/.test(origin) ||
    /^moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(origin) ||
    /^safari-web-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(origin);
}

function corsHeaders(
  request: NextRequest,
  opts?: { allowExtension?: boolean },
): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!origin) return {};

  const appOrigin = resolveOrigin();

  const allowed =
    (appOrigin && origin === appOrigin) ||
    (opts?.allowExtension && isExtensionOrigin(origin));

  if (allowed) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      // Credentials not needed for extension (Bearer token in header)
      ...(origin === appOrigin ? { "Access-Control-Allow-Credentials": "true" } : {}),
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    };
  }
  return {};
}

/**
 * Handle OPTIONS preflight for API routes.
 * Same-origin → 204 with CORS headers.
 * Extension origin + allowExtension → 204 with CORS headers.
 * Other cross-origin → 204 without CORS headers (browser blocks the actual request).
 */
export function handlePreflight(
  request: NextRequest,
  opts?: { allowExtension?: boolean },
): NextResponse {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(request, opts),
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
  opts?: { allowExtension?: boolean },
): NextResponse {
  for (const [key, value] of Object.entries(corsHeaders(request, opts))) {
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
