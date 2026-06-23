import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const {
  mockAuth,
  mockValidateAndFetch,
  mockUserLimiterCheck,
  mockGlobalLimiterCheck,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockValidateAndFetch: vi.fn(),
  mockUserLimiterCheck: vi.fn(),
  mockGlobalLimiterCheck: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));

vi.mock("@/lib/http/external-http", () => ({
  validateAndFetch: mockValidateAndFetch,
}));

// Mock createRateLimiter to return our controllable check fns
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: vi.fn((opts: { max: number }) => {
    // Distinguish user (120) from global (5000) limiter by max
    const checkFn = opts.max === 120 ? mockUserLimiterCheck : mockGlobalLimiterCheck;
    return { check: checkFn, clear: vi.fn() };
  }),
}));

// Mock Redis so cache layer is in-memory only
vi.mock("@/lib/redis", () => ({ getRedis: () => null }));

import { GET } from "./route";
import { __clearFaviconCache, setCachedFavicon } from "@/lib/favicon/favicon-proxy";

// Helper: build a request with query params
function faviconRequest(host: string, size: string) {
  return createRequest("GET", "http://localhost/api/user/favicon", {
    searchParams: { host, size },
  });
}

// Helper: PNG-like bytes
const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10]);

describe("GET /api/user/favicon", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __clearFaviconCache();

    // Default: authenticated user with favicons enabled
    mockAuth.mockResolvedValue({
      user: { id: "user-1", fetchFavicons: true },
    });

    // Default: both limiters allow
    mockUserLimiterCheck.mockResolvedValue({ allowed: true });
    mockGlobalLimiterCheck.mockResolvedValue({ allowed: true });

    // Default: validateAndFetch returns a real PNG response
    mockValidateAndFetch.mockResolvedValue(
      new Response(PNG_BYTES, { headers: { "content-type": "image/png" } }),
    );
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(faviconRequest("github.com", "32"));
    expect(res.status).toBe(401);
  });

  it("returns 403 when fetchFavicons is false — no upstream fetch", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1", fetchFavicons: false },
    });
    const res = await GET(faviconRequest("github.com", "32"));
    expect(res.status).toBe(403);
    expect(mockValidateAndFetch).not.toHaveBeenCalled();
  });

  it("returns 403 when fetchFavicons is undefined — no upstream fetch", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    const res = await GET(faviconRequest("github.com", "32"));
    expect(res.status).toBe(403);
    expect(mockValidateAndFetch).not.toHaveBeenCalled();
  });

  it("calls validateAndFetch when fetchFavicons is true", async () => {
    const res = await GET(faviconRequest("github.com", "32"));
    expect(res.status).toBe(200);
    expect(mockValidateAndFetch).toHaveBeenCalled();
  });

  it("returns 200 with image bytes on success", async () => {
    const res = await GET(faviconRequest("example.com", "64"));
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type");
    expect(ct).toBe("image/png");
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf).toEqual(PNG_BYTES);
  });

  it("cache-hit: second request for same host does not re-fetch", async () => {
    await GET(faviconRequest("github.com", "32"));
    // Clear the in-flight but NOT the memory cache (only __clearFaviconCache does both)
    const res2 = await GET(faviconRequest("github.com", "32"));
    expect(res2.status).toBe(200);
    expect(mockValidateAndFetch).toHaveBeenCalledTimes(1);
  });

  it("single-flight: N concurrent misses for the same host trigger ONE upstream fetch", async () => {
    // Slow-resolving upstream so all three requests overlap in-flight (the
    // sequential cache-hit test above never exercises the inFlight dedup path).
    let resolveFetch!: (r: Response) => void;
    mockValidateAndFetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const inflight = Promise.all([
      GET(faviconRequest("github.com", "32")),
      GET(faviconRequest("github.com", "32")),
      GET(faviconRequest("github.com", "32")),
    ]);
    // Let all three requests progress past their auth/parse/limiter awaits and
    // reach the (single) in-flight upstream fetch before we resolve it.
    await vi.waitFor(() => expect(resolveFetch).toBeTypeOf("function"));
    resolveFetch(
      new Response(PNG_BYTES, { headers: { "content-type": "image/png" } }),
    );
    const [r1, r2, r3] = await inflight;

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);
    // The anti-amplification invariant: 3 concurrent misses → 1 outbound fetch.
    expect(mockValidateAndFetch).toHaveBeenCalledTimes(1);
  });

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

  it("returns 400 for IPv6 literal host", async () => {
    const res = await GET(faviconRequest("::1", "32"));
    expect(res.status).toBe(400);
    expect(mockValidateAndFetch).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid size (not 32 or 64)", async () => {
    const res = await GET(faviconRequest("github.com", "16"));
    expect(res.status).toBe(400);
  });

  it("returns 204 when upstream returns non-image content-type", async () => {
    mockValidateAndFetch.mockResolvedValue(
      new Response("not an image", { headers: { "content-type": "text/html" } }),
    );
    const res = await GET(faviconRequest("example.com", "32"));
    expect(res.status).toBe(204);
  });

  it("returns 204 when validateAndFetch rejects (network / 3xx redirect)", async () => {
    mockValidateAndFetch.mockRejectedValue(new Error("redirect blocked"));
    const res = await GET(faviconRequest("example.com", "32"));
    expect(res.status).toBe(204);
  });

  it("returns 204 when upstream response is not ok", async () => {
    mockValidateAndFetch.mockResolvedValue(
      new Response("not found", { status: 404, headers: { "content-type": "image/png" } }),
    );
    const res = await GET(faviconRequest("example.com", "32"));
    expect(res.status).toBe(204);
  });

  it("returns 204 when body exceeds 256KB — does not cache oversized body", async () => {
    const bigBody = new Uint8Array(256 * 1024 + 1); // 1 byte over cap
    // Each call to mockValidateAndFetch must return a fresh Response
    // (a Response body can only be consumed once)
    mockValidateAndFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(bigBody, { headers: { "content-type": "image/png" } }),
      ),
    );
    const res1 = await GET(faviconRequest("example.com", "32"));
    expect(res1.status).toBe(204);

    // Second call should still go to upstream (not cached)
    const res2 = await GET(faviconRequest("example.com", "32"));
    expect(res2.status).toBe(204);
    expect(mockValidateAndFetch).toHaveBeenCalledTimes(2);
  });

  it("returns 204 with long cache-control header", async () => {
    mockValidateAndFetch.mockRejectedValue(new Error("fail"));
    const res = await GET(faviconRequest("example.com", "32"));
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("private, max-age=3600");
  });

  it("returns 200 with cache-control and ETag headers", async () => {
    const res = await GET(faviconRequest("github.com", "32"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(res.headers.get("etag")).toMatch(/^W\//);
  });

  it("returns 429 when user rate limit exceeded", async () => {
    mockUserLimiterCheck.mockResolvedValue({
      allowed: false,
      retryAfterMs: 30000,
    });
    const res = await GET(faviconRequest("github.com", "32"));
    expect(res.status).toBe(429);
    expect(mockValidateAndFetch).not.toHaveBeenCalled();
  });

  it("returns 429 when global rate limit exceeded", async () => {
    mockGlobalLimiterCheck.mockResolvedValue({
      allowed: false,
      retryAfterMs: 5000,
    });
    const res = await GET(faviconRequest("github.com", "32"));
    expect(res.status).toBe(429);
    expect(mockValidateAndFetch).not.toHaveBeenCalled();
  });

  it("strips www. prefix from host and passes size to the provider URL", async () => {
    await GET(faviconRequest("www.github.com", "32"));
    expect(mockValidateAndFetch).toHaveBeenCalledWith(
      expect.stringContaining("github.com"),
      expect.anything(),
    );
    // Provider URL must carry the bucketed size param (guards against a
    // sz=/size= typo in buildFaviconProviderUrl).
    expect(mockValidateAndFetch).toHaveBeenCalledWith(
      expect.stringContaining("size=32"),
      expect.anything(),
    );
    // Cache key must not contain www.
    // Second request for the bare host must be a cache hit
    const res2 = await GET(faviconRequest("github.com", "32"));
    expect(res2.status).toBe(200);
    expect(mockValidateAndFetch).toHaveBeenCalledTimes(1);
  });

  it("returns exact favicon bytes when cache holds a pool-aliased Buffer", async () => {
    // Regression: Buffer.from(base64) (the Redis cache path) returns a view onto
    // Node's shared 64KB pool (buffer.byteLength=65536, byteOffset>0). Responding
    // with `body.buffer` would leak the entire pool — other requests' bytes — past
    // the favicon. faviconResponse() must slice by offset/length to copy exactly.
    // Seed the cache directly with a pool-aliased Buffer to exercise the response
    // path without a Redis mock.
    const distinctive = new Uint8Array(5000);
    for (let i = 0; i < distinctive.length; i++) distinctive[i] = (i % 251) + 1;
    // Buffer.from(base64) reproduces the exact pool-aliasing the Redis path hits.
    const aliased = Buffer.from(
      Buffer.from(distinctive).toString("base64"),
      "base64",
    );
    expect(aliased.buffer.byteLength).toBeGreaterThan(aliased.length); // pool-backed
    await setCachedFavicon("example.com", 32, aliased, "image/png");

    const res = await GET(faviconRequest("example.com", "32"));
    expect(res.status).toBe(200);
    expect(mockValidateAndFetch).not.toHaveBeenCalled(); // served from cache
    const out = new Uint8Array(await res.arrayBuffer());
    expect(out.length).toBe(distinctive.length); // no trailing pool bytes
    expect(out).toEqual(distinctive);
  });

  it("cache key does not contain & for a smuggled host attempt", async () => {
    // host "github.com&size=16" is rejected before any cache interaction
    const res = await GET(faviconRequest("github.com&size=16", "32"));
    expect(res.status).toBe(400);
    // validateAndFetch never called → no cache population
    expect(mockValidateAndFetch).not.toHaveBeenCalled();
  });
});
