import createIntlMiddleware from "next-intl/middleware";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { routing } from "../../i18n/routing";
import { getLocaleFromPathname, stripLocalePrefix } from "../../i18n/locale-utils";
import { PASSKEY_PAGE_PATH } from "../constants/auth/page-path";
import { applySecurityHeaders } from "./security-headers";
import { buildCspHeader } from "../security/csp-builder";
import { consentFormActionSources } from "../security/consent-form-action";
import { getSessionInfo } from "./auth-gate";
import { auditSessionPasskeyBlock } from "./session-passkey-gate";
import { getLogger } from "../logger";
import { errorLogFields } from "../logger/error-fields";
import {
  ALL_KNOWN_SESSION_COOKIE_NAMES,
  configuredSessionCookieName,
  isSecureCookieFromAuthUrl,
} from "../auth/session/cookie-name";
import { sessionCookieDeletionLine } from "../auth/session/session-cookie-variants";
import {
  parseCookiePairs,
  readSessionCookie,
  SESSION_COOKIE_READ,
} from "../auth/session/session-cookie";
import { extractClientIp } from "../auth/policy/ip-access";
import { checkAccessRestrictionWithAudit } from "../auth/policy/access-restriction";
import { passkeyEnforcementBlocks } from "../auth/policy/passkey-enforcement";

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
  PASSKEY_PAGE_PATH,
]);

function isPasskeyExemptPath(pathWithoutLocale: string): boolean {
  return PASSKEY_EXEMPT_PATHS.has(pathWithoutLocale);
}

/**
 * The page-navigation `PASSKEY_ENFORCEMENT_BLOCKED` row's `blockedPath`, and
 * its limiter key. A closed set, never the requested path: the path past the
 * area prefix is caller-chosen text (and may carry IDs), which must not reach
 * a tenant-readable audit row or mint a limiter key per URL.
 */
function pageBlockedPath(pathWithoutLocale: string): string {
  return pathWithoutLocale.startsWith("/admin") ? "PAGE /admin" : "PAGE /dashboard";
}

function clearAuthSessionCookies(
  response: NextResponse,
  basePath: string = "",
  extraNames: readonly string[] = [],
): readonly string[] {
  const cookiePath = `${basePath}/`;
  // Mirror the set-time attributes. The `__Secure-` / `__Host-` prefixes
  // require the Secure attribute on Set-Cookie per RFC 6265bis §4.1.3.1/3.2,
  // so a bare-options delete is silently ignored by browsers for the
  // prefixed names and the cookie persists. Call `isSecureCookieFromAuthUrl()`
  // at delete-time (not module-evaluated) so test env stubs are honored.
  const useSecureCookies = isSecureCookieFromAuthUrl();
  // A CHIPS browser stores a partitioned and an unpartitioned cookie of the
  // same name side by side and sends both, older first, and the reader takes
  // the first. Which variants a browser holds depends on every value
  // COOKIE_PARTITIONED has had, not the current one: a flip either way, or a
  // session issued before passkey sign-in honoured the flag, leaves the other
  // variant behind. Deleting only the current variant would remove the valid
  // cookie and loop the user back here, so the configured name is deleted both
  // ways whenever it can be partitioned at all (Partitioned requires Secure).
  // A browser without CHIPS sees two deletions of the same cookie. Only the
  // configured name is ever Auth.js-set; the other known names and the
  // ambiguity strays get one unpartitioned deletion.
  const configuredName = configuredSessionCookieName();
  for (const name of [...ALL_KNOWN_SESSION_COOKIE_NAMES, ...extraNames]) {
    response.cookies.delete({
      name,
      path: cookiePath,
      secure: useSecureCookies,
      httpOnly: true,
      sameSite: "lax",
      ...(useSecureCookies && name === configuredName ? { partitioned: true } : {}),
    });
  }
  if (!useSecureCookies) return [];
  // ResponseCookies holds one entry per name, so the unpartitioned deletion is
  // returned as a raw header for the caller to append after the last
  // `response.cookies` write, which would otherwise rewrite it away.
  return [sessionCookieDeletionLine(configuredName, basePath, false)];
}

