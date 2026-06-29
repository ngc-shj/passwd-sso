import createIntlMiddleware from "next-intl/middleware";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { routing } from "../../i18n/routing";
import { getLocaleFromPathname, stripLocalePrefix } from "../../i18n/locale-utils";
import { API_PATH } from "../constants";
import { AUDIT_ACTION } from "../constants/audit/audit";
import { applySecurityHeaders } from "./security-headers";
import { getSessionInfo } from "./auth-gate";
import {
  ALL_KNOWN_SESSION_COOKIE_NAMES,
  isSecureCookieFromAuthUrl,
} from "../auth/session/cookie-name";
import { extractClientIp } from "../auth/policy/ip-access";
import { checkAccessRestrictionWithAudit } from "../auth/policy/access-restriction";
import {
  isPasskeyGracePeriodExpired,
  recordPasskeyAuditEmit,
  PASSKEY_AUDIT_DEDUP_MS,
  PASSKEY_AUDIT_MAP_MAX,
  _resetPasskeyAuditForTests,
  _passkeyAuditSizeForTests,
  _passkeyAuditHasForTests,
  _passkeyAuditFirstKeyForTests,
} from "../auth/policy/passkey-enforcement";

export {
  isPasskeyGracePeriodExpired,
  recordPasskeyAuditEmit,
  PASSKEY_AUDIT_DEDUP_MS,
  PASSKEY_AUDIT_MAP_MAX,
  _resetPasskeyAuditForTests,
  _passkeyAuditSizeForTests,
  _passkeyAuditHasForTests,
  _passkeyAuditFirstKeyForTests,
};

export type ProxyOptions = {
  cspHeader: string;
  nonce: string;
};

const intlMiddleware = createIntlMiddleware(routing);

// Paths exempt from passkey enforcement to prevent registration loops.
// Narrowly scoped to the passkey registration page itself — vault-sensitive
// pages (passphrase, recovery key) MUST stay gated so a passkey-pending user
// cannot bypass MFA by reaching them while enforcement is in flight.
//
// Exact-match (Set), NOT prefix-match: a future sibling like
// `/dashboard/settings/auth/passkey-recovery` would otherwise silently
// inherit the bypass.
const PASSKEY_EXEMPT_PATHS: ReadonlySet<string> = new Set([
  "/dashboard/settings/auth/passkey",
]);

function isPasskeyExemptPath(pathWithoutLocale: string): boolean {
  return PASSKEY_EXEMPT_PATHS.has(pathWithoutLocale);
}

function clearAuthSessionCookies(response: NextResponse, basePath: string = ""): void {
  const cookiePath = `${basePath}/`;
  // Mirror the set-time attributes. The `__Secure-` / `__Host-` prefixes
  // require the Secure attribute on Set-Cookie per RFC 6265bis §4.1.3.1/3.2,
  // so a bare-options delete is silently ignored by browsers for the
  // prefixed names and the cookie persists. Call `isSecureCookieFromAuthUrl()`
  // at delete-time (not module-evaluated) so test env stubs are honored.
  const useSecureCookies = isSecureCookieFromAuthUrl();
  for (const name of ALL_KNOWN_SESSION_COOKIE_NAMES) {
    response.cookies.delete({
      name,
      path: cookiePath,
      secure: useSecureCookies,
      httpOnly: true,
      sameSite: "lax",
    });
  }
}

export async function handlePageRoute(
  request: NextRequest,
  options: ProxyOptions,
): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
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
        securityUrl.pathname = `/${locale}/dashboard/settings/auth/passkey`;

        // Fire-and-forget audit log — deduplicated per user to avoid flood on repeated redirects
        const userId = session.userId ?? "";
        if (recordPasskeyAuditEmit(userId, pathWithoutLocale, Date.now())) {
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
