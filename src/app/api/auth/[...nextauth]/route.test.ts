import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { assertRedisFailClosed, snapshotFactory } from "@/__tests__/helpers/fail-closed";

// Mirrors the `RouteHandler` signature in route.ts (not exported). The
// wrappers are generic `<H extends RouteHandler>(h: H): H`, so the inner
// mock must carry the request-accepting signature for `wrapped(req)` to
// typecheck — otherwise vi.fn infers a zero-arg call signature.
type RouteHandler = (
  request: NextRequest,
  ...rest: unknown[]
) => Promise<Response>;

// Mock dependencies so route.ts can be imported without side-effects
vi.mock("@/auth", () => ({
  handlers: {
    GET: vi.fn(async (req: NextRequest) => new Response(req.url)),
    POST: vi.fn(async (req: NextRequest) => new Response(req.url)),
  },
}));
vi.mock("@/lib/http/with-request-log", () => ({
  withRequestLog: <T>(h: T) => h,
}));
vi.mock("@/lib/audit/audit", () => ({
  extractRequestMeta: () => ({}),
  personalAuditBase: vi.fn((_, userId) => ({ scope: "PERSONAL", userId })),
}));
vi.mock("@/lib/auth/session/session-meta", () => ({
  sessionMetaStorage: { run: (_meta: unknown, fn: () => unknown) => fn() },
}));

// Controllable rate-limit mock used by the callback rate-limit tests.
// Recording factory returns a DISTINCT object per createRateLimiter call
// (route.ts:77 callbackRateLimiter THEN :127 magicLinkIpLimiter), both
// delegating to the shared mockRateLimitCheck so the existing wrapper tests
// (which only assert on mockRateLimitCheck) are unaffected. The distinct
// objects let assertRedisFailClosed attribute each limiter to its
// createRateLimiter call — see the "fail-closed contract" describe block.
const mockRateLimitCheck = vi.fn();
const mockCreateRateLimiter = vi.fn(() => ({ check: mockRateLimitCheck }));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: mockCreateRateLimiter,
}));

const mockExtractClientIp = vi.fn();
vi.mock("@/lib/auth/policy/ip-access", () => ({
  extractClientIp: (req: NextRequest) => mockExtractClientIp(req),
  // Identity transform so the assertion against the rate-key value is
  // readable — the actual IPv6→/64 normalization is owned by
  // ip-access.test.ts (do not duplicate that contract here).
  rateLimitKeyFromIp: (ip: string) => ip,
}));

const mockLoggerWarn = vi.fn();
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ warn: mockLoggerWarn, error: vi.fn(), info: vi.fn() }),
}));

describe("withAuthBasePath", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("passes through unchanged when basePath is empty", async () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "");
    const { _withAuthBasePath } = await import(
      "@/app/api/auth/[...nextauth]/route"
    );

    const inner = vi.fn(async (req: NextRequest) => new Response(req.url));
    const wrapped = _withAuthBasePath(inner);

    // When basePath is empty, the wrapper returns the handler itself
    expect(wrapped).toBe(inner);
  });

  it("prepends basePath to request pathname", async () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/passwd-sso");
    const { _withAuthBasePath } = await import(
      "@/app/api/auth/[...nextauth]/route"
    );

    const inner = vi.fn(async (req: NextRequest) => new Response(req.url));
    const wrapped = _withAuthBasePath(inner);

    const req = new NextRequest("http://localhost:3000/api/auth/signin");
    await wrapped(req);

    const patchedUrl = inner.mock.calls[0][0].url;
    expect(new URL(patchedUrl).pathname).toBe("/passwd-sso/api/auth/signin");
  });

  it("does not double-prefix when basePath is already present", async () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/passwd-sso");
    const { _withAuthBasePath } = await import(
      "@/app/api/auth/[...nextauth]/route"
    );

    const inner = vi.fn(async (req: NextRequest) => new Response(req.url));
    const wrapped = _withAuthBasePath(inner);

    // Simulate a request that already has basePath
    const req = new NextRequest(
      "http://localhost:3000/passwd-sso/api/auth/callback/google",
    );
    await wrapped(req);

    const patchedUrl = inner.mock.calls[0][0].url;
    expect(new URL(patchedUrl).pathname).toBe(
      "/passwd-sso/api/auth/callback/google",
    );
  });

  it("transfers POST body to patched request", async () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/passwd-sso");
    const { _withAuthBasePath } = await import(
      "@/app/api/auth/[...nextauth]/route"
    );

    let capturedBody: string | null = null;
    const inner = vi.fn(async (req: NextRequest) => {
      capturedBody = await req.text();
      return new Response(capturedBody);
    });
    const wrapped = _withAuthBasePath(inner);

    const payload = JSON.stringify({ csrfToken: "abc123" });
    const req = new NextRequest("http://localhost:3000/api/auth/callback/google", {
      method: "POST",
      body: payload,
      headers: { "Content-Type": "application/json" },
    });
    await wrapped(req);

    expect(inner.mock.calls[0][0].method).toBe("POST");
    expect(capturedBody).toBe(payload);
  });

  it("preserves cookies in patched request", async () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/passwd-sso");
    const { _withAuthBasePath } = await import(
      "@/app/api/auth/[...nextauth]/route"
    );

    let capturedCookie: string | null = null;
    const inner = vi.fn(async (req: NextRequest) => {
      capturedCookie = req.headers.get("cookie");
      return new Response("ok");
    });
    const wrapped = _withAuthBasePath(inner);

    const req = new NextRequest("http://localhost:3000/api/auth/session", {
      headers: { Cookie: "authjs.session-token=abc123" },
    });
    await wrapped(req);

    expect(capturedCookie).toBe("authjs.session-token=abc123");
  });

  it("preserves query parameters", async () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/passwd-sso");
    const { _withAuthBasePath } = await import(
      "@/app/api/auth/[...nextauth]/route"
    );

    const inner = vi.fn(async (req: NextRequest) => new Response(req.url));
    const wrapped = _withAuthBasePath(inner);

    const req = new NextRequest(
      "http://localhost:3000/api/auth/signin?callbackUrl=%2Fdashboard",
    );
    await wrapped(req);

    const patchedUrl = new URL(inner.mock.calls[0][0].url);
    expect(patchedUrl.pathname).toBe("/passwd-sso/api/auth/signin");
    expect(patchedUrl.searchParams.get("callbackUrl")).toBe("/dashboard");
  });
});

