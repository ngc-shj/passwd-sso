import createIntlMiddleware from "next-intl/middleware";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { routing } from "./i18n/routing";
import { getLocaleFromPathname, stripLocalePrefix } from "./i18n/locale-utils";
import { API_PATH } from "./lib/constants";
import { AUDIT_ACTION } from "./lib/constants/audit/audit";
import { MS_PER_DAY, MS_PER_MINUTE } from "./lib/constants/time";
import {
  applyCorsHeaders,
  handleApiPreflight,
  isBearerBypassRoute,
} from "./lib/proxy/cors-gate";
import { applySecurityHeaders } from "./lib/proxy/security-headers";
import {
  getSessionInfo,
  setSessionCache,
  extractSessionToken,
  hasSessionCookie,
  sessionCache,
} from "./lib/proxy/auth-gate";
import { classifyRoute, ROUTE_POLICY_KIND } from "./lib/proxy/route-policy";
import { shouldEnforceCsrf, assertSessionCsrf } from "./lib/proxy/csrf-gate";
import { extractClientIp } from "./lib/auth/policy/ip-access";
import { checkAccessRestrictionWithAudit } from "./lib/auth/policy/access-restriction";

const intlMiddleware = createIntlMiddleware(routing);

type ProxyOptions = {
  cspHeader: string;
  nonce: string;
};

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

/**
 * Record a passkey-enforcement audit emit for `userId` at `now`. Returns
 * `true` if the caller should fire the audit, `false` if the user has
 * already been audited within `PASSKEY_AUDIT_DEDUP_MS`.
 *
 * Eviction is staleness-based, not insertion-order: when the dedup map is
 * full, the user whose `lastEmitted` is oldest is evicted. This is achieved
 * by `delete`-then-`set` on every accepted emit so JS Map insertion order
 * (which is what `keys().next()` returns) tracks last-emit recency rather
 * than first-emit time.
 *
 * Boundary: `now - lastEmitted === PASSKEY_AUDIT_DEDUP_MS` deduplicates
 * (the inclusive `<=` window matches "within 5 minutes"). The original
 * inline form used the exclusive `>` form, which would fire at exactly the
 * boundary; the 1 ms shift here is intentional and tested at
 * `proxy.test.ts` `passkeyAuditEmitted staleness eviction` describe block.
 */
