import createIntlMiddleware from "next-intl/middleware";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { routing } from "../../i18n/routing";
import { getLocaleFromPathname, stripLocalePrefix } from "../../i18n/locale-utils";
import { API_PATH } from "../constants";
import { AUDIT_ACTION } from "../constants/audit/audit";
import { MS_PER_DAY, MS_PER_MINUTE } from "../constants/time";
import { applySecurityHeaders } from "./security-headers";
import { getSessionInfo } from "./auth-gate";
import { extractClientIp } from "../auth/policy/ip-access";
import { checkAccessRestrictionWithAudit } from "../auth/policy/access-restriction";

export type ProxyOptions = {
  cspHeader: string;
  nonce: string;
};

const intlMiddleware = createIntlMiddleware(routing);

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
export const PASSKEY_AUDIT_DEDUP_MS = 5 * MS_PER_MINUTE;
export const PASSKEY_AUDIT_MAP_MAX = 1000;
export const passkeyAuditEmitted = new Map<string, number>();

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
export function recordPasskeyAuditEmit(userId: string, now: number): boolean {
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
