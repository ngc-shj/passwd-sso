import createIntlMiddleware from "next-intl/middleware";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { routing } from "./i18n/routing";
import { getLocaleFromPathname, stripLocalePrefix } from "./i18n/locale-utils";
import { API_PATH } from "./lib/constants";
import { AUDIT_ACTION } from "./lib/constants/audit";
import { MS_PER_DAY, MS_PER_MINUTE } from "./lib/constants/time";
import { PERMISSIONS_POLICY } from "./lib/security-headers";
import { handlePreflight, applyCorsHeaders } from "./lib/cors";
import { isHttps } from "./lib/url-helpers";
import { extractClientIp } from "./lib/ip-access";
import { checkAccessRestrictionWithAudit } from "./lib/access-restriction";
import { resolveUserTenantId } from "./lib/tenant-context";
import { SESSION_CACHE_MAX } from "./lib/validations/common.server";

const intlMiddleware = createIntlMiddleware(routing);

type ProxyOptions = {
  cspHeader: string;
  nonce: string;
};

const SESSION_CACHE_TTL_MS = 30_000;

// Paths exempt from passkey enforcement to prevent registration loops.
// Must include the security settings page and all WebAuthn/auth API routes.
const PASSKEY_EXEMPT_PREFIXES = [
  "/dashboard/settings/security",
];

function isPasskeyExemptPath(pathWithoutLocale: string): boolean {
  return PASSKEY_EXEMPT_PREFIXES.some((prefix) => pathWithoutLocale.startsWith(prefix));
}

function isPasskeyGracePeriodExpired(
  requirePasskeyEnabledAt: string | null | undefined,
  passkeyGracePeriodDays: number | null | undefined,
): boolean {
  // No enabledAt timestamp means enforcement was just turned on; treat as immediate.
  if (!requirePasskeyEnabledAt) return true;
  // No grace period configured means immediate enforcement.
  if (passkeyGracePeriodDays == null || passkeyGracePeriodDays <= 0) return true;

  const enabledAt = new Date(requirePasskeyEnabledAt).getTime();
  const gracePeriodMs = passkeyGracePeriodDays * MS_PER_DAY;
  return Date.now() > enabledAt + gracePeriodMs;
}

// Deduplicate passkey audit emit — track userId+timestamp, skip if emitted within 5 min
const PASSKEY_AUDIT_DEDUP_MS = 5 * MS_PER_MINUTE;
const PASSKEY_AUDIT_MAP_MAX = 1000;
const passkeyAuditEmitted = new Map<string, number>();

interface SessionInfo {
  valid: boolean;
  userId?: string;
  tenantId?: string;
  hasPasskey?: boolean;
  requirePasskey?: boolean;
  requirePasskeyEnabledAt?: string | null;
  passkeyGracePeriodDays?: number | null;
}

