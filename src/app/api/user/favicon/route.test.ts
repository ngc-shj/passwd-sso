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
  validateAndFetchBuffered: mockValidateAndFetch,
}));

// Mock createRateLimiter to return our controllable check fns
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: vi.fn((opts: { max: number }) => {
    // Distinguish the per-user limiter from the global one by max. The global
    // cap is 5000; anything else is the per-user limiter (currently 300).
    const checkFn = opts.max === 5000 ? mockGlobalLimiterCheck : mockUserLimiterCheck;
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

// Build a ValidatedFetchResult (the buffered helper's return shape) so the mock
// matches what validateAndFetchBuffered actually resolves (RT1 mock-reality).
function buffered(
  body: Uint8Array,
  contentType: string | null,
  status = 200,
) {
  return {
    ok: status >= 200 && status < 300,
    status,
    contentType,
    body: Buffer.from(body),
  };
}

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

    // Default: the buffered fetch returns a real PNG result
    mockValidateAndFetch.mockResolvedValue(buffered(PNG_BYTES, "image/png"));
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

  it("cache hits and 204s do NOT consume the rate limiter (only outbound fetches do)", async () => {
    // Regression for the 429-on-reload bug: rate-limiting ran before the cache
    // lookup, so a re-render of an all-cached list exhausted the window. The
    // limiter must only count genuine cache MISSES (outbound fetches).
    await setCachedFavicon("github.com", 32, Buffer.from(PNG_BYTES), "image/png");
    const res = await GET(faviconRequest("github.com", "32"));
    expect(res.status).toBe(200);
    expect(mockUserLimiterCheck).not.toHaveBeenCalled();
    expect(mockGlobalLimiterCheck).not.toHaveBeenCalled();
  });

  it("403 (opted out) does NOT consume the rate limiter", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-1", fetchFavicons: false } });
    const res = await GET(faviconRequest("github.com", "32"));
    expect(res.status).toBe(403);
    expect(mockUserLimiterCheck).not.toHaveBeenCalled();
  });

  it("a cache MISS does consume the rate limiter (429 when exceeded)", async () => {
    mockUserLimiterCheck.mockResolvedValue({ allowed: false, retryAfterMs: 30000 });
    const res = await GET(faviconRequest("uncached.example", "32"));
    expect(res.status).toBe(429);
    expect(mockValidateAndFetch).not.toHaveBeenCalled();
  });

  it("single-flight: N concurrent misses for the same host trigger ONE upstream fetch", async () => {
    // Slow-resolving upstream so all three requests overlap in-flight (the
    // sequential cache-hit test above never exercises the inFlight dedup path).
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
    // Let all three requests progress past their auth/parse/limiter awaits and
    // reach the (single) in-flight upstream fetch before we resolve it.
    await vi.waitFor(() => expect(resolveFetch).toBeTypeOf("function"));
    resolveFetch(buffered(PNG_BYTES, "image/png"));
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
      buffered(new Uint8Array([1, 2, 3]), "text/html"),
    );
    const res = await GET(faviconRequest("example.com", "32"));
    expect(res.status).toBe(204);
  });

  it("returns 204 for image/svg+xml — SVG is active content, never re-served same-origin", async () => {
    mockValidateAndFetch.mockResolvedValue(
      buffered(new TextEncoder().encode("<svg onload='alert(1)'/>"), "image/svg+xml"),
    );
    const res = await GET(faviconRequest("example.com", "32"));
    expect(res.status).toBe(204);
  });

  it("returns 204 for an SVG already in the cache (serving-boundary re-validation)", async () => {
    // A SVG seeded by the pre-allowlist code (or any cache poisoning) must NOT be
    // re-served same-origin on a cache hit — the MIME guard runs on serve, not
    // just on ingestion.
    await setCachedFavicon(
      "example.com",
      32,
      Buffer.from("<svg onload='alert(1)'/>"),
      "image/svg+xml",
    );
    const res = await GET(faviconRequest("example.com", "32"));
    expect(res.status).toBe(204);
    // Served from cache → no upstream fetch.
    expect(mockValidateAndFetch).not.toHaveBeenCalled();
  });

  it("serves image/png with the charset parameter stripped from the allowlist match", async () => {
    mockValidateAndFetch.mockResolvedValue(
      buffered(PNG_BYTES, "image/png; charset=binary"),
    );
    const res = await GET(faviconRequest("example.com", "32"));
    expect(res.status).toBe(200);
  });

  it("returns 204 when the buffered fetch rejects (network / 3xx redirect)", async () => {
    mockValidateAndFetch.mockRejectedValue(new Error("redirect blocked"));
    const res = await GET(faviconRequest("example.com", "32"));
    expect(res.status).toBe(204);
  });

  it("returns 204 when upstream response is not ok", async () => {
    mockValidateAndFetch.mockResolvedValue(
      buffered(PNG_BYTES, "image/png", 404),
    );
    const res = await GET(faviconRequest("example.com", "32"));
    expect(res.status).toBe(204);
  });

  it("returns 204 when body exceeds 256KB — over-cap rejects, nothing cached", async () => {
    // The buffered helper enforces maxBytes and throws RangeError on over-cap;
    // the route maps the throw to its 204 fallback.
    mockValidateAndFetch.mockRejectedValue(
      new RangeError("body exceeded maxBytes (262144)"),
    );
    const res1 = await GET(faviconRequest("example.com", "32"));
    expect(res1.status).toBe(204);

    // Second call should still go to upstream (nothing was cached).
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
    // Construct a DETERMINISTICALLY pool-aliased Buffer: a view into a larger
    // backing ArrayBuffer at a non-zero offset, exactly the shape Buffer.from(
    // base64) produces on the Redis path (buffer.byteLength > length, byteOffset
    // > 0). Building it explicitly avoids relying on Node's non-deterministic
    // Buffer pooling, which is env-dependent and flaked in CI (a fresh exact-size
    // allocation made buffer.byteLength === length).
    const backing = new ArrayBuffer(65536);
    const offset = 88;
    new Uint8Array(backing, offset, distinctive.length).set(distinctive);
    const aliased = Buffer.from(backing, offset, distinctive.length);
    expect(aliased.buffer.byteLength).toBeGreaterThan(aliased.length); // pool-backed shape
    expect(aliased.byteOffset).toBeGreaterThan(0);
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
