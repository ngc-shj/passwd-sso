import { NextRequest } from "next/server";
import { handlers } from "@/auth";
import { withRequestLog } from "@/lib/http/with-request-log";
import { extractRequestMeta } from "@/lib/audit/audit";
import { sessionMetaStorage } from "@/lib/auth/session/session-meta";
import { tenantClaimStorage } from "@/lib/tenant/tenant-claim-storage";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { extractClientIp } from "@/lib/auth/policy/ip-access";
import { checkIpRateLimit } from "@/lib/security/ip-rate-limit";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { MS_PER_MINUTE } from "@/lib/constants/time";
import { ALL_KNOWN_SESSION_COOKIE_NAMES } from "@/lib/auth/session/cookie-name";
import { parseCookiePairs } from "@/lib/auth/session/session-cookie";

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
 * The Auth.js action path with any basePath removed. The wrappers below run
 * inside withAuthBasePath, whose rebuilt request carries the basePath, so a
 * check against "/api/auth/..." must not depend on whether it is there.
 */
function authActionPath(pathname: string): string {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
  return basePath && pathname.startsWith(basePath) ? pathname.slice(basePath.length) : pathname;
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
  return authActionPath(pathname).startsWith("/api/auth/callback/");
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
  const path = authActionPath(pathname);
  return (
    method === "POST" &&
    (path === "/api/auth/signin/nodemailer" ||
      path === "/api/auth/signin/email")
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
function isSessionCookieKey(key: string): boolean {
  return ALL_KNOWN_SESSION_COOKIE_NAMES.some((name) => key.startsWith(name));
}

function withoutSessionCookieOnCallback<H extends RouteHandler>(handler: H): H {
  const wrapped = async (request: NextRequest, ...rest: unknown[]) => {
    const cookie = request.headers.get("cookie");
    if (!cookie || !isCallbackRoute(request.nextUrl.pathname)) {
      return handler(request, ...rest);
    }
    const kept = parseCookiePairs(cookie).filter((pair) => !isSessionCookieKey(pair.key));
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
    return handler(stripped, ...rest);
  };
  return wrapped as unknown as H;
}

// Exported for testing
export { withAuthBasePath as _withAuthBasePath };
export { withCallbackRateLimit as _withCallbackRateLimit };
export { withMagicLinkIpRateLimit as _withMagicLinkIpRateLimit };
export { isCallbackRoute as _isCallbackRoute };
export { withoutSessionCookieOnCallback as _withoutSessionCookieOnCallback };

export const GET = withRequestLog(
  withSessionMeta(
    withAuthBasePath(
      withCallbackRateLimit(withoutSessionCookieOnCallback(handlers.GET)),
    ),
  ),
);
export const POST = withRequestLog(
  withSessionMeta(
    withAuthBasePath(
      withCallbackRateLimit(
        withMagicLinkIpRateLimit(withoutSessionCookieOnCallback(handlers.POST)),
      ),
    ),
  ),
);
