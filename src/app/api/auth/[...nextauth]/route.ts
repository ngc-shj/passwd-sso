import { NextRequest } from "next/server";
import { handlers } from "@/auth";
import { withRequestLog } from "@/lib/http/with-request-log";
import { extractRequestMeta, logAuditAsync } from "@/lib/audit/audit";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import { sessionMetaStorage } from "@/lib/auth/session/session-meta";
import { tenantClaimStorage } from "@/lib/tenant/tenant-claim-storage";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { extractClientIp } from "@/lib/auth/policy/ip-access";
import { checkIpRateLimit } from "@/lib/security/ip-rate-limit";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { MS_PER_MINUTE } from "@/lib/constants/time";
import {
  ALL_KNOWN_SESSION_COOKIE_NAMES,
  configuredSessionCookieName,
} from "@/lib/auth/session/cookie-name";
import {
  parseCookiePairs,
  presentedSessionTokens,
  readSessionCookie,
  SESSION_COOKIE_READ,
} from "@/lib/auth/session/session-cookie";
import {
  deleteOtherSessionCookieVariantFirst,
  deletesSessionCookie,
} from "@/lib/auth/session/session-cookie-variants";
import { revokePresentedSessions } from "@/lib/auth/session/revoke-presented-sessions";
import { getLogger } from "@/lib/logger";
import { errorLogFields } from "@/lib/logger/error-fields";

export const runtime = "nodejs";

type RouteHandler = (
  request: NextRequest,
  ...rest: unknown[]
) => Promise<Response>;

/**
 * Next.js strips basePath from the URL before delivering it to route handlers,
 * but Auth.js needs the full URL (including basePath) to:
 *   1. Parse actions correctly (basePath = `${NEXT_PUBLIC_BASE_PATH}/api/auth`)
 *   2. Build OAuth callback URLs with the correct prefix
 *
 * This wrapper restores the basePath prefix that Next.js removed.
 */
function withAuthBasePath<H extends RouteHandler>(handler: H): H {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
  if (!basePath) return handler;

  const wrapped = async (request: NextRequest, ...rest: unknown[]) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(basePath)) {
      url.pathname = `${basePath}${url.pathname}`;
    }
    const patched = new NextRequest(url.toString(), {
      headers: request.headers,
      method: request.method,
      body: request.body,
      duplex: "half",
    });
    return handler(patched, ...rest);
  };
  return wrapped as unknown as H;
}

/**
 * The non-empty path segments Auth.js could be acting on, split the way its
 * parseActionAndProviderId splits them (on "/", empty segments dropped, so
 * "/api/auth//callback/x" is a callback). Two readings: the path as given,
 * and the path with a leading basePath removed. The wrappers below run inside
 * withAuthBasePath, whose rebuilt request carries the basePath unless the path
 * already started with it — as "/api/auth/..." does for a basePath of "/api".
 */
function authPathReadings(pathname: string): string[][] {
  const segments = (path: string) => path.split("/").filter(Boolean);
  const readings = [segments(pathname)];
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
  if (basePath && pathname.startsWith(`${basePath}/`)) {
    readings.push(segments(pathname.slice(basePath.length)));
  }
  return readings;
}

function withSessionMeta<H extends RouteHandler>(handler: H): H {
  const wrapped = async (request: NextRequest, ...rest: unknown[]) => {
    const meta = extractRequestMeta(request);
    return sessionMetaStorage.run(meta, () =>
      tenantClaimStorage.run({ tenantClaim: null, provider: null }, () =>
        handler(request, ...rest),
      ),
    );
  };
  return wrapped as unknown as H;
}

