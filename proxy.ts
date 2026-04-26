import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { proxy as handleProxy } from "./src/proxy";
import { buildCspHeader } from "./src/lib/security/csp-builder";

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
    // Match all paths except static assets and Next.js internals.
    // API routes are covered by this pattern — no need to enumerate them.
    "/((?!_next|_vercel|.*\\..*).*)",
  ],
};

function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
