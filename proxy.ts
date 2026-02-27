import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { proxy as handleProxy } from "./src/proxy";

export function proxy(request: NextRequest) {
  // Guard: skip Next.js internals that the matcher regex may not exclude
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/_next") || pathname.startsWith("/_vercel")) {
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
  const isProd = process.env.NODE_ENV === "production";
  const cspMode = process.env.CSP_MODE ?? (isProd ? "strict" : "dev");

  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isProd ? "" : " 'unsafe-eval'"}`,
    cspMode === "dev"
      ? "style-src 'self' 'unsafe-inline'"
      : `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data: https:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
    "block-all-mixed-content",
    "report-to csp-endpoint",
    "report-uri /api/csp-report",
  ];

  return directives.join("; ");
}
