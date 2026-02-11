import createIntlMiddleware from "next-intl/middleware";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { routing } from "./i18n/routing";

const intlMiddleware = createIntlMiddleware(routing);

type ProxyOptions = {
  cspHeader: string;
  nonce: string;
};

const SESSION_CACHE_TTL_MS = 30_000;
const SESSION_CACHE_MAX = 500;
const sessionCache = new Map<string, { expiresAt: number; valid: boolean }>();

export async function proxy(request: NextRequest, options: ProxyOptions) {
  const { pathname } = request.nextUrl;

  // Skip i18n for API routes
  if (pathname.startsWith("/api/")) {
    return handleApiAuth(request);
  }

  // Public share pages — skip i18n and auth
  if (pathname.startsWith("/s/")) {
    return applySecurityHeaders(NextResponse.next(), options);
  }

  // Run next-intl middleware (locale detection, prefix redirect)
  const intlResponse = intlMiddleware(request);

  // If next-intl returned a redirect, let it through
  if (intlResponse.status !== 200) {
    return applySecurityHeaders(intlResponse, options);
  }

  // Extract locale and path without locale prefix
  const segments = pathname.split("/");
  const locale = routing.locales.includes(segments[1] as "ja" | "en")
    ? segments[1]
    : routing.defaultLocale;
  const pathWithoutLocale = "/" + segments.slice(2).join("/");

  // Auth check for protected routes
  if (pathWithoutLocale.startsWith("/dashboard")) {
    const hasSession = await hasValidSession(request);
    if (!hasSession) {
      const signInUrl = new URL(`/${locale}/auth/signin`, request.url);
      signInUrl.searchParams.set("callbackUrl", request.url);
      return applySecurityHeaders(NextResponse.redirect(signInUrl), options);
    }
  }

  return applySecurityHeaders(intlResponse, options);
}

async function handleApiAuth(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (
    pathname.startsWith("/api/passwords") ||
    pathname.startsWith("/api/tags") ||
    pathname.startsWith("/api/watchtower") ||
    pathname.startsWith("/api/orgs") ||
    pathname.startsWith("/api/audit-logs") ||
    pathname.startsWith("/api/share-links") ||
    pathname.startsWith("/api/emergency-access")
  ) {
    const hasSession = await hasValidSession(request);
    if (!hasSession) {
      return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
    }
  }

  return NextResponse.next();
}

async function hasValidSession(request: NextRequest): Promise<boolean> {
  const cookie = request.headers.get("cookie");
  if (!cookie) return false;

  const cacheKey = await hashCookie(cookie);
  const cached = sessionCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.valid;
  }
  if (cached) sessionCache.delete(cacheKey);

  try {
    const sessionUrl = new URL("/api/auth/session", request.url);
    const res = await fetch(sessionUrl, {
      headers: { cookie },
    });
    if (!res.ok) {
      setSessionCache(cacheKey, false);
      return false;
    }
    const data = await res.json();
    const valid = !!data?.user;
    setSessionCache(cacheKey, valid);
    return valid;
  } catch {
    return false;
  }
}

function setSessionCache(key: string, valid: boolean) {
  if (sessionCache.size >= SESSION_CACHE_MAX) {
    sessionCache.clear();
  }
  sessionCache.set(key, {
    expiresAt: Date.now() + SESSION_CACHE_TTL_MS,
    valid,
  });
}

async function hashCookie(cookie: string): Promise<string> {
  const data = new TextEncoder().encode(cookie);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray, (b) => b.toString(16).padStart(2, "0")).join("");
}

function applySecurityHeaders(
  response: NextResponse,
  { cspHeader, nonce }: ProxyOptions
): NextResponse {
  response.headers.set("Content-Security-Policy", cspHeader);
  response.headers.set(
    "Report-To",
    JSON.stringify({
      group: "csp-endpoint",
      max_age: 10886400,
      endpoints: [{ url: "/api/csp-report" }],
      include_subdomains: true,
    })
  );
  response.headers.set(
    "Reporting-Endpoints",
    'csp-endpoint="/api/csp-report"'
  );

  response.cookies.set("csp-nonce", nonce, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });

  return response;
}