/**
 * The request cookies that made the session cookie ambiguous: every key that
 * starts with the configured name (a chunk `<name>.0`, `<name>X`). Deleting
 * only the exact known names would leave such a stray behind, and every
 * later request would be refused again. Empty when the header is not
 * ambiguous, so a refusal for any other reason deletes nothing extra.
 *
 * Only cookies this response can address go away: a deletion matches name,
 * path and domain, and it is sent host-only at `${basePath}/`. A cookie set
 * at another path or with `Domain=` (a sibling subdomain) cannot be deleted
 * from here and keeps the request refused until it expires or is cleared in
 * the browser.
 */
function ambiguousSessionCookieNames(cookieHeader: string | null): string[] {
  if (readSessionCookie(cookieHeader).kind !== SESSION_COOKIE_READ.AMBIGUOUS) return [];
  const name = configuredSessionCookieName();
  return [
    ...new Set(
      parseCookiePairs(cookieHeader ?? "")
        .map((pair) => pair.key)
        .filter((key) => key.startsWith(name)),
    ),
  ];
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
      const unpartitionedDeletions = clearAuthSessionCookies(
        redirectResponse,
        basePath,
        ambiguousSessionCookieNames(request.headers.get("cookie")),
      );
      const securedResponse = applySecurityHeaders(redirectResponse, options, basePath);
      for (const line of unpartitionedDeletions) {
        securedResponse.headers.append("set-cookie", line);
      }
      return securedResponse;
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
    // A degraded bundle (the session callback could not read the passkey
    // state) is an outage, not a requirement: neither redirect nor audit it,
    // and let the navigation reach the layouts, which re-check with a fresh
    // auth() and render a retry state.
    if (
      !session.passkeyStateDegraded &&
      passkeyEnforcementBlocks(session) &&
      !isPasskeyExemptPath(pathWithoutLocale)
    ) {
      const securityUrl = request.nextUrl.clone();
      securityUrl.pathname = `/${locale}${PASSKEY_PAGE_PATH}`;

      // Not awaited: the redirect waits on neither the limiter (Redis) nor the
      // outbox write, and a failed write is logged, never turned into an
      // error response. The shared limiter dedups per user and area. A valid
      // session with a userId always carries its tenant: getSessionInfo
      // refuses one whose tenant does not resolve, and the session cache
      // evicts a positive entry without one. The check narrows the type.
      if (session.userId && session.tenantId) {
        void auditSessionPasskeyBlock({
          req: request,
          userId: session.userId,
          tenantId: session.tenantId,
          blockedPath: pageBlockedPath(pathWithoutLocale),
        }).catch((err: unknown) => {
          getLogger().error({
            msg: "page-route: passkey enforcement audit write failed",
            error: errorLogFields(err),
          });
        });
      }

      return applySecurityHeaders(
        NextResponse.redirect(securityUrl),
        options,
        basePath,
      );
    }
  }

  // The MCP consent page is the one route whose form may legitimately redirect
  // off-origin: its POST answers a 302 to the client's registered callback, and
  // `form-action` constrains that chain. The base policy lists only `'self'`
  // and loopback, so a hosted client's callback is admitted here, for this
  // response, from the STORED registration — never from the request. See
  // consent-form-action.ts for why the alternative (`https:` in the base
  // policy) is not acceptable.
  const extraFormAction = await consentFormActionSources(
    pathWithoutLocale,
    request.nextUrl.searchParams,
  );
  if (extraFormAction.length > 0) {
    return applySecurityHeaders(
      intlResponse,
      { ...options, cspHeader: buildCspHeader(options.nonce, extraFormAction) },
      basePath,
    );
  }

  return applySecurityHeaders(intlResponse, options, basePath);
}