function recordPasskeyAuditEmit(userId: string, now: number): boolean {
  const lastEmitted = passkeyAuditEmitted.get(userId);
  // Use !== undefined rather than truthy check so a literal-zero timestamp
  // (theoretically possible if an alternate clock source is ever wired in)
  // does not bypass dedup as if it were a first emit.
  if (lastEmitted !== undefined && now - lastEmitted <= PASSKEY_AUDIT_DEDUP_MS) {
    return false;
  }
  // Refresh insertion order so the head is always the staleness candidate.
  passkeyAuditEmitted.delete(userId);
  if (passkeyAuditEmitted.size >= PASSKEY_AUDIT_MAP_MAX) {
    const oldest = passkeyAuditEmitted.keys().next().value;
    if (oldest !== undefined) passkeyAuditEmitted.delete(oldest);
  }
  passkeyAuditEmitted.set(userId, now);
  return true;
}

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
        if (recordPasskeyAuditEmit(userId, Date.now())) {
          // Internal self-fetch: declare same-origin explicitly. Node
          // fetch (undici) does not auto-set Origin; without it the new
          // proxy CSRF gate would 403 this request.
          const selfOrigin = new URL(request.url).origin;
          void fetch(new URL(`${basePath}${API_PATH.INTERNAL_AUDIT_EMIT}`, request.url), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Origin": selfOrigin,
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
  const policy = classifyRoute(pathname);
  // Bearer-bypass eligibility is a code-path concern (which dispatch
  // branch the orchestrator takes), not a classification concern. Routes
  // that accept Bearer as alternative auth are still classified as
  // api-session-required; we ask cors-gate directly whether the bypass
  // dispatch is eligible for this specific path.
  const isBearerRoute = isBearerBypassRoute(pathname);
  const isExchangeRoute = policy.kind === ROUTE_POLICY_KIND.API_EXTENSION_EXCHANGE;

  // Preflight (handled regardless of policy.kind).
  if (request.method === "OPTIONS") {
    return handleApiPreflight(request, { isBearerRoute, isExchangeRoute });
  }

  // Non-CSRF early returns. ALL paths outside the cookie-CSRF threat
  // model MUST short-circuit BEFORE the CSRF gate fires.
  if (policy.kind === ROUTE_POLICY_KIND.PUBLIC_SHARE) {
    const res = NextResponse.next();
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
  if (policy.kind === ROUTE_POLICY_KIND.PUBLIC_RECEIVER) {
    return NextResponse.next();
  }
  if (policy.kind === ROUTE_POLICY_KIND.API_V1) {
    const res = NextResponse.next();
    res.headers.set("Cache-Control", "private, no-store");
    return res;
  }

  // Baseline CSRF gate: request-attribute-based, path-independent.
  // Fires whenever a request carries a session cookie AND uses a
  // mutating method, regardless of route classification. This closes
  // pre1 (audit-emit) and the R3 baseline gap structurally.
  const cookieHeader = request.headers.get("cookie") ?? "";
  const cookiePresent = hasSessionCookie(cookieHeader);
  if (shouldEnforceCsrf(request, cookiePresent)) {
    const csrfError = assertSessionCsrf(request);
    if (csrfError) return applyCorsHeaders(request, csrfError);
  }

  const hasBearer = request.headers
    .get("authorization")
    ?.startsWith("Bearer ");

  // Bearer-bypass only applies when no session cookie is present. If both
  // are sent, authOrToken prefers session (auth-or-token.ts:64-68) and the
  // tenant IP restriction must still gate the request — falling through to
  // the session-authenticated path below enforces it. Legitimate Bearer-
  // only clients (extension from chrome-extension:// origin, API key
  // clients, SA / MCP tokens) do not ship the Auth.js session cookie, so
  // the bypass still applies to them.
  if (hasBearer && isBearerRoute && !cookiePresent) {
    const res = NextResponse.next();
    res.headers.set("Cache-Control", "private, no-store");
    return applyCorsHeaders(request, res, { allowExtension: true });
  }

  // POST /api/extension/token/exchange — bootstraps a bearer token from a
  // one-time bridge code. No session, no Bearer. Called by the extension
  // content script (isolated world). The route handler validates the code
  // and atomically consumes it. CORS must allow chrome-extension origins.
  if (isExchangeRoute) {
    const res = NextResponse.next();
    res.headers.set("Cache-Control", "private, no-store");
    return applyCorsHeaders(request, res, { allowExtension: true });
  }

  // Session-required routes. Bearer-bypass-eligible routes that didn't
  // take the bypass branch above (e.g., session-cookie-only callers to
  // /api/passwords) flow through here too, since they're classified as
  // api-session-required by route-policy. Note: /api/scim/v2/* is
  // intentionally NOT in this classification — SCIM endpoints use their
  // own Bearer token auth in each route handler.
  if (policy.kind === ROUTE_POLICY_KIND.API_SESSION_REQUIRED) {
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

  // Default (api-default): prevent CDN/proxy from caching authenticated
  // API responses. Route handlers may override with explicit
  // Cache-Control headers.
  const res = NextResponse.next();
  res.headers.set("Cache-Control", "private, no-store");
  return applyCorsHeaders(request, res);
}

// Test-only shims: re-export from new module locations so existing tests
// (src/__tests__/proxy.test.ts) continue to import via this path.
export { applySecurityHeaders as _applySecurityHeaders };
export { extractSessionToken as _extractSessionToken };
export { setSessionCache as _setSessionCache };
export { sessionCache as _sessionCache };
export { passkeyAuditEmitted as _passkeyAuditEmitted };
export { PASSKEY_AUDIT_MAP_MAX as _PASSKEY_AUDIT_MAP_MAX };
export { PASSKEY_AUDIT_DEDUP_MS as _PASSKEY_AUDIT_DEDUP_MS };
export { recordPasskeyAuditEmit as _recordPasskeyAuditEmit };

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
