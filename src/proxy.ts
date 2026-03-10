import createIntlMiddleware from "next-intl/middleware";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { routing } from "./i18n/routing";
import { getLocaleFromPathname, stripLocalePrefix } from "./i18n/locale-utils";
import { API_PATH } from "./lib/constants";
import { handlePreflight, applyCorsHeaders } from "./lib/cors";
import { isHttps } from "./lib/url-helpers";
import { extractClientIp } from "./lib/ip-access";
import { checkAccessRestrictionWithAudit } from "./lib/access-restriction";
import { resolveUserTenantId } from "./lib/tenant-context";

const intlMiddleware = createIntlMiddleware(routing);

type ProxyOptions = {
  cspHeader: string;
  nonce: string;
};

const SESSION_CACHE_TTL_MS = 30_000;
const SESSION_CACHE_MAX = 500;

interface SessionInfo {
  valid: boolean;
  userId?: string;
  tenantId?: string;
}

const sessionCache = new Map<string, { expiresAt: number } & SessionInfo>();

export async function proxy(request: NextRequest, options: ProxyOptions) {
  const { pathname } = request.nextUrl;

  // Skip i18n for API routes
  if (pathname.startsWith(`${API_PATH.API_ROOT}/`)) {
    return handleApiAuth(request);
  }

  const basePath = request.nextUrl.basePath;

  // Public share pages — skip i18n and auth
  if (pathname.startsWith("/s/")) {
    return applySecurityHeaders(NextResponse.next(), options, basePath);
  }

  // Run next-intl middleware (locale detection, prefix redirect)
  const intlResponse = intlMiddleware(request);

  // If next-intl returned a redirect, let it through
  if (intlResponse.status !== 200) {
    return applySecurityHeaders(intlResponse, options, basePath);
  }

  // Extract locale and path without locale prefix
  const locale = getLocaleFromPathname(pathname);
  const pathWithoutLocale = stripLocalePrefix(pathname);

  // Auth check for protected routes
  if (pathWithoutLocale.startsWith("/dashboard")) {
    const session = await getSessionInfo(request);
    if (!session.valid) {
      const signInUrl = request.nextUrl.clone();
      signInUrl.pathname = `/${locale}/auth/signin`;
      signInUrl.searchParams.set("callbackUrl", `${basePath}${request.nextUrl.pathname}${request.nextUrl.search}`);
      const redirectResponse = NextResponse.redirect(signInUrl);
      clearAuthSessionCookies(redirectResponse, basePath);
      return applySecurityHeaders(redirectResponse, options, basePath);
    }

    // Access restriction check for dashboard routes
    if (session.tenantId) {
      const clientIp = extractClientIp(request);
      const accessResult = await checkAccessRestrictionWithAudit(
        session.tenantId,
        clientIp,
        session.userId ?? null,
        request,
      );
      if (!accessResult.allowed) {
        return applySecurityHeaders(
          new NextResponse("Forbidden", { status: 403 }),
          options,
          basePath,
        );
      }
    }
  }

  return applySecurityHeaders(intlResponse, options, basePath);
}