describe("isCallbackRoute", () => {
  it("returns true for OAuth provider callback paths", async () => {
    const { _isCallbackRoute } = await import(
      "@/app/api/auth/[...nextauth]/route"
    );
    expect(_isCallbackRoute("/api/auth/callback/google")).toBe(true);
    expect(_isCallbackRoute("/api/auth/callback/credentials")).toBe(true);
    expect(_isCallbackRoute("/api/auth/callback/passkey")).toBe(true);
  });

  it("returns false for non-callback Auth.js paths", async () => {
    const { _isCallbackRoute } = await import(
      "@/app/api/auth/[...nextauth]/route"
    );
    expect(_isCallbackRoute("/api/auth/signin")).toBe(false);
    expect(_isCallbackRoute("/api/auth/signin/google")).toBe(false);
    expect(_isCallbackRoute("/api/auth/signout")).toBe(false);
    expect(_isCallbackRoute("/api/auth/csrf")).toBe(false);
    expect(_isCallbackRoute("/api/auth/session")).toBe(false);
    expect(_isCallbackRoute("/api/auth/providers")).toBe(false);
  });

  it("requires the trailing slash to prevent prefix collision", async () => {
    const { _isCallbackRoute } = await import(
      "@/app/api/auth/[...nextauth]/route"
    );
    expect(_isCallbackRoute("/api/auth/callbackz")).toBe(false);
    expect(_isCallbackRoute("/api/auth/callback")).toBe(false);
  });
});

