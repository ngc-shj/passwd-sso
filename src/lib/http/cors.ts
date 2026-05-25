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
  // Chrome extension IDs are 32 chars from [a-p] (Chrome's signing-key encoding
  // maps random bytes to a-p, NOT generic a-z). Aligned with C1 zod regex
  // EXTENSION_BRIDGE_CODE_ALLOWED_ORIGINS — see plan S16.
  return /^chrome-extension:\/\/[a-p]{32}$/.test(origin) ||
    /^moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(origin) ||
    /^safari-web-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(origin);
}

/**
 * Parse the EXTENSION_BRIDGE_CODE_ALLOWED_ORIGINS env var into a Set for
 * exact-string allowlist lookup. Built once per process and reset on demand
 * via __resetAllowlistForTests (test-only).
 */
let _allowlistCache: Set<string> | null = null;
function getBridgeCodeAllowlist(): Set<string> {
  if (_allowlistCache !== null) return _allowlistCache;
  const raw = process.env.EXTENSION_BRIDGE_CODE_ALLOWED_ORIGINS ?? "";
  if (!raw) {
    _allowlistCache = new Set();
    return _allowlistCache;
  }
  _allowlistCache = new Set(raw.split(","));
  return _allowlistCache;
}

/** @internal Test-only: reset the cached allowlist Set. */
export function __resetAllowlistForTests(): void {
  _allowlistCache = null;
}

/**
 * Check whether the given Origin is in the bridge-code allowlist. Uses exact
 * string equality on a precomputed Set — never substring (see plan S6/S9).
 */
export function isBridgeCodeOriginAllowed(origin: string | null): boolean {
  if (!origin) return false;
  return getBridgeCodeAllowlist().has(origin);
}

function corsHeaders(
  request: NextRequest,
  opts?: { allowExtension?: boolean; allowExtensionCredentials?: boolean },
): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!origin) return {};

  const appOrigin = resolveOrigin();

  // allowExtensionCredentials implies the bridge-code route (cookies + DPoP +
  // chrome-extension origin). The Origin MUST be in the allowlist parsed from
  // EXTENSION_BRIDGE_CODE_ALLOWED_ORIGINS — extension-shape regex match alone
  // is insufficient since any installed extension could otherwise piggy-back.
  const bridgeCodeAllowed =
    opts?.allowExtensionCredentials &&
    isExtensionOrigin(origin) &&
    isBridgeCodeOriginAllowed(origin);

  const allowed =
    (appOrigin && origin === appOrigin) ||
    (opts?.allowExtension && isExtensionOrigin(origin)) ||
    bridgeCodeAllowed;

  if (allowed) {
    // Allow-Credentials is set only for two cases:
    //   (a) same-origin Web App (existing behavior — cookie auth)
    //   (b) chrome-extension Origin on the bridge-code route AND allowlisted
    // It is NOT set for Bearer-bypass routes (extension origin without
    // credentials guard) — those routes carry Bearer tokens, not cookies.
    const credentials: Record<string, string> =
      origin === appOrigin || bridgeCodeAllowed
        ? { "Access-Control-Allow-Credentials": "true" }
        : {};
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, DPoP",
      ...credentials,
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
  opts?: { allowExtension?: boolean; allowExtensionCredentials?: boolean },
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
  opts?: { allowExtension?: boolean; allowExtensionCredentials?: boolean },
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