async function handleApiAuth(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Routes that accept extension token (Bearer) as alternative auth.
  // Let the route handler validate the token instead of checking session.
  // IMPROVE(#39): harden allowlist matching — add edge-case tests for child paths
  const extensionTokenRoutes = [
    API_PATH.PASSWORDS,
    API_PATH.VAULT_STATUS,
    API_PATH.VAULT_UNLOCK_DATA,
    API_PATH.EXTENSION_TOKEN,         // DELETE (revoke) — validated by route handler
    API_PATH.EXTENSION_TOKEN_REFRESH, // POST (refresh) — validated by route handler
    API_PATH.API_KEYS,  // API key management — validated by route handler via authOrToken
  ];
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
  const isBearerRoute = extensionTokenRoutes.some(isBearerBypassRoute);

  // Handle CORS preflight for API routes.
  // For extension Bearer routes, allow chrome-extension:// origins so that
  // Service Worker fetch (which triggers preflight due to Authorization header)
  // can proceed.
  if (request.method === "OPTIONS") {
    return handlePreflight(request, { allowExtension: isBearerRoute });
  }

  // /api/v1/* — Public REST API. Skip session redirect and assertOrigin.
  // Route handlers handle all auth via validateApiKeyOnly().
  if (pathname.startsWith(`${API_PATH.API_ROOT}/v1/`)) {
    return NextResponse.next();
  }

  const hasBearer = request.headers
    .get("authorization")
    ?.startsWith("Bearer ");

  if (hasBearer && isBearerRoute) {
    return applyCorsHeaders(request, NextResponse.next(), { allowExtension: true });
  }

  // Note: /api/scim/v2/* is intentionally NOT listed here — SCIM endpoints
  // use their own Bearer token auth (validateScimToken) in each route handler.
  if (
    pathname.startsWith(API_PATH.PASSWORDS) ||
    pathname.startsWith(API_PATH.TAGS) ||
    pathname.startsWith(API_PATH.WATCHTOWER) ||
    pathname.startsWith(API_PATH.TEAMS) ||
    pathname.startsWith(API_PATH.AUDIT_LOGS) ||
    pathname.startsWith(API_PATH.SHARE_LINKS) ||
    pathname.startsWith(API_PATH.SENDS) ||
    pathname.startsWith(API_PATH.EMERGENCY_ACCESS) ||
    pathname.startsWith(API_PATH.SESSIONS) ||
    pathname.startsWith(API_PATH.NOTIFICATIONS) ||
    pathname.startsWith(API_PATH.USER_LOCALE) ||
    pathname.startsWith(API_PATH.EXTENSION) ||
    pathname.startsWith(API_PATH.TENANT) ||
    pathname.startsWith(API_PATH.API_KEYS) ||
    pathname.startsWith(API_PATH.TRAVEL_MODE) ||
    pathname.startsWith(API_PATH.DIRECTORY_SYNC) ||
    pathname.startsWith(API_PATH.WEBAUTHN)
  ) {
    const session = await getSessionInfo(request);
    if (!session.valid) {
      return applyCorsHeaders(
        request,
        NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 }),
      );
    }

    // Access restriction check for session-authenticated API routes
    if (session.tenantId) {
      const clientIp = extractClientIp(request);
      const accessResult = await checkAccessRestrictionWithAudit(
        session.tenantId,
        clientIp,
        session.userId ?? null,
        request,
      );
      if (!accessResult.allowed) {
        return applyCorsHeaders(
          request,
          NextResponse.json({ error: "ACCESS_DENIED" }, { status: 403 }),
        );
      }
    }
  }

  return applyCorsHeaders(request, NextResponse.next());
}

async function getSessionInfo(request: NextRequest): Promise<SessionInfo> {
  const cookie = request.headers.get("cookie");
  if (!cookie) return { valid: false };

  const cacheKey = await hashCookie(cookie);
  const cached = sessionCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { valid: cached.valid, userId: cached.userId, tenantId: cached.tenantId };
  }
  if (cached) sessionCache.delete(cacheKey);

  try {
    const sessionUrl = new URL(
      `${request.nextUrl.basePath}${API_PATH.AUTH_SESSION}`,
      request.url,
    );
    const res = await fetch(sessionUrl, {
      headers: { cookie },
    });
    if (!res.ok) {
      setSessionCache(cacheKey, { valid: false });
      return { valid: false };
    }
    const data = await res.json();
    const valid = !!data?.user;
    const userId = data?.user?.id ?? undefined;

    // Resolve tenant ID for access restriction checks
    let tenantId: string | undefined;
    if (valid && userId) {
      try {
        tenantId = (await resolveUserTenantId(userId)) ?? undefined;
      } catch {
        // Non-critical: tenant resolution failure should not block session validation
      }
    }

    const info: SessionInfo = { valid, userId, tenantId };
    setSessionCache(cacheKey, info);
    return info;
  } catch {
    return { valid: false };
  }
}

function setSessionCache(key: string, info: SessionInfo) {
  if (sessionCache.size >= SESSION_CACHE_MAX) {
    sessionCache.clear();
  }
  sessionCache.set(key, {
    expiresAt: Date.now() + SESSION_CACHE_TTL_MS,
    ...info,
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
  { cspHeader, nonce }: ProxyOptions,
  basePath: string = "",
): NextResponse {
  response.headers.set("Content-Security-Policy", cspHeader);
  const cspReportUrl = `${basePath}${API_PATH.CSP_REPORT}`;
  response.headers.set(
    "Report-To",
    JSON.stringify({
      group: "csp-endpoint",
      max_age: 10886400,
      endpoints: [{ url: cspReportUrl }],
      include_subdomains: true,
    })
  );
  response.headers.set(
    "Reporting-Endpoints",
    `csp-endpoint="${cspReportUrl}"`
  );

  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  if (isHttps) {
    response.headers.set(
      "Strict-Transport-Security",
      "max-age=63072000; includeSubDomains; preload"
    );
  }
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=()"
  );

  response.cookies.set("csp-nonce", nonce, {
    httpOnly: true,
    sameSite: "lax",
    path: `${basePath}/`,
  });

  return response;
}

// Exported for testing
export { applySecurityHeaders as _applySecurityHeaders };

function clearAuthSessionCookies(response: NextResponse, basePath: string = ""): void {
  const authSessionCookieNames = [
    "authjs.session-token",
    "__Secure-authjs.session-token",
    "next-auth.session-token",
    "__Secure-next-auth.session-token",
  ] as const;

  const cookiePath = `${basePath}/`;
  for (const name of authSessionCookieNames) {
    response.cookies.delete({ name, path: cookiePath });
  }
}