// ─── OAuth / SAML callback rate limit ────────────────────────
//
// Scoped to the actual callback paths only (`/api/auth/callback/*`) so:
//   - GET callbacks (Google OIDC's default response_mode=query) are covered
//     — PR #465's earlier implementation only fired on POST and missed
//     these entirely.
//   - sign-in / sign-out / csrf / session POSTs are NOT throttled —
//     enterprise NAT egresses with bursty sign-out storms used to trip
//     the previous unconditional POST gate.
//
// Per-client-IP keying delegated to the shared `checkIpRateLimit` helper
// (`src/lib/security/ip-rate-limit.ts`) — single source of truth for the
// IPv6 → /64 normalization and the null-IP fail-open + warn-log decision
// that 9 other route handlers also use.
const CALLBACK_RATE_LIMIT_WINDOW_MS = 1 * MS_PER_MINUTE;
const CALLBACK_RATE_LIMIT_MAX = 60;

const callbackRateLimiter = createRateLimiter({
  windowMs: CALLBACK_RATE_LIMIT_WINDOW_MS,
  max: CALLBACK_RATE_LIMIT_MAX,
  failClosedOnRedisError: true,
});

function isCallbackRoute(pathname: string): boolean {
  return authPathReadings(pathname).some(
    (segs) => segs.length >= 4 && segs[0] === "api" && segs[1] === "auth" && segs[2] === "callback",
  );
}

function withCallbackRateLimit<H extends RouteHandler>(handler: H): H {
  const wrapped = async (request: NextRequest, ...rest: unknown[]) => {
    if (!isCallbackRoute(request.nextUrl.pathname)) {
      return handler(request, ...rest);
    }
    const rl = await checkIpRateLimit({
      ip: extractClientIp(request),
      pathname: request.nextUrl.pathname,
      scope: "auth_callback",
      limiter: callbackRateLimiter,
      boundUnknownIp: true,
    });
    // Pre-auth surface: userId null → checkRateLimitOrFail warn-logs the
    // fail-closed (no audit row). redisErrored → 503; over-limit → 429.
    const blocked = await checkRateLimitOrFail({
      req: request,
      result: rl,
      scope: "auth_callback",
      userId: null,
    });
    if (blocked) return blocked as unknown as Response;
    return handler(request, ...rest);
  };
  return wrapped as unknown as H;
}

// ─── Magic-link per-IP rate limit (C12 / OWASP A04-6) ────────────
//
// The Auth.js email provider already limits per-email (3/10 min via
// magicLinkEmailLimiter in auth.config.ts). That doesn't bound a single
// IP from cycling through many emails (SMTP cost / quota DoS, plus
// noise generation). This gate caps signin/email submissions at
// 10 per IP per 10 minutes, applied BEFORE Auth.js dispatches to the
// email provider.
//
// Auth.js's sendVerificationRequest hook does not receive the request
// object, so request-context-based rate limiting must happen at the
// route handler level — same pattern as withCallbackRateLimit above.
const MAGIC_LINK_IP_WINDOW_MS = 10 * MS_PER_MINUTE;
const MAGIC_LINK_IP_MAX = 10;

const magicLinkIpLimiter = createRateLimiter({
  windowMs: MAGIC_LINK_IP_WINDOW_MS,
  max: MAGIC_LINK_IP_MAX,
  failClosedOnRedisError: true,
});

function isMagicLinkSigninRoute(pathname: string, method: string): boolean {
  // Auth.js v5 routes: POST /api/auth/signin/{providerId}
  // (nodemailer provider's POST entrypoint)
  return (
    method === "POST" &&
    authPathReadings(pathname).some(
      (segs) =>
        segs.length === 4 &&
        segs[0] === "api" &&
        segs[1] === "auth" &&
        segs[2] === "signin" &&
        (segs[3] === "nodemailer" || segs[3] === "email"),
    )
  );
}

function withMagicLinkIpRateLimit<H extends RouteHandler>(handler: H): H {
  const wrapped = async (request: NextRequest, ...rest: unknown[]) => {
    if (!isMagicLinkSigninRoute(request.nextUrl.pathname, request.method)) {
      return handler(request, ...rest);
    }
    const rl = await checkIpRateLimit({
      ip: extractClientIp(request),
      pathname: request.nextUrl.pathname,
      scope: "magic_link_signin",
      limiter: magicLinkIpLimiter,
      // High-risk pre-auth endpoint (M2): triggers SMTP sends. Without this, an
      // IP-less request (proxy misconfig / spoofed IP source) would fail open and
      // bypass the per-IP SMTP-DoS cap entirely, leaving only the per-email limit
      // — which an attacker cycling addresses also evades. Bound IP-less traffic
      // through the shared unknown-IP budget.
      boundUnknownIp: true,
    });
    const blocked = await checkRateLimitOrFail({
      req: request,
      result: rl,
      scope: "magic_link_signin",
      userId: null,
    });
    if (blocked) return blocked as unknown as Response;
    return handler(request, ...rest);
  };
  return wrapped as unknown as H;
}