// In-process session cache: keyed by the raw session token value (not hashed, to avoid
// per-request SHA-256 overhead). Known trade-offs:
//   - Multi-worker gap: each Node.js worker process holds an independent cache instance.
//     Session revocation on one worker takes up to SESSION_CACHE_TTL_MS (30 s) to propagate
//     to other workers. For single-process deployments this is not an issue.
//   - Plaintext keys: the session token is stored as-is in process memory. A heap snapshot
//     would expose tokens. Future improvement: migrate to a shared Redis cache with hashed keys.
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

  // Auth check for protected routes (/dashboard/* and /admin/*)
  if (pathWithoutLocale.startsWith("/dashboard") || pathWithoutLocale.startsWith("/admin")) {
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

    // MFA (passkey) enforcement: redirect users without a registered passkey
    // when the tenant requires it and the grace period has expired.
    // Skip for the security settings page and WebAuthn/auth routes to prevent loops.
    if (
      session.requirePasskey &&
      !session.hasPasskey &&
      !isPasskeyExemptPath(pathWithoutLocale)
    ) {
      if (isPasskeyGracePeriodExpired(session.requirePasskeyEnabledAt, session.passkeyGracePeriodDays)) {
        const securityUrl = request.nextUrl.clone();
        securityUrl.pathname = `/${locale}/dashboard/settings/security`;

        // Fire-and-forget audit log — deduplicated per user to avoid flood on repeated redirects
        const userId = session.userId ?? "";
        const lastEmitted = passkeyAuditEmitted.get(userId);
        if (!lastEmitted || Date.now() - lastEmitted > PASSKEY_AUDIT_DEDUP_MS) {
          if (passkeyAuditEmitted.size >= PASSKEY_AUDIT_MAP_MAX) {
            // Evict oldest entry to prevent unbounded growth
            const oldest = passkeyAuditEmitted.keys().next().value;
            if (oldest !== undefined) passkeyAuditEmitted.delete(oldest);
          }
          passkeyAuditEmitted.set(userId, Date.now());
          void fetch(new URL(`${basePath}${API_PATH.INTERNAL_AUDIT_EMIT}`, request.url), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              cookie: request.headers.get("cookie") ?? "",
            },
            body: JSON.stringify({
              action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED,
              metadata: { blockedPath: pathWithoutLocale },
            }),
          }).catch(() => {});
        }

        return applySecurityHeaders(
          NextResponse.redirect(securityUrl),
          options,
          basePath,
        );
      }
      // Within grace period: allow through; client reads /api/user/passkey-status for banner
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
    API_PATH.TENANT_ACCESS_REQUESTS, // SA self-service JIT — validated by route handler via authOrToken
    API_PATH.VAULT_DELEGATION,       // Delegation check — CLI agent uses Bearer for /check
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
  // For extension Bearer routes AND the bridge code exchange endpoint, allow
  // chrome-extension:// origins so that the extension's fetch (which triggers
  // a preflight due to Content-Type/Authorization headers) can proceed.
  const isExtensionExchangeRoute = pathname === API_PATH.EXTENSION_TOKEN_EXCHANGE;
  if (request.method === "OPTIONS") {
    return handlePreflight(request, {
      allowExtension: isBearerRoute || isExtensionExchangeRoute,
    });
  }

  // /api/v1/* — Public REST API. Skip session redirect and assertOrigin.
  // Route handlers handle all auth via validateApiKeyOnly().
  if (pathname.startsWith(`${API_PATH.API_ROOT}/v1/`)) {
    const res = NextResponse.next();
    res.headers.set("Cache-Control", "private, no-store");
    return res;
  }

  const hasBearer = request.headers
    .get("authorization")
    ?.startsWith("Bearer ");

  if (hasBearer && isBearerRoute) {
    const res = NextResponse.next();
    res.headers.set("Cache-Control", "private, no-store");
    return applyCorsHeaders(request, res, { allowExtension: true });
  }

  // POST /api/extension/token/exchange — bootstraps a bearer token from a
  // one-time bridge code. No session, no Bearer. Called by the extension
  // content script (isolated world). The route handler validates the code
  // and atomically consumes it. CORS must allow chrome-extension origins.
  if (pathname === API_PATH.EXTENSION_TOKEN_EXCHANGE) {
    const res = NextResponse.next();
    res.headers.set("Cache-Control", "private, no-store");
    return applyCorsHeaders(request, res, { allowExtension: true });
  }

  // Public share-link endpoints for unauthenticated share viewers.
  // These use their own auth (access password / access token).
  if (
    pathname === `${API_PATH.SHARE_LINKS}/verify-access` ||
    /^\/api\/share-links\/[^/]+\/content$/.test(pathname)
  ) {
    const res = NextResponse.next();
    res.headers.set("Cache-Control", "no-store");
    return res;
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
    pathname.startsWith(API_PATH.USER_MCP_TOKENS) ||
    pathname.startsWith(API_PATH.USER_AUTH_PROVIDER) ||
    pathname.startsWith(API_PATH.EXTENSION) ||
    pathname.startsWith(API_PATH.TENANT) ||
    pathname.startsWith(API_PATH.API_KEYS) ||
    pathname.startsWith(API_PATH.TRAVEL_MODE) ||
    pathname.startsWith(API_PATH.DIRECTORY_SYNC) ||
    pathname.startsWith(API_PATH.VAULT) ||
    pathname.startsWith(API_PATH.FOLDERS) ||
    pathname.startsWith(API_PATH.WEBAUTHN)
  ) {
    const session = await getSessionInfo(request);
    if (!session.valid) {
      return applyCorsHeaders(
        request,
        NextResponse.json(
          { error: "UNAUTHORIZED" },
          { status: 401, headers: { "Cache-Control": "no-store" } },
        ),
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
          NextResponse.json(
            { error: "ACCESS_DENIED" },
            { status: 403, headers: { "Cache-Control": "no-store" } },
          ),
        );
      }
    }
  }

  // Default: prevent CDN/proxy from caching authenticated API responses.
  // Route handlers may override with explicit Cache-Control headers.
  const res = NextResponse.next();
  res.headers.set("Cache-Control", "private, no-store");
  return applyCorsHeaders(request, res);
}