describe("withCallbackRateLimit", () => {
  beforeEach(() => {
    mockRateLimitCheck.mockReset();
    mockExtractClientIp.mockReset();
    mockLoggerWarn.mockReset();
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
    mockExtractClientIp.mockReturnValue("203.0.113.5");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  function makeReq(pathname: string, method: "GET" | "POST" = "POST") {
    return new NextRequest(`http://localhost:3000${pathname}`, { method });
  }

  it("skips the limiter and forwards the request when the path is not a callback", async () => {
    const { _withCallbackRateLimit } = await import(
      "@/app/api/auth/[...nextauth]/route"
    );
    const inner = vi.fn<RouteHandler>(async () => new Response("ok"));
    const wrapped = _withCallbackRateLimit(inner);

    const res = await wrapped(makeReq("/api/auth/signin"));

    expect(res.status).toBe(200);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(mockExtractClientIp).not.toHaveBeenCalled();
    expect(mockRateLimitCheck).not.toHaveBeenCalled();
  });

  it("invokes the limiter with `rl:auth_callback:<ip>` and forwards on allowed", async () => {
    const { _withCallbackRateLimit } = await import(
      "@/app/api/auth/[...nextauth]/route"
    );
    const inner = vi.fn<RouteHandler>(async () => new Response("ok"));
    const wrapped = _withCallbackRateLimit(inner);

    const res = await wrapped(makeReq("/api/auth/callback/google", "GET"));

    expect(res.status).toBe(200);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(mockRateLimitCheck).toHaveBeenCalledTimes(1);
    expect(mockRateLimitCheck).toHaveBeenCalledWith("rl:auth_callback:203.0.113.5");
  });

  it("returns 429 with Retry-After when the limiter denies (does NOT invoke handler)", async () => {
    mockRateLimitCheck.mockResolvedValue({ allowed: false, retryAfterMs: 1500 });
    const { _withCallbackRateLimit } = await import(
      "@/app/api/auth/[...nextauth]/route"
    );
    const inner = vi.fn<RouteHandler>(async () => new Response("ok"));
    const wrapped = _withCallbackRateLimit(inner);

    const res = await wrapped(makeReq("/api/auth/callback/google", "POST"));

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("2"); // ceil(1500/1000)
    expect(inner).not.toHaveBeenCalled();
  });

  it("covers both GET and POST callbacks (Google OIDC GET is not bypassed)", async () => {
    const { _withCallbackRateLimit } = await import(
      "@/app/api/auth/[...nextauth]/route"
    );
    const inner = vi.fn<RouteHandler>(async () => new Response("ok"));
    const wrapped = _withCallbackRateLimit(inner);

    await wrapped(makeReq("/api/auth/callback/google", "GET"));
    await wrapped(makeReq("/api/auth/callback/saml", "POST"));

    expect(mockRateLimitCheck).toHaveBeenCalledTimes(2);
    expect(inner).toHaveBeenCalledTimes(2);
  });

  // Redis-unavailable fail-closed (503) for this limiter is covered by the
  // stronger helper contract in the "fail-closed contract" describe block
  // (envelope + Retry-After + factory attribution) — the former status-only
  // direct case is superseded and removed to avoid duplication.

  it("skips the limiter and warn-logs when client IP cannot be determined", async () => {
    mockExtractClientIp.mockReturnValue(null);
    const { _withCallbackRateLimit } = await import(
      "@/app/api/auth/[...nextauth]/route"
    );
    const inner = vi.fn<RouteHandler>(async () => new Response("ok"));
    const wrapped = _withCallbackRateLimit(inner);

    const res = await wrapped(makeReq("/api/auth/callback/google", "GET"));

    expect(res.status).toBe(200);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(mockRateLimitCheck).not.toHaveBeenCalled();
    // The wrapper delegates to checkIpRateLimit, which logs with the
    // shared message + { pathname, scope } shape (see ip-rate-limit.ts).
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: "/api/auth/callback/google",
        scope: "auth_callback",
      }),
      "rate_limit_skipped_unknown_ip",
    );
  });

  it("partitions limiter buckets by client IP", async () => {
    const { _withCallbackRateLimit } = await import(
      "@/app/api/auth/[...nextauth]/route"
    );
    const inner = vi.fn<RouteHandler>(async () => new Response("ok"));
    const wrapped = _withCallbackRateLimit(inner);

    mockExtractClientIp.mockReturnValueOnce("203.0.113.5");
    await wrapped(makeReq("/api/auth/callback/google"));
    mockExtractClientIp.mockReturnValueOnce("198.51.100.7");
    await wrapped(makeReq("/api/auth/callback/google"));

    expect(mockRateLimitCheck.mock.calls.map((c) => c[0])).toEqual([
      "rl:auth_callback:203.0.113.5",
      "rl:auth_callback:198.51.100.7",
    ]);
  });
});

