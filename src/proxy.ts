import createIntlMiddleware from "next-intl/middleware";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { routing } from "./i18n/routing";
import { getLocaleFromPathname, stripLocalePrefix } from "./i18n/locale-utils";
import { API_PATH } from "./lib/constants";
import { handlePreflight, applyCorsHeaders } from "./lib/cors";

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
  if (pathname.startsWith(`${API_PATH.API_ROOT}/`)) {
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
  const locale = getLocaleFromPathname(pathname);
  const pathWithoutLocale = stripLocalePrefix(pathname);

  // Auth check for protected routes
  if (pathWithoutLocale.startsWith("/dashboard")) {
    const hasSession = await hasValidSession(request);
    if (!hasSession) {
      const signInUrl = new URL(`/${locale}/auth/signin`, request.url);
      signInUrl.searchParams.set("callbackUrl", request.url);
      const redirectResponse = NextResponse.redirect(signInUrl);
      clearAuthSessionCookies(redirectResponse);
      return applySecurityHeaders(redirectResponse, options);
    }
  }

  return applySecurityHeaders(intlResponse, options);
}

async function handleApiAuth(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Handle CORS preflight for API routes only.
  // handleApiAuth() is already scoped to /api/* by the caller (proxy()).
  // If a future route needs OPTIONS for business logic, add an exclusion here.
  if (request.method === "OPTIONS") {
    return handlePreflight(request);
  }

  // Routes that accept extension token (Bearer) as alternative auth.
  // Let the route handler validate the token instead of checking session.
  // IMPROVE(#39): harden allowlist matching — add edge-case tests for child paths
  const extensionTokenRoutes = [
    API_PATH.PASSWORDS,
    API_PATH.VAULT_UNLOCK_DATA,
    API_PATH.EXTENSION_TOKEN,         // DELETE (revoke) — validated by route handler
    API_PATH.EXTENSION_TOKEN_REFRESH, // POST (refresh) — validated by route handler
  ];
  const hasBearer = request.headers
    .get("authorization")
    ?.startsWith("Bearer ");
  const isBearerBypassRoute = (route: string) => {
    // Extension token endpoints should be exact only.
    if (
      route === API_PATH.EXTENSION_TOKEN ||
      route === API_PATH.EXTENSION_TOKEN_REFRESH
    ) {
      return pathname === route;
    }
    // Password/vault routes allow child paths.
    return pathname === route || pathname.startsWith(route + "/");
  };

  if (hasBearer && extensionTokenRoutes.some(isBearerBypassRoute)) {
    return applyCorsHeaders(request, NextResponse.next());
  }

  if (
    pathname.startsWith(API_PATH.PASSWORDS) ||
    pathname.startsWith(API_PATH.TAGS) ||
    pathname.startsWith(`${API_PATH.API_ROOT}/watchtower`) ||
    pathname.startsWith(API_PATH.ORGS) ||
    pathname.startsWith(API_PATH.AUDIT_LOGS) ||
    pathname.startsWith(API_PATH.SHARE_LINKS) ||
    pathname.startsWith(API_PATH.EMERGENCY_ACCESS) ||
    pathname.startsWith(`${API_PATH.API_ROOT}/extension`)
  ) {
    const hasSession = await hasValidSession(request);
    if (!hasSession) {
      return applyCorsHeaders(
        request,
        NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 }),
      );
    }
  }

  return applyCorsHeaders(request, NextResponse.next());
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
    const sessionUrl = new URL(API_PATH.AUTH_SESSION, request.url);
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
      endpoints: [{ url: API_PATH.CSP_REPORT }],
      include_subdomains: true,
    })
  );
  response.headers.set(
    "Reporting-Endpoints",
    `csp-endpoint="${API_PATH.CSP_REPORT}"`
  );

  response.cookies.set("csp-nonce", nonce, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });

  return response;
}

function clearAuthSessionCookies(response: NextResponse): void {
  const authSessionCookieNames = [
    "authjs.session-token",
    "__Secure-authjs.session-token",
    "next-auth.session-token",
    "__Secure-next-auth.session-token",
  ] as const;

  for (const name of authSessionCookieNames) {
    response.cookies.delete(name);
  }
}
