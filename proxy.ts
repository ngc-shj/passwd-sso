import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { proxy as handleProxy } from "./src/proxy";

// Pre-compute static CSP parts at module init time to avoid per-request work.
// Only the nonce value is injected per-request.
const _isProd = process.env.NODE_ENV === "production";
const _cspMode = process.env.CSP_MODE ?? (_isProd ? "strict" : "dev");
const _reportUri = `${process.env.NEXT_PUBLIC_BASE_PATH || ""}/api/csp-report`;
const _scriptSrcSuffix = _isProd ? "" : " 'unsafe-eval'";
// In dev mode style-src uses 'unsafe-inline'; in strict mode nonce is injected.
const _stylePrefix = _cspMode === "dev" ? "style-src 'self' 'unsafe-inline'" : "style-src 'self' 'nonce-";
const _styleSuffix = _cspMode === "dev" ? "" : "'";
const _staticDirectives = [
  "img-src 'self' data: https:",
  "font-src 'self'",
  `connect-src 'self'${process.env.NEXT_PUBLIC_SENTRY_DSN ? " https://*.ingest.us.sentry.io https://*.ingest.sentry.io" : ""}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
  "block-all-mixed-content",
  "report-to csp-endpoint",
  `report-uri ${_reportUri}`,
].join("; ");

export function proxy(request: NextRequest) {
  // Guard: skip Next.js internals that the matcher regex may not exclude
  const { pathname } = request.nextUrl;
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/_vercel") ||
    (!pathname.startsWith("/api/") && /\.(ico|png|svg|jpg|jpeg|gif|webp|css|js|woff2?|ttf|map|txt|webmanifest)$/.test(pathname))
  ) {
    return NextResponse.next();
  }

  const nonce = generateNonce();
  const cspHeader = buildCspHeader(nonce);

  return handleProxy(request, { cspHeader, nonce });
}

export const config = {
  matcher: [
    // Match all paths except static assets and Next.js internals
    "/((?!_next|_vercel|.*\\..*).*)",
    // API auth-protected routes (explicit for clarity, already covered by catch-all above)
    "/api/passwords/:path*",
    "/api/tags/:path*",
    "/api/watchtower/:path*",
    "/api/teams/:path*",
    "/api/audit-logs/:path*",
    "/api/share-links/:path*",
  ],
};

function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function buildCspHeader(nonce: string): string {
  const scriptSrc = `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'${_scriptSrcSuffix}`;
  const styleSrc = _cspMode === "dev"
    ? _stylePrefix
    : `${_stylePrefix}${nonce}${_styleSuffix}`;
  return `default-src 'self'; ${scriptSrc}; ${styleSrc}; ${_staticDirectives}`;
}
