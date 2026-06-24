import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";
import { createRequest } from "@/__tests__/helpers/request-builder";

// ─── Hoisted mocks ───────────────────────────────────────────────────────────

const {
  mockValidateExtensionToken,
  mockEnforceAccessRestriction,
  mockValidateAndFetch,
  mockUserLimiterCheck,
  mockGlobalLimiterCheck,
  mockFindUnique,
} = vi.hoisted(() => ({
  mockValidateExtensionToken: vi.fn(),
  mockEnforceAccessRestriction: vi.fn().mockResolvedValue(null),
  mockValidateAndFetch: vi.fn(),
  mockUserLimiterCheck: vi.fn(),
  mockGlobalLimiterCheck: vi.fn(),
  mockFindUnique: vi.fn(),
}));

vi.mock("@/lib/auth/tokens/extension-token", () => ({
  validateExtensionToken: mockValidateExtensionToken,
}));

vi.mock("@/lib/auth/policy/access-restriction", () => ({
  enforceAccessRestriction: mockEnforceAccessRestriction,
}));

vi.mock("@/lib/http/external-http", () => ({
  validateAndFetchBuffered: mockValidateAndFetch,
}));

// Mock createRateLimiter: distinguish user limiter (max=300) from global (max=5000)
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: vi.fn((opts: { max: number }) => {
    const checkFn = opts.max === 5000 ? mockGlobalLimiterCheck : mockUserLimiterCheck;
    return { check: checkFn, clear: vi.fn() };
  }),
}));

// Mock Redis so cache layer is in-memory only
vi.mock("@/lib/redis", () => ({ getRedis: () => null }));

// Mock prisma with controllable user.findUnique
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ user: { findUnique: mockFindUnique } }),
    user: { findUnique: mockFindUnique },
  },
}));

// Mock withTenantRls to call fn with a tx-like object
vi.mock("@/lib/tenant-rls", () => ({
  withTenantRls: async (
    _prisma: unknown,
    _tenantId: string,
    fn: (tx: { user: { findUnique: typeof mockFindUnique } }) => Promise<unknown>,
  ) => fn({ user: { findUnique: mockFindUnique } }),
}));

// T10: import the proxy module and the route; spy confirms route uses proxy helpers
import * as proxy from "@/lib/favicon/favicon-proxy";
import { GET } from "./route";
import { __clearFaviconCache, setCachedFavicon } from "@/lib/favicon/favicon-proxy";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const USER_ID = "11111111-1111-1111-1111-111111111111";
const TENANT_ID = "22222222-2222-2222-2222-222222222222";
const TOKEN_ID = "33333333-3333-4333-8333-333333333333";

function faviconRequest(host: string, size: string) {
  return createRequest("GET", "http://localhost/api/mobile/favicon", {
    searchParams: { host, size },
    headers: {
      authorization: "DPoP access-token-here",
      dpop: "fake.proof",
    },
  });
}

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10]);

function buffered(body: Uint8Array, contentType: string | null, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    contentType,
    body: Buffer.from(body),
  };
}