// ─── No signed-in account linking on callback ────────────────
//
// On an OAuth/OIDC callback, Auth.js reads the current session and, when the
// incoming provider account is linked to no one, links it to the signed-in
// user (handleLoginOrRegister). Nothing in this app links accounts while
// signed in — sign-in is only started from the sign-in page — so that branch
// only serves someone holding a stolen session cookie: they would complete
// the IdP flow with an account they control and walk away with a login that
// outlives the stolen session. Dropping the session cookies from callback
// requests makes every callback a fresh sign-in. The other Auth.js cookies
// (state, PKCE, nonce, callback URL, CSRF) are kept.
//
// A fresh sign-in no longer replaces the session the browser held, as Auth.js
// would have; it only overwrites the cookie, which would leave that session
// alive server-side. So the tokens the request carried under the configured
// name ride along in the session meta — both CHIPS variants when the browser
// holds both, since the sign-in response deletes the other variant too — and
// the adapter's createSession deletes those sessions in the transaction that
// creates the new one — only once a sign-in succeeds, and before the
// concurrent-session cap counts them. An ambiguous header names none.
function isSessionCookieKey(key: string): boolean {
  return ALL_KNOWN_SESSION_COOKIE_NAMES.some((name) => key.startsWith(name));
}

function withoutSessionCookieOnCallback<H extends RouteHandler>(handler: H): H {
  const wrapped = async (request: NextRequest, ...rest: unknown[]) => {
    const cookie = request.headers.get("cookie");
    if (!cookie || !isCallbackRoute(request.nextUrl.pathname)) {
      return handler(request, ...rest);
    }
    const pairs = parseCookiePairs(cookie);
    const kept = pairs.filter((pair) => !isSessionCookieKey(pair.key));
    if (kept.length === pairs.length) {
      return handler(request, ...rest);
    }
    const replacedTokens =
      readSessionCookie(cookie).kind === SESSION_COOKIE_READ.TOKEN
        ? presentedSessionTokens(cookie, [configuredSessionCookieName()])
        : [];
    const headers = new Headers(request.headers);
    if (kept.length > 0) {
      headers.set("cookie", kept.map((pair) => `${pair.key}=${pair.value}`).join("; "));
    } else {
      headers.delete("cookie");
    }
    const stripped = new NextRequest(request.url, {
      headers,
      method: request.method,
      body: request.body,
      duplex: "half",
    });
    const meta = sessionMetaStorage.getStore() ?? extractRequestMeta(request);
    return sessionMetaStorage.run(
      { ...meta, replacesSessionTokens: replacedTokens },
      () => handler(stripped, ...rest),
    );
  };
  return wrapped as unknown as H;
}

