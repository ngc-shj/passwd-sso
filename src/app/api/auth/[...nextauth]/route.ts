import { NextRequest } from "next/server";
import { handlers } from "@/auth";
import { withRequestLog } from "@/lib/http/with-request-log";
import { extractRequestMeta } from "@/lib/audit/audit";
import { sessionMetaStorage } from "@/lib/auth/session/session-meta";
import { tenantClaimStorage } from "@/lib/tenant/tenant-claim-storage";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { extractClientIp, rateLimitKeyFromIp } from "@/lib/auth/policy/ip-access";
import { rateLimited } from "@/lib/http/api-response";
import { MS_PER_MINUTE } from "@/lib/constants/time";
import { getLogger } from "@/lib/logger";

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

function withSessionMeta<H extends RouteHandler>(handler: H): H {
  const wrapped = async (request: NextRequest, ...rest: unknown[]) => {
    const meta = extractRequestMeta(request);
    return sessionMetaStorage.run(meta, () =>
      tenantClaimStorage.run({ tenantClaim: null }, () =>
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
// Per-client-IP keying via the shared rateLimitKeyFromIp (IPv6 → /64).
// When the client IP cannot be determined (no socket IP and
// TRUST_PROXY_HEADERS unset), the limiter is skipped with a warn log —
// fail-open here is preferred over PR #465's shared "unknown" bucket,
// which collapsed every IP-less request into a single global 60/min
// cap and let one bad actor DoS legitimate callbacks elsewhere on the
// fleet.
const CALLBACK_RATE_LIMIT_WINDOW_MS = 1 * MS_PER_MINUTE;
const CALLBACK_RATE_LIMIT_MAX = 60;

const callbackRateLimiter = createRateLimiter({
  windowMs: CALLBACK_RATE_LIMIT_WINDOW_MS,
  max: CALLBACK_RATE_LIMIT_MAX,
});

function isCallbackRoute(pathname: string): boolean {
  return pathname.startsWith("/api/auth/callback/");
}

function withCallbackRateLimit<H extends RouteHandler>(handler: H): H {
  const wrapped = async (request: NextRequest, ...rest: unknown[]) => {
    if (!isCallbackRoute(request.nextUrl.pathname)) {
      return handler(request, ...rest);
    }
    const ip = extractClientIp(request);
    if (ip == null) {
      getLogger().warn(
        { pathname: request.nextUrl.pathname, method: request.method },
        "auth.callback.rate_limit_skipped_unknown_ip",
      );
      return handler(request, ...rest);
    }
    const rl = await callbackRateLimiter.check(
      `rl:auth_callback:${rateLimitKeyFromIp(ip)}`,
    );
    if (!rl.allowed) {
      return rateLimited(rl.retryAfterMs) as unknown as Response;
    }
    return handler(request, ...rest);
  };
  return wrapped as unknown as H;
}

// Exported for testing
export { withAuthBasePath as _withAuthBasePath };
export { withCallbackRateLimit as _withCallbackRateLimit };
export { isCallbackRoute as _isCallbackRoute };

export const GET = withRequestLog(
  withSessionMeta(withAuthBasePath(withCallbackRateLimit(handlers.GET))),
);
export const POST = withRequestLog(
  withSessionMeta(withAuthBasePath(withCallbackRateLimit(handlers.POST))),
);