describe("withMagicLinkIpRateLimit", () => {
  beforeEach(() => {
    mockRateLimitCheck.mockReset();
    mockExtractClientIp.mockReset();
    mockLoggerWarn.mockReset();
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
    mockExtractClientIp.mockReturnValue("203.0.113.5");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  function makeReq(pathname: string, method: "GET" | "POST" = "POST") {
    return new NextRequest(`http://localhost:3000${pathname}`, { method });
  }

  it("skips the limiter and forwards when the path is not a magic-link signin", async () => {
    const { _withMagicLinkIpRateLimit } = await import(
      "@/app/api/auth/[...nextauth]/route"
    );
    const inner = vi.fn<RouteHandler>(async () => new Response("ok"));
    const wrapped = _withMagicLinkIpRateLimit(inner);

    const res = await wrapped(makeReq("/api/auth/callback/google"));

    expect(res.status).toBe(200);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(mockRateLimitCheck).not.toHaveBeenCalled();
  });

  it("invokes the limiter with `rl:magic_link_signin:<ip>` and forwards on allowed", async () => {
    const { _withMagicLinkIpRateLimit } = await import(
      "@/app/api/auth/[...nextauth]/route"
    );
    const inner = vi.fn<RouteHandler>(async () => new Response("ok"));
    const wrapped = _withMagicLinkIpRateLimit(inner);

    const res = await wrapped(makeReq("/api/auth/signin/nodemailer"));

    expect(res.status).toBe(200);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(mockRateLimitCheck).toHaveBeenCalledWith("rl:magic_link_signin:203.0.113.5");
  });

  it("returns 429 when the limiter denies (does NOT invoke handler)", async () => {
    mockRateLimitCheck.mockResolvedValue({ allowed: false, retryAfterMs: 1500 });
    const { _withMagicLinkIpRateLimit } = await import(
      "@/app/api/auth/[...nextauth]/route"
    );
    const inner = vi.fn<RouteHandler>(async () => new Response("ok"));
    const wrapped = _withMagicLinkIpRateLimit(inner);

    const res = await wrapped(makeReq("/api/auth/signin/email"));

    expect(res.status).toBe(429);
    expect(inner).not.toHaveBeenCalled();
  });

  // Redis-unavailable fail-closed (503) for this limiter is covered by the
  // stronger helper contract in the "fail-closed contract" describe block
  // (envelope + Retry-After + factory attribution) — the former status-only
  // direct case is superseded and removed to avoid duplication.

  it("fail-OPEN: forwards when client IP cannot be determined (no 503)", async () => {
    mockExtractClientIp.mockReturnValue(null);
    const { _withMagicLinkIpRateLimit } = await import(
      "@/app/api/auth/[...nextauth]/route"
    );
    const inner = vi.fn<RouteHandler>(async () => new Response("ok"));
    const wrapped = _withMagicLinkIpRateLimit(inner);

    const res = await wrapped(makeReq("/api/auth/signin/nodemailer"));

    expect(res.status).toBe(200);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(mockRateLimitCheck).not.toHaveBeenCalled();
  });
});

// Fail-closed contract (helper tier). The route's two limiters
// (callbackRateLimiter, magicLinkIpLimiter) are both pre-auth `userId: null`
// → checkRateLimitOrFail warn-logs (no logAuditAsync) and returns canonical
// 503 on redisErrored. Because the route module is imported dynamically with
// per-test resetModules elsewhere in this file, this block imports ONCE, then
// captures the two distinct createRateLimiter results by creation order and
// snapshots the factory for strict-identity attribution. assertNoMutation uses
// the wrapped handler-proceed spy (tranche-2 read-only-route semantic
// extension): the auth handler is the guarded side-effect, and its
// non-invocation proves the 503 short-circuited before the handler ran.
describe("fail-closed contract (Redis unavailable → 503)", () => {
  beforeEach(() => {
    mockRateLimitCheck.mockReset();
    mockExtractClientIp.mockReturnValue("203.0.113.5");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function loadRoute() {
    // Reset so this block owns the factory's call/result ledger, then import
    // once — both createRateLimiter calls fire at module-load in creation order.
    vi.resetModules();
    mockCreateRateLimiter.mockClear();
    const mod = await import("@/app/api/auth/[...nextauth]/route");
    const callbackFactorySnapshot = snapshotFactory(mockCreateRateLimiter);
    const callbackLimiter = mockCreateRateLimiter.mock.results[0]!.value as {
      check: typeof mockRateLimitCheck;
    };
    const magicLinkFactorySnapshot = snapshotFactory(mockCreateRateLimiter);
    const magicLinkLimiter = mockCreateRateLimiter.mock.results[1]!.value as {
      check: typeof mockRateLimitCheck;
    };
    return {
      mod,
      callbackLimiter,
      callbackFactorySnapshot,
      magicLinkLimiter,
      magicLinkFactorySnapshot,
    };
  }

  it("fails closed (503, no mutation) when Redis is unavailable — callback", async () => {
    const { mod, callbackLimiter, callbackFactorySnapshot } = await loadRoute();
    const inner = vi.fn<RouteHandler>(async () => new Response("ok"));
    const wrapped = mod._withCallbackRateLimit(inner);
    await assertRedisFailClosed({
      invoke: () =>
        wrapped(
          new NextRequest(
            "http://localhost/api/auth/callback/google/",
            { method: "POST" },
          ),
        ),
      limiter: callbackLimiter,
      expectation: { envelope: "canonical" },
      assertNoMutation: [inner],
      limiterFactory: callbackFactorySnapshot.replay(),
      failure: { allowed: false, redisErrored: true },
    });
  });

  it("fails closed (503, no mutation) when Redis is unavailable — magic-link", async () => {
    const { mod, magicLinkLimiter, magicLinkFactorySnapshot } = await loadRoute();
    const inner = vi.fn<RouteHandler>(async () => new Response("ok"));
    const wrapped = mod._withMagicLinkIpRateLimit(inner);
    await assertRedisFailClosed({
      invoke: () =>
        wrapped(
          new NextRequest(
            "http://localhost/api/auth/signin/nodemailer",
            { method: "POST" },
          ),
        ),
      limiter: magicLinkLimiter,
      expectation: { envelope: "canonical" },
      assertNoMutation: [inner],
      limiterFactory: magicLinkFactorySnapshot.replay(),
      failure: { allowed: false, redisErrored: true },
    });
  });
});