function authOk(overrides: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    data: {
      tokenId: TOKEN_ID,
      userId: USER_ID,
      tenantId: TENANT_ID,
      clientKind: "IOS_APP" as const,
      scopes: ["passwords:read"],
      expiresAt: new Date("2099-01-01"),
      familyId: "fam-1",
      familyCreatedAt: new Date(),
      ...overrides,
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("GET /api/mobile/favicon", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __clearFaviconCache();

    // Default: valid IOS_APP token
    mockValidateExtensionToken.mockResolvedValue(authOk());

    // Default: access not restricted
    mockEnforceAccessRestriction.mockResolvedValue(null);

    // Default: user has favicons enabled
    mockFindUnique.mockResolvedValue({ fetchFavicons: true });

    // Default: both limiters allow
    mockUserLimiterCheck.mockResolvedValue({ allowed: true });
    mockGlobalLimiterCheck.mockResolvedValue({ allowed: true });

    // Default: upstream returns PNG
    mockValidateAndFetch.mockResolvedValue(buffered(PNG_BYTES, "image/png"));
  });

  // ── Auth ─────────────────────────────────────────────────────────────────

  it("returns 401 when token is invalid", async () => {
    mockValidateExtensionToken.mockResolvedValue({
      ok: false,
      error: "EXTENSION_TOKEN_INVALID",
    });
    const res = await GET(faviconRequest("github.com", "32"));
    expect(res.status).toBe(401);
    expect(mockValidateAndFetch).not.toHaveBeenCalled();
  });

  it("returns 403 when clientKind is not IOS_APP", async () => {
    mockValidateExtensionToken.mockResolvedValue(
      authOk({ clientKind: "BROWSER_EXTENSION" }),
    );
    const res = await GET(faviconRequest("github.com", "32"));
    expect(res.status).toBe(403);
    expect(mockValidateAndFetch).not.toHaveBeenCalled();
  });

  it("returns 403 when clientKind is IOS_AUTOFILL", async () => {
    mockValidateExtensionToken.mockResolvedValue(
      authOk({ clientKind: "IOS_AUTOFILL" }),
    );
    const res = await GET(faviconRequest("github.com", "32"));
    expect(res.status).toBe(403);
    expect(mockValidateAndFetch).not.toHaveBeenCalled();
  });

  it("returns the access-restriction denial when the tenant IP policy rejects", async () => {
    mockEnforceAccessRestriction.mockResolvedValue(
      NextResponse.json({ error: "ACCESS_DENIED" }, { status: 403 }),
    );
    const res = await GET(faviconRequest("github.com", "32"));
    expect(res.status).toBe(403);
    expect(mockValidateAndFetch).not.toHaveBeenCalled();
  });

  // ── Opt-in guard ─────────────────────────────────────────────────────────

  it("returns 403 when fetchFavicons is false — no upstream fetch", async () => {
    mockFindUnique.mockResolvedValue({ fetchFavicons: false });
    const res = await GET(faviconRequest("github.com", "32"));
    expect(res.status).toBe(403);
    expect(mockValidateAndFetch).not.toHaveBeenCalled();
  });

  it("returns 403 when fetchFavicons is undefined (null row) — no upstream fetch", async () => {
    mockFindUnique.mockResolvedValue(null);
    const res = await GET(faviconRequest("github.com", "32"));
    expect(res.status).toBe(403);
    expect(mockValidateAndFetch).not.toHaveBeenCalled();
  });

  // ── Happy path ───────────────────────────────────────────────────────────

  it("returns 200 with image bytes on success", async () => {
    const res = await GET(faviconRequest("example.com", "64"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf).toEqual(PNG_BYTES);
  });

  it("returns 200 with ETag and cache-control headers", async () => {
    const res = await GET(faviconRequest("github.com", "32"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(res.headers.get("etag")).toMatch(/^W\//);
  });

  // ── R1: proxy helper reuse ────────────────────────────────────────────────

  it("T10: uses proxy.normalizeFaviconHost (not a re-declaration)", async () => {
    const spy = vi.spyOn(proxy, "normalizeFaviconHost");
    await GET(faviconRequest("www.github.com", "32"));
    expect(spy).toHaveBeenCalledWith("www.github.com");
    spy.mockRestore();
  });

  // ── Cache behavior ───────────────────────────────────────────────────────

  it("cache hit: second request for the same host does not re-fetch", async () => {
    await GET(faviconRequest("github.com", "32"));
    const res2 = await GET(faviconRequest("github.com", "32"));
    expect(res2.status).toBe(200);
    expect(mockValidateAndFetch).toHaveBeenCalledTimes(1);
  });

  it("cache hits do NOT consume the rate limiter", async () => {
    await setCachedFavicon("github.com", 32, Buffer.from(PNG_BYTES), "image/png");
    const res = await GET(faviconRequest("github.com", "32"));
    expect(res.status).toBe(200);
    expect(mockUserLimiterCheck).not.toHaveBeenCalled();
    expect(mockGlobalLimiterCheck).not.toHaveBeenCalled();
  });

  // ── Rate limiting ────────────────────────────────────────────────────────

  it("returns 429 when user rate limit exceeded on cache miss", async () => {
    mockUserLimiterCheck.mockResolvedValue({ allowed: false, retryAfterMs: 30000 });
    const res = await GET(faviconRequest("uncached.example", "32"));
    expect(res.status).toBe(429);
    expect(mockValidateAndFetch).not.toHaveBeenCalled();
  });

  it("returns 429 when global rate limit exceeded on cache miss", async () => {
    mockGlobalLimiterCheck.mockResolvedValue({ allowed: false, retryAfterMs: 5000 });
    const res = await GET(faviconRequest("uncached.example", "32"));
    expect(res.status).toBe(429);
    expect(mockValidateAndFetch).not.toHaveBeenCalled();
  });

  it("rate-limit key uses userId (rl:favicon:<userId>)", async () => {
    // Force a cache miss so the limiter is checked
    await GET(faviconRequest("github.com", "32"));
    expect(mockUserLimiterCheck).toHaveBeenCalledWith(`rl:favicon:${USER_ID}`);
    expect(mockGlobalLimiterCheck).toHaveBeenCalledWith("rl:favicon:global");
  });

  // ── Single-flight ────────────────────────────────────────────────────────

  it("single-flight: 3 concurrent misses for the same host trigger ONE upstream fetch", async () => {
    let resolveFetch!: (r: ReturnType<typeof buffered>) => void;
    mockValidateAndFetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const inflight = Promise.all([
      GET(faviconRequest("github.com", "32")),
      GET(faviconRequest("github.com", "32")),
      GET(faviconRequest("github.com", "32")),
    ]);
    await vi.waitFor(() => expect(resolveFetch).toBeTypeOf("function"));
    resolveFetch(buffered(PNG_BYTES, "image/png"));
    const [r1, r2, r3] = await inflight;

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);
    expect(mockValidateAndFetch).toHaveBeenCalledTimes(1);
  });

  // ── Validation ───────────────────────────────────────────────────────────

  it("returns 400 for host with special chars (& smuggling)", async () => {
    const res = await GET(faviconRequest("github.com&size=16", "32"));
    expect(res.status).toBe(400);
    expect(mockValidateAndFetch).not.toHaveBeenCalled();
  });

  it("returns 400 for IP literal host (169.254.169.254)", async () => {
    const res = await GET(faviconRequest("169.254.169.254", "32"));
    expect(res.status).toBe(400);
    expect(mockValidateAndFetch).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid size (not 32 or 64)", async () => {
    const res = await GET(faviconRequest("github.com", "16"));
    expect(res.status).toBe(400);
  });

  // ── 204 fallbacks ────────────────────────────────────────────────────────

  it("returns 204 when upstream returns non-image content-type", async () => {
    mockValidateAndFetch.mockResolvedValue(
      buffered(new Uint8Array([1, 2, 3]), "text/html"),
    );
    const res = await GET(faviconRequest("example.com", "32"));
    expect(res.status).toBe(204);
  });

  it("returns 204 for image/svg+xml — SVG is active content", async () => {
    mockValidateAndFetch.mockResolvedValue(
      buffered(new TextEncoder().encode("<svg onload='alert(1)'/>"), "image/svg+xml"),
    );
    const res = await GET(faviconRequest("example.com", "32"));
    expect(res.status).toBe(204);
  });

  it("returns 204 for an SVG already in cache (serving-boundary re-validation)", async () => {
    await setCachedFavicon(
      "example.com",
      32,
      Buffer.from("<svg onload='alert(1)'/>"),
      "image/svg+xml",
    );
    const res = await GET(faviconRequest("example.com", "32"));
    expect(res.status).toBe(204);
    expect(mockValidateAndFetch).not.toHaveBeenCalled();
  });

  it("returns 204 when buffered fetch rejects (network / 3xx redirect)", async () => {
    mockValidateAndFetch.mockRejectedValue(new Error("redirect blocked"));
    const res = await GET(faviconRequest("example.com", "32"));
    expect(res.status).toBe(204);
  });

  it("returns 204 when upstream response is not ok", async () => {
    mockValidateAndFetch.mockResolvedValue(buffered(PNG_BYTES, "image/png", 404));
    const res = await GET(faviconRequest("example.com", "32"));
    expect(res.status).toBe(204);
  });

  it("returns 204 with long cache-control header", async () => {
    mockValidateAndFetch.mockRejectedValue(new Error("fail"));
    const res = await GET(faviconRequest("example.com", "32"));
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("private, max-age=3600");
  });

  // ── Pool-safe buffer response ─────────────────────────────────────────────

  it("returns exact favicon bytes when cache holds a pool-aliased Buffer", async () => {
    const distinctive = new Uint8Array(5000);
    for (let i = 0; i < distinctive.length; i++) distinctive[i] = (i % 251) + 1;
    const backing = new ArrayBuffer(65536);
    const offset = 88;
    new Uint8Array(backing, offset, distinctive.length).set(distinctive);
    const aliased = Buffer.from(backing, offset, distinctive.length);
    expect(aliased.buffer.byteLength).toBeGreaterThan(aliased.length);
    expect(aliased.byteOffset).toBeGreaterThan(0);
    await setCachedFavicon("example.com", 32, aliased, "image/png");

    const res = await GET(faviconRequest("example.com", "32"));
    expect(res.status).toBe(200);
    expect(mockValidateAndFetch).not.toHaveBeenCalled();
    const out = new Uint8Array(await res.arrayBuffer());
    expect(out.length).toBe(distinctive.length);
    expect(out).toEqual(distinctive);
  });

  // ── www. stripping + size passthrough ─────────────────────────────────────

  it("strips www. prefix and passes size to the provider URL", async () => {
    await GET(faviconRequest("www.github.com", "32"));
    expect(mockValidateAndFetch).toHaveBeenCalledWith(
      expect.stringContaining("github.com"),
      expect.anything(),
    );
    expect(mockValidateAndFetch).toHaveBeenCalledWith(
      expect.stringContaining("size=32"),
      expect.anything(),
    );
    // Second request for bare host must be a cache hit
    const res2 = await GET(faviconRequest("github.com", "32"));
    expect(res2.status).toBe(200);
    expect(mockValidateAndFetch).toHaveBeenCalledTimes(1);
  });
});