// ─── Both CHIPS variants on sign-in and sign-out ─────────────
//
// A CHIPS browser can hold the session cookie both partitioned and
// unpartitioned after a COOKIE_PARTITIONED flip, and sends both, older first.
// Auth.js reads the first and writes or deletes only the variant its cookie
// options name. Without help:
//   - a sign-in's new cookie is shadowed by the older variant whenever that
//     one still names a valid session, so the user stays on the old session;
//   - a sign-out revokes the first cookie's session and leaves the other
//     variant, and its session, alive.
// So on a callback and on a sign-out, the other variant is deleted right
// before Auth.js's line for the session cookie (see session-cookie-variants.ts
// for why before, and why raw). The response is rewritten only when Auth.js
// wrote that line — a sign-in that succeeded, a sign-out that passed Auth.js's
// CSRF check and found a session — so a refused request deletes nothing.
//
// A sign-out also revokes the session of every configured-name cookie the
// request carried, once Auth.js's own deletion line shows the sign-out went
// through (after its CSRF check, with a session cookie present). That runs
// here, after the handler, not in events.signOut: Auth.js skips the event
// whenever its own deleteSession throws — as it does when the first cookie's
// session is already gone — and the second cookie's live session would be
// orphaned. Only the configured name, both variants: the legacy names are
// deleted as leftovers from before a configuration change and are never
// authenticated by the current one. No ownership check: holding a raw token
// already lets the caller sign that session out by sending it alone (the
// #966 reasoning). Each session revoked here is audited as AUTH_LOGOUT, as
// events.signOut audits the one Auth.js revoked. A failed
// revocation is logged and the sign-out response still goes out: the cookies
// are deleted either way.
function isSignOutRoute(pathname: string, method: string): boolean {
  return (
    method === "POST" &&
    authPathReadings(pathname).some(
      (segs) =>
        segs.length === 3 && segs[0] === "api" && segs[1] === "auth" && segs[2] === "signout",
    )
  );
}

function withSessionCookieVariants<H extends RouteHandler>(handler: H): H {
  const wrapped = async (request: NextRequest, ...rest: unknown[]) => {
    const signOut = isSignOutRoute(request.nextUrl.pathname, request.method);
    if (!signOut && !isCallbackRoute(request.nextUrl.pathname)) {
      return handler(request, ...rest);
    }
    const response = await handler(request, ...rest);
    const lines = response.headers.getSetCookie();
    if (signOut && deletesSessionCookie(lines)) {
      try {
        const revoked = await revokePresentedSessions(
          presentedSessionTokens(request.headers.get("cookie"), [configuredSessionCookieName()]),
        );
        // Every row deleted here outlived Auth.js's own sign-out: Auth.js
        // deletes the first cookie's session before events.signOut audits it,
        // so that row is already gone when this runs. A row deleted here was
        // therefore never audited — the first cookie's session was missing
        // (the event did not fire) or this is another variant's session. One
        // AUTH_LOGOUT per user, in events.signOut's shape.
        const meta = sessionMetaStorage.getStore();
        for (const userId of new Set(revoked.map((row) => row.userId))) {
          await logAuditAsync({
            scope: AUDIT_SCOPE.PERSONAL,
            action: AUDIT_ACTION.AUTH_LOGOUT,
            userId,
            ip: meta?.ip ?? null,
            userAgent: meta?.userAgent ?? null,
          });
        }
      } catch (err) {
        getLogger().error({
          msg: "auth.signout: revoking the presented sessions failed",
          error: errorLogFields(err),
        });
      }
    }
    const ordered = deleteOtherSessionCookieVariantFirst(
      lines,
      process.env.NEXT_PUBLIC_BASE_PATH || "",
    );
    if (ordered.length === lines.length) return response;
    const headers = new Headers(response.headers);
    headers.delete("set-cookie");
    for (const line of ordered) headers.append("set-cookie", line);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
  return wrapped as unknown as H;
}

// Exported for testing
export { withAuthBasePath as _withAuthBasePath };
export { withCallbackRateLimit as _withCallbackRateLimit };
export { withMagicLinkIpRateLimit as _withMagicLinkIpRateLimit };
export { isCallbackRoute as _isCallbackRoute };
export { withoutSessionCookieOnCallback as _withoutSessionCookieOnCallback };
export { withSessionCookieVariants as _withSessionCookieVariants };

export const GET = withRequestLog(
  withSessionMeta(
    withAuthBasePath(
      withCallbackRateLimit(
        withSessionCookieVariants(withoutSessionCookieOnCallback(handlers.GET)),
      ),
    ),
  ),
);
export const POST = withRequestLog(
  withSessionMeta(
    withAuthBasePath(
      withCallbackRateLimit(
        withMagicLinkIpRateLimit(
          withSessionCookieVariants(withoutSessionCookieOnCallback(handlers.POST)),
        ),
      ),
    ),
  ),
);
