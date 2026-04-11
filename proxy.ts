import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { proxy as handleProxy } from "./src/proxy";

// Pre-compute static CSP parts at module init time to avoid per-request work.
// Only the nonce value is injected per-request.
const _isProd = process.env.NODE_ENV === "production";
// Safety guard: in production, never allow CSP_MODE=dev to downgrade the CSP.
// Ops mistakes (wrong .env.production, Docker env, etc.) must not silently
// disable strict-dynamic + nonce in prod. Only "strict" is accepted in prod.
const _rawCspMode = process.env.CSP_MODE ?? (_isProd ? "strict" : "dev");
const _cspMode = _isProd && _rawCspMode !== "strict" ? "strict" : _rawCspMode;
if (_isProd && _rawCspMode !== _cspMode) {
  console.warn(
    `[CSP] CSP_MODE="${_rawCspMode}" is ignored in production builds; using "strict"`,
  );
}
const _reportUri = `${process.env.NEXT_PUBLIC_BASE_PATH || ""}/api/csp-report`;
// In dev mode style-src and script-src use 'unsafe-inline'; in strict mode
// nonce + 'strict-dynamic' is injected. Dev uses 'unsafe-inline' because the
// per-request nonce flow via cookie is not reliable for Next.js HMR/dev-overlay
// inline scripts (Next.js 16.2+ tightened cookie propagation to server components).
// Note: the per-request nonce is still generated and set as the `csp-nonce`
// cookie in dev (read by `src/app/layout.tsx` for a <meta name="csp-nonce">),
// but plays no CSP role in dev because the header uses 'unsafe-inline'.
// Production never hits this branch.
const _stylePrefix = _cspMode === "dev" ? "style-src 'self' 'unsafe-inline'" : "style-src 'self' 'nonce-";
const _styleSuffix = _cspMode === "dev" ? "" : "'";
const _staticDirectives = [
  "img-src 'self' data: https:",
  "font-src 'self'",
  `connect-src 'self'${process.env.NEXT_PUBLIC_SENTRY_DSN ? " https://*.ingest.us.sentry.io https://*.ingest.sentry.io" : ""}`,
  "object-src 'none'",
  "base-uri 'self'",
  // localhost/127.0.0.1 required in all environments: OAuth consent form redirects
  // to native app callback (RFC 8252 — Claude Code, Claude Desktop use localhost)
  "form-action 'self' http://localhost:* http://127.0.0.1:*",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
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
  // Dev mode: 'unsafe-inline' + 'unsafe-eval' (no nonce, no strict-dynamic).
  //   Necessary because Next.js HMR, Turbopack dev overlay, and React Fast Refresh
  //   inject inline scripts that cannot receive the per-request CSP nonce.
  //   This is the standard Next.js dev CSP configuration.
  // Strict mode: per-request nonce + 'strict-dynamic'.
  //   Inline scripts without the nonce are blocked. 'unsafe-eval' is intentionally
  //   NOT included even when strict mode is selected via CSP_MODE=strict in a
  //   non-prod NODE_ENV — strict mode approximates prod CSP and prod has no
  //   need for 'unsafe-eval' (Turbopack dev overlay uses eval() and will be
  //   blocked, but in that case the caller should use dev mode instead).
  const scriptSrc = _cspMode === "dev"
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'"
    : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'`;
  const styleSrc = _cspMode === "dev"
    ? _stylePrefix
    : `${_stylePrefix}${nonce}${_styleSuffix}`;
  return `default-src 'self'; ${scriptSrc}; ${styleSrc}; ${_staticDirectives}`;
}
