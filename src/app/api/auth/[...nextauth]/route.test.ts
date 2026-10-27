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
    expect(_isCallbackRoute("/api/auth/callback//")).toBe(false);
  });

  // Auth.js drops empty segments when it parses the action, so these are the
  // callback action to it and must be to us.
  it.each(["/api/auth//callback/google", "/api/auth/callback//google", "/api//auth/callback/google"])(
    "classifies %s as a callback, as Auth.js parses it",
    async (path) => {
      const { _isCallbackRoute } = await import("@/app/api/auth/[...nextauth]/route");
      expect(_isCallbackRoute(path)).toBe(true);
    },
  );
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

  it("routes IP-less requests through the shared unknown-ip bucket and warn-logs (M2)", async () => {
    mockExtractClientIp.mockReturnValue(null);
    const { _withCallbackRateLimit } = await import(
      "@/app/api/auth/[...nextauth]/route"
    );
    const inner = vi.fn<RouteHandler>(async () => new Response("ok"));
    const wrapped = _withCallbackRateLimit(inner);

    const res = await wrapped(makeReq("/api/auth/callback/google", "GET"));

    expect(res.status).toBe(200);
    expect(inner).toHaveBeenCalledTimes(1);
    // M2: auth_callback is high-risk (boundUnknownIp), so an IP-less request is
    // bounded by the shared unknown-ip budget rather than waved through.
    expect(mockRateLimitCheck).toHaveBeenCalledWith("rl:auth_callback:unknown-ip");
    // The wrapper delegates to checkIpRateLimit, which still logs with the
    // shared message + { pathname, scope } shape (see ip-rate-limit.ts).
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: "/api/auth/callback/google",
        scope: "auth_callback",
      }),
      "rate_limit_skipped_unknown_ip",
    );
  });

  it("denies an IP-less request when the shared unknown-ip budget is exhausted (M2)", async () => {
    mockExtractClientIp.mockReturnValue(null);
    mockRateLimitCheck.mockResolvedValueOnce({ allowed: false, retryAfterMs: 3000 });
    const { _withCallbackRateLimit } = await import(
      "@/app/api/auth/[...nextauth]/route"
    );
    const inner = vi.fn<RouteHandler>(async () => new Response("ok"));
    const wrapped = _withCallbackRateLimit(inner);

    const res = await wrapped(makeReq("/api/auth/callback/google", "GET"));

    expect(res.status).toBe(429);
    expect(inner).not.toHaveBeenCalled();
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

  it("routes IP-less requests through the shared unknown-ip bucket and warn-logs (M2)", async () => {
    // Regression for the M2 gap: magic-link signin is high-risk (triggers SMTP
    // sends) but previously failed OPEN on IP-less requests, bypassing the per-IP
    // SMTP-DoS cap. It now bounds IP-less traffic via boundUnknownIp.
    mockExtractClientIp.mockReturnValue(null);
    const { _withMagicLinkIpRateLimit } = await import(
      "@/app/api/auth/[...nextauth]/route"
    );
    const inner = vi.fn<RouteHandler>(async () => new Response("ok"));
    const wrapped = _withMagicLinkIpRateLimit(inner);

    const res = await wrapped(makeReq("/api/auth/signin/nodemailer"));

    expect(res.status).toBe(200);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(mockRateLimitCheck).toHaveBeenCalledWith("rl:magic_link_signin:unknown-ip");
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: "/api/auth/signin/nodemailer",
        scope: "magic_link_signin",
      }),
      "rate_limit_skipped_unknown_ip",
    );
  });

  it("denies an IP-less magic-link request when the shared unknown-ip budget is exhausted (M2)", async () => {
    mockExtractClientIp.mockReturnValue(null);
    mockRateLimitCheck.mockResolvedValueOnce({ allowed: false, retryAfterMs: 3000 });
    const { _withMagicLinkIpRateLimit } = await import(
      "@/app/api/auth/[...nextauth]/route"
    );
    const inner = vi.fn<RouteHandler>(async () => new Response("ok"));
    const wrapped = _withMagicLinkIpRateLimit(inner);

    const res = await wrapped(makeReq("/api/auth/signin/nodemailer"));

    expect(res.status).toBe(429);
    expect(inner).not.toHaveBeenCalled();
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

describe("basePath: the path checks see the Auth.js action, not the prefix", () => {
  beforeEach(() => {
    mockRateLimitCheck.mockReset();
    mockExtractClientIp.mockReset();
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
    mockExtractClientIp.mockReturnValue("203.0.113.5");
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/passwd-sso");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // withAuthBasePath rebuilds the request with the basePath before the
  // limiters run, so they used to see "/passwd-sso/api/auth/..." and skip.
  it("rate-limits a callback whose path carries the basePath", async () => {
    const { _withCallbackRateLimit, _isCallbackRoute } = await import(
      "@/app/api/auth/[...nextauth]/route"
    );
    expect(_isCallbackRoute("/passwd-sso/api/auth/callback/google")).toBe(true);
    expect(_isCallbackRoute("/passwd-sso/api/auth/session")).toBe(false);
    const inner = vi.fn<RouteHandler>(async () => new Response("ok"));
    await _withCallbackRateLimit(inner)(
      new NextRequest("http://localhost:3000/passwd-sso/api/auth/callback/google"),
    );
    expect(mockRateLimitCheck).toHaveBeenCalledWith("rl:auth_callback:203.0.113.5");
  });

  it("rate-limits a magic-link sign-in whose path carries the basePath", async () => {
    const { _withMagicLinkIpRateLimit } = await import(
      "@/app/api/auth/[...nextauth]/route"
    );
    const inner = vi.fn<RouteHandler>(async () => new Response("ok"));
    await _withMagicLinkIpRateLimit(inner)(
      new NextRequest("http://localhost:3000/passwd-sso/api/auth/signin/nodemailer", {
        method: "POST",
      }),
    );
    expect(mockRateLimitCheck).toHaveBeenCalledTimes(1);
  });

  // Whether the basePath is on the path depends on which wrapper saw the
  // request first; both spellings must classify the same.
  it("still classifies a callback path that arrives without the basePath", async () => {
    const { _isCallbackRoute } = await import("@/app/api/auth/[...nextauth]/route");
    expect(_isCallbackRoute("/api/auth/callback/google")).toBe(true);
  });
});

describe("magic-link sign-in classification follows Auth.js's segment parse", () => {
  beforeEach(() => {
    mockRateLimitCheck.mockReset();
    mockExtractClientIp.mockReset();
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
    mockExtractClientIp.mockReturnValue("203.0.113.5");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function limited(path: string, method = "POST"): Promise<boolean> {
    const { _withMagicLinkIpRateLimit } = await import("@/app/api/auth/[...nextauth]/route");
    const inner = vi.fn<RouteHandler>(async () => new Response("ok"));
    await _withMagicLinkIpRateLimit(inner)(new NextRequest(`http://localhost:3000${path}`, { method }));
    return mockRateLimitCheck.mock.calls.length > 0;
  }

  it.each(["/api/auth//signin/nodemailer", "/api/auth/signin//email", "/api/auth/signin/nodemailer/"])(
    "rate-limits %s",
    async (path) => {
      expect(await limited(path)).toBe(true);
    },
  );

  it("rate-limits a magic-link sign-in when the basePath is /api", async () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/api");
    expect(await limited("/api/auth/signin/nodemailer")).toBe(true);
  });

  it.each([
    ["/api/auth/signin/google", "POST"],
    ["/api/auth/signin/nodemailer/extra", "POST"],
    ["/api/auth/signin/nodemailer", "GET"],
  ])("does not rate-limit %s %s", async (path, method) => {
    expect(await limited(path, method)).toBe(false);
  });
});

describe("withoutSessionCookieOnCallback", () => {
  const SESSION_COOKIES = [
    "authjs.session-token=aaaa",
    "__Secure-authjs.session-token=bbbb",
    "__Host-authjs.session-token=cccc",
    "authjs.session-token.0=dddd",
    "next-auth.session-token=eeee",
    "__Secure-next-auth.session-token=gggg",
  ];
  const OTHER_COOKIES = [
    "authjs.pkce.code_verifier=pk",
    "authjs.state=st",
    "authjs.callback-url=cb",
    "authjs.csrf-token=cs",
    "NEXT_LOCALE=ja",
  ];

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function forward(path: string, cookie: string | null, init: { method?: string; body?: string } = {}) {
    const { _withoutSessionCookieOnCallback } = await import(
      "@/app/api/auth/[...nextauth]/route"
    );
    let seen: NextRequest | undefined;
    const inner = vi.fn<RouteHandler>(async (req) => {
      seen = req;
      return new Response("ok");
    });
    await _withoutSessionCookieOnCallback(inner)(
      new NextRequest(`http://localhost:3000${path}`, {
        method: init.method ?? "GET",
        body: init.body,
        headers: cookie === null ? {} : { cookie },
      }),
    );
    expect(inner).toHaveBeenCalledTimes(1);
    return seen as NextRequest;
  }

  it("drops every session cookie on a callback and keeps the others", async () => {
    const req = await forward(
      "/api/auth/callback/google",
      [...SESSION_COOKIES, ...OTHER_COOKIES].join("; "),
    );
    expect(req.headers.get("cookie")).toBe(OTHER_COOKIES.join("; "));
  });

  // Auth.js's SessionStore joins every cookie whose name STARTS WITH the
  // session name, not only `<name>.<n>` chunks.
  it.each([
    "authjs.session-tokenX=ffff",
    "__Host-authjs.session-tokenX=ffff",
    "__Secure-authjs.session-tokenX=ffff",
  ])("drops %s, which Auth.js would read as part of the session", async (sessionCookie) => {
    const req = await forward("/api/auth/callback/google", `${sessionCookie}; authjs.state=st`);
    expect(req.headers.get("cookie")).toBe("authjs.state=st");
  });

  it("reaches the handler with no cookie header when none was sent", async () => {
    const req = await forward("/api/auth/callback/google", null);
    expect(req.headers.get("cookie")).toBeNull();
  });

  it("keeps a cookie whose value holds `=` and percent-encoding byte-for-byte", async () => {
    const kept = "authjs.callback-url=http%3A%2F%2Flocalhost%3A3000%2Fja%3Fa%3Db; opaque=a=b==";
    const req = await forward("/api/auth/callback/google", `authjs.session-token=aaaa; ${kept}`);
    expect(req.headers.get("cookie")).toBe(kept);
  });

  it("leaves a header with no session cookie exactly as sent", async () => {
    const cookie = "authjs.state=st;authjs.pkce.code_verifier=pk;  flag; NEXT_LOCALE=ja";
    const req = await forward("/api/auth/callback/google", cookie);
    expect(req.headers.get("cookie")).toBe(cookie);
  });

  it("strips on a callback path with an empty segment", async () => {
    const req = await forward("/api/auth//callback/google", "authjs.session-token=aaaa; authjs.state=st");
    expect(req.headers.get("cookie")).toBe("authjs.state=st");
  });

  // withAuthBasePath leaves "/api/auth/..." unprefixed when the basePath is
  // "/api", so the action path arrives without it.
  it("strips on a callback when the basePath is /api", async () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/api");
    const { _isCallbackRoute } = await import("@/app/api/auth/[...nextauth]/route");
    expect(_isCallbackRoute("/api/auth/callback/google")).toBe(true);
    expect(_isCallbackRoute("/api/api/auth/callback/google")).toBe(true);
    expect(_isCallbackRoute("/api/auth/session")).toBe(false);
    const req = await forward("/api/auth/callback/google", "authjs.session-token=aaaa; authjs.state=st");
    expect(req.headers.get("cookie")).toBe("authjs.state=st");
  });

  it("removes the cookie header when only session cookies were sent", async () => {
    const req = await forward("/api/auth/callback/google", SESSION_COOKIES.join("; "));
    expect(req.headers.get("cookie")).toBeNull();
  });

  // The control: outside callback/* the session is what the action needs.
  it.each(["/api/auth/session", "/api/auth/signout", "/api/auth/signin/google", "/api/auth/csrf"])(
    "leaves the cookie header untouched on %s",
    async (path) => {
      const cookie = [...SESSION_COOKIES, ...OTHER_COOKIES].join("; ");
      const req = await forward(path, cookie);
      expect(req.headers.get("cookie")).toBe(cookie);
    },
  );

  it("strips on a basePath-prefixed callback too", async () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/passwd-sso");
    const req = await forward(
      "/passwd-sso/api/auth/callback/google",
      ["authjs.session-token=aaaa", "authjs.state=st"].join("; "),
    );
    expect(req.headers.get("cookie")).toBe("authjs.state=st");
  });

  it("keeps the method and body of a form_post callback", async () => {
    const req = await forward("/api/auth/callback/jackson", "authjs.session-token=aaaa", {
      method: "POST",
      body: "code=abc&state=st",
    });
    expect(req.method).toBe("POST");
    expect(await req.text()).toBe("code=abc&state=st");
  });
});

describe("exported handlers reach Auth.js without a session cookie on callback", () => {
  beforeEach(() => {
    mockRateLimitCheck.mockReset();
    mockExtractClientIp.mockReset();
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
    mockExtractClientIp.mockReturnValue("203.0.113.5");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it.each(["GET", "POST"] as const)("%s callback", async (method) => {
    const route = await import("@/app/api/auth/[...nextauth]/route");
    const { handlers } = await import("@/auth");
    const handler = vi.mocked(handlers[method]);
    handler.mockClear();
    await route[method](
      new NextRequest("http://localhost:3000/api/auth/callback/google", {
        method,
        headers: { cookie: "authjs.session-token=aaaa; authjs.state=st" },
      }),
    );
    expect(handler).toHaveBeenCalledTimes(1);
    const reached = handler.mock.calls[0][0] as NextRequest;
    expect(reached.headers.get("cookie")).toBe("authjs.state=st");
  });

  // Next.js hands the route the path with the basePath stripped;
  // withAuthBasePath puts it back before the inner wrappers run.
  it("GET with a basePath: the callback is rate-limited and reaches Auth.js without the session cookie", async () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/passwd-sso");
    const route = await import("@/app/api/auth/[...nextauth]/route");
    const { handlers } = await import("@/auth");
    const handler = vi.mocked(handlers.GET);
    handler.mockClear();
    await route.GET(
      new NextRequest("http://localhost:3000/api/auth/callback/google", {
        headers: { cookie: "authjs.session-token=aaaa; authjs.state=st" },
      }),
    );
    expect(mockRateLimitCheck).toHaveBeenCalledWith("rl:auth_callback:203.0.113.5");
    expect(handler).toHaveBeenCalledTimes(1);
    const reached = handler.mock.calls[0][0] as NextRequest;
    expect(new URL(reached.url).pathname).toBe("/passwd-sso/api/auth/callback/google");
    expect(reached.headers.get("cookie")).toBe("authjs.state=st");
  });
});

describe("withoutSessionCookieOnCallback hands the replaced session to the sign-in", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const OUTER_META = { ip: "203.0.113.7", userAgent: "ua", acceptLanguage: "ja" };

  // What the adapter's createSession would read from the session meta while
  // the wrapped handler runs.
  async function metaSeen(path: string, cookie: string | null) {
    const { _withoutSessionCookieOnCallback } = await import(
      "@/app/api/auth/[...nextauth]/route"
    );
    const { sessionMetaStorage } = await import("@/lib/auth/session/session-meta");
    let seen: unknown;
    const inner = vi.fn<RouteHandler>(async () => {
      seen = sessionMetaStorage.getStore();
      return new Response(null, { status: 302 });
    });
    await sessionMetaStorage.run({ ...OUTER_META }, () =>
      _withoutSessionCookieOnCallback(inner)(
        new NextRequest(`http://localhost:3000${path}`, {
          headers: cookie === null ? {} : { cookie },
        }),
      ),
    );
    expect(inner).toHaveBeenCalledTimes(1);
    return seen;
  }

  it("passes the stripped session token, keeping the request meta", async () => {
    expect(
      await metaSeen("/api/auth/callback/google", "authjs.session-token=aaaa; authjs.state=st"),
    ).toEqual({ ...OUTER_META, replacesSessionTokens: ["aaaa"] });
  });

  // On https the configured name carries a prefix: __Host- without a
  // basePath, __Secure- with one.
  it("passes the token of the configured https cookie name", async () => {
    vi.stubEnv("AUTH_URL", "https://example.com");
    expect(
      await metaSeen("/api/auth/callback/google", "__Host-authjs.session-token=bbbb"),
    ).toMatchObject({ replacesSessionTokens: ["bbbb"] });
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/passwd-sso");
    expect(
      await metaSeen("/passwd-sso/api/auth/callback/google", "__Secure-authjs.session-token=cccc"),
    ).toMatchObject({ replacesSessionTokens: ["cccc"] });
  });

  // A CHIPS browser holding both variants sends both, older first. The
  // sign-in response deletes both cookies, so both sessions are replaced.
  it("passes every token under the configured name, both variants", async () => {
    vi.stubEnv("AUTH_URL", "https://example.com");
    expect(
      await metaSeen(
        "/api/auth/callback/google",
        "__Host-authjs.session-token=aaaa; authjs.state=st; __Host-authjs.session-token=bbbb",
      ),
    ).toMatchObject({ replacesSessionTokens: ["aaaa", "bbbb"] });
  });

  it("passes no duplicate whose value is outside the token alphabet", async () => {
    expect(
      await metaSeen("/api/auth/callback/google", "authjs.session-token=aaaa; authjs.session-token=%61"),
    ).toMatchObject({ replacesSessionTokens: ["aaaa"] });
  });

  // Auth.js reads only the configured name, so a cookie under another name
  // names no session it would have replaced.
  it("names no session for a stripped cookie that is not the configured name", async () => {
    vi.stubEnv("AUTH_URL", "https://example.com");
    expect(
      await metaSeen("/api/auth/callback/google", "authjs.session-token=aaaa"),
    ).toMatchObject({ replacesSessionTokens: [] });
  });

  it("names no session when the request carried no session cookie", async () => {
    expect(await metaSeen("/api/auth/callback/google", "authjs.state=st")).toEqual(OUTER_META);
    expect(await metaSeen("/api/auth/callback/google", null)).toEqual(OUTER_META);
  });

  // An ambiguous header (a second session-name cookie) names no one session.
  it("names no session when the session cookie read is ambiguous", async () => {
    expect(
      await metaSeen(
        "/api/auth/callback/google",
        "authjs.session-token=aaaa; authjs.session-token.0=dddd",
      ),
    ).toMatchObject({ replacesSessionTokens: [] });
  });

  it("names no session outside a callback", async () => {
    expect(await metaSeen("/api/auth/session", "authjs.session-token=aaaa")).toEqual(OUTER_META);
  });
});

describe("withSessionCookieVariants (issue #962)", () => {
  const HOST = "__Host-authjs.session-token";
  const TOKEN_A = "0b6f1c2e-8d4a-4f7e-9a1b-3c5d7e9f0a2b";
  const TOKEN_B = "5a7c9e1f-2b4d-4c6e-8f0a-1b3d5f7a9c0e";
  const TOKEN_C = "9c0e5a7c-1f2b-4d4c-8e6f-0a1b3d5f7a9c";

  beforeEach(() => {
    vi.stubEnv("AUTH_URL", "https://app.example.test");
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const isPartitioned = (line: string) => /;\s*Partitioned/i.test(line);
  const isDeletionOf = (name: string) => (line: string) =>
    line.startsWith(`${name}=;`) && /Expires=Thu, 01 Jan 1970/i.test(line);

  function responseWith(lines: string[], init: ResponseInit = { status: 302 }): Response {
    const headers = new Headers({ location: "https://app.example.test/dashboard" });
    for (const line of lines) headers.append("set-cookie", line);
    return new Response(null, { ...init, headers });
  }

  const sessionSet = (partitioned: boolean) =>
    `${HOST}=${TOKEN_C}; Path=/; Expires=Wed, 01 Jan 2031 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax${partitioned ? "; Partitioned" : ""}`;

  async function run(
    path: string,
    method: string,
    cookie: string | null,
    response: Response,
  ): Promise<{ out: Response; meta: unknown }> {
    const { _withSessionCookieVariants } = await import("@/app/api/auth/[...nextauth]/route");
    const { sessionMetaStorage } = await import("@/lib/auth/session/session-meta");
    let meta: unknown;
    const inner = vi.fn<RouteHandler>(async () => {
      meta = sessionMetaStorage.getStore();
      return response;
    });
    const out = await sessionMetaStorage.run({ ip: null, userAgent: null, acceptLanguage: null }, () =>
      _withSessionCookieVariants(inner)(
        new NextRequest(`https://app.example.test${path}`, {
          method,
          headers: cookie === null ? {} : { cookie },
        }),
      ),
    );
    return { out, meta };
  }

  it.each([
    ["partitioned", true],
    ["unpartitioned", false],
  ])("callback: deletes the other variant before the %s session cookie, on the raw lines", async (_label, partitioned) => {
    const lines = ["authjs.callback-url=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT", sessionSet(partitioned)];
    const { out } = await run("/api/auth/callback/google", "GET", null, responseWith(lines));

    const raw = out.headers.getSetCookie();
    expect(raw).toHaveLength(3);
    expect(raw[0]).toBe(lines[0]);
    expect(isDeletionOf(HOST)(raw[1])).toBe(true);
    expect(isPartitioned(raw[1])).toBe(!partitioned);
    expect(raw[2]).toBe(lines[1]);
    expect(out.status).toBe(302);
    expect(out.headers.get("location")).toBe("https://app.example.test/dashboard");
  });

  it("callback that set no session cookie (a failed sign-in) is returned untouched", async () => {
    const response = responseWith(["authjs.callback-url=x; Path=/"]);
    const { out } = await run("/api/auth/callback/google", "GET", null, response);
    expect(out).toBe(response);
  });

  it("over http there is no other variant to delete", async () => {
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    const response = responseWith([`authjs.session-token=${TOKEN_C}; Path=/; HttpOnly; SameSite=Lax`]);
    const { out } = await run("/api/auth/callback/google", "GET", null, response);
    expect(out).toBe(response);
  });

  it("sign-out: deletes both variants of the configured name", async () => {
    const authjsDeletion = `${HOST}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax`;
    const { out } = await run(
      "/api/auth/signout",
      "POST",
      `${HOST}=${TOKEN_A}; ${HOST}=${TOKEN_B}`,
      responseWith([authjsDeletion]),
    );

    const raw = out.headers.getSetCookie();
    expect(raw).toHaveLength(2);
    expect(raw.every(isDeletionOf(HOST))).toBe(true);
    expect(raw.map(isPartitioned).sort()).toEqual([false, true]);
    expect(raw[1]).toBe(authjsDeletion);
  });

  // Every well-formed token under every known name, both variants; chunks
  // and values outside the alphabet are never handed on.
  it("sign-out: hands every well-formed session token the request carried to events.signOut", async () => {
    const cookie = [
      `${HOST}=${TOKEN_A}`,
      `${HOST}=${TOKEN_B}`,
      `next-auth.session-token=${TOKEN_C}`,
      `${HOST}.0=${TOKEN_C.replace("9", "8")}`,
      `__Secure-authjs.session-token=%61`,
      "authjs.csrf-token=abc",
    ].join("; ");
    const { meta } = await run("/api/auth/signout", "POST", cookie, responseWith([]));
    expect(meta).toMatchObject({ signOutSessionTokens: [TOKEN_A, TOKEN_B, TOKEN_C] });
  });

  // A refused sign-out (Auth.js's CSRF check failed, or no session cookie):
  // Auth.js deleted nothing, so neither does the wrapper.
  it("sign-out that Auth.js refused is returned untouched", async () => {
    const response = responseWith([]);
    const { out } = await run("/api/auth/signout", "POST", `${HOST}=${TOKEN_A}`, response);
    expect(out).toBe(response);
  });

  it.each([
    ["GET /api/auth/signout (the confirmation page)", "/api/auth/signout", "GET"],
    ["POST /api/auth/session (a session refresh)", "/api/auth/session", "POST"],
  ])("leaves %s alone", async (_label, path, method) => {
    const response = responseWith([sessionSet(true)]);
    const { out, meta } = await run(path, method, `${HOST}=${TOKEN_A}`, response);
    expect(out).toBe(response);
    expect(meta).not.toHaveProperty("signOutSessionTokens");
  });

  // Wired into the exported handler: Auth.js's sign-out response comes back
  // with both variants deleted.
  it("is in the exported POST chain", async () => {
    const route = await import("@/app/api/auth/[...nextauth]/route");
    const { handlers } = await import("@/auth");
    const authjsDeletion = `${HOST}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax`;
    vi.mocked(handlers.POST).mockImplementationOnce(async () => responseWith([authjsDeletion]));

    const out = await route.POST(
      new NextRequest("https://app.example.test/api/auth/signout", {
        method: "POST",
        headers: { cookie: `${HOST}=${TOKEN_A}` },
      }),
    );

    const raw = out.headers.getSetCookie();
    expect(raw).toHaveLength(2);
    expect(raw.map(isPartitioned).sort()).toEqual([false, true]);
  });
});