async function getSessionInfo(request: NextRequest): Promise<SessionInfo> {
  const cookie = request.headers.get("cookie");
  if (!cookie) return { valid: false };

  const cacheKey = extractSessionToken(cookie);
  // If no session token cookie is present, skip cache lookup entirely
  if (!cacheKey) return { valid: false };

  const cached = sessionCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      valid: cached.valid,
      userId: cached.userId,
      tenantId: cached.tenantId,
      hasPasskey: cached.hasPasskey,
      requirePasskey: cached.requirePasskey,
      requirePasskeyEnabledAt: cached.requirePasskeyEnabledAt,
      passkeyGracePeriodDays: cached.passkeyGracePeriodDays,
    };
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
      // Non-200 from auth session endpoint is a transient server error,
      // not a definitive "session invalid" signal — do NOT cache.
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

    // Extract passkey enforcement fields from session payload
    const hasPasskey: boolean = data?.user?.hasPasskey ?? false;
    const requirePasskey: boolean = data?.user?.requirePasskey ?? false;
    const requirePasskeyEnabledAt: string | null = data?.user?.requirePasskeyEnabledAt ?? null;
    const passkeyGracePeriodDays: number | null = data?.user?.passkeyGracePeriodDays ?? null;

    const info: SessionInfo = {
      valid,
      userId,
      tenantId,
      hasPasskey,
      requirePasskey,
      requirePasskeyEnabledAt,
      passkeyGracePeriodDays,
    };
    setSessionCache(cacheKey, info);
    return info;
  } catch {
    return { valid: false };
  }
}

function setSessionCache(key: string, info: SessionInfo) {
  if (sessionCache.size >= SESSION_CACHE_MAX) {
    const now = Date.now();
    // First pass: evict all expired entries
    for (const [k, v] of sessionCache) {
      if (v.expiresAt <= now) sessionCache.delete(k);
    }
    // Second pass: if still at limit, evict the oldest entry (Map preserves insertion order)
    if (sessionCache.size >= SESSION_CACHE_MAX) {
      const oldest = sessionCache.keys().next().value;
      if (oldest !== undefined) sessionCache.delete(oldest);
    }
  }
  sessionCache.set(key, {
    expiresAt: Date.now() + SESSION_CACHE_TTL_MS,
    ...info,
  });
}

// Extract the session token value directly to use as cache key.
// This avoids SHA-256 hashing the entire cookie string on every request.
// Falls back to the full cookie string if neither known token cookie is present.
function extractSessionToken(cookie: string): string {
  // Cookie names used by Auth.js (dev and prod variants)
  const names = ["__Secure-authjs.session-token", "authjs.session-token"];
  for (const name of names) {
    const prefix = `${name}=`;
    const idx = cookie.indexOf(prefix);
    if (idx !== -1) {
      const start = idx + prefix.length;
      const end = cookie.indexOf(";", start);
      return end === -1 ? cookie.slice(start) : cookie.slice(start, end);
    }
  }
  // No session token cookie found — treat as unauthenticated (empty key)
  return "";
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
  response.headers.set("Permissions-Policy", PERMISSIONS_POLICY);

  response.cookies.set("csp-nonce", nonce, {
    httpOnly: true,
    sameSite: "lax",
    secure: isHttps,
    path: `${basePath}/`,
  });

  return response;
}

// Exported for testing
export { applySecurityHeaders as _applySecurityHeaders };
export { extractSessionToken as _extractSessionToken };
export { setSessionCache as _setSessionCache };
export { sessionCache as _sessionCache };

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
