import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockCheck } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockCheck: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockCheck, clear: vi.fn() }),
}));

// Mock global fetch for HIBP API
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { GET } from "./route";

describe("GET /api/watchtower/hibp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-123" } });
    mockCheck.mockResolvedValue({ allowed: true });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", "http://localhost:3000/api/watchtower/hibp", {
        searchParams: { prefix: "ABCDE" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 on invalid prefix", async () => {
    const res = await GET(
      createRequest("GET", "http://localhost:3000/api/watchtower/hibp", {
        searchParams: { prefix: "short" },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 on missing prefix", async () => {
    const res = await GET(
      createRequest("GET", "http://localhost:3000/api/watchtower/hibp"),
    );
    expect(res.status).toBe(400);
  });

  it("proxies HIBP API and returns result", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve("0123456789ABCDE:5\r\nFEDCBA9876543210:3"),
    });

    const res = await GET(
      createRequest("GET", "http://localhost:3000/api/watchtower/hibp", {
        searchParams: { prefix: "ABCDE" },
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("0123456789ABCDE:5");
    // Verify fetch is called with a timeout signal so requests do not hang indefinitely.
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("returns 502 when HIBP API fails", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    const res = await GET(
      createRequest("GET", "http://localhost:3000/api/watchtower/hibp", {
        searchParams: { prefix: "12345" },
      }),
    );
    expect(res.status).toBe(502);
  });

  it("returns 429 when rate limited", async () => {
    mockCheck.mockResolvedValue({ allowed: false });

    const res = await GET(
      createRequest("GET", "http://localhost:3000/api/watchtower/hibp", {
        searchParams: { prefix: "ABCDE" },
      }),
    );
    expect(res.status).toBe(429);
  });

  it("uses userId-based rate limit key", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve("data"),
    });

    await GET(
      createRequest("GET", "http://localhost:3000/api/watchtower/hibp", {
        searchParams: { prefix: "ABCDE" },
      }),
    );
    expect(mockCheck).toHaveBeenCalledWith("rl:hibp:user-123");
  });

  it("returns 502 when fetch times out (TimeoutError)", async () => {
    const timeoutError = Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
    mockFetch.mockRejectedValue(timeoutError);

    // Use a prefix not used in other tests to avoid the in-memory cache
    const res = await GET(
      createRequest("GET", "http://localhost:3000/api/watchtower/hibp", {
        searchParams: { prefix: "00000" },
      }),
    );
    expect(res.status).toBe(502);
  });

  it("returns 502 when fetch is aborted (AbortError)", async () => {
    const abortError = Object.assign(new Error("The user aborted a request."), { name: "AbortError" });
    mockFetch.mockRejectedValue(abortError);

    // Use a prefix not used in other tests to avoid the in-memory cache
    const res = await GET(
      createRequest("GET", "http://localhost:3000/api/watchtower/hibp", {
        searchParams: { prefix: "11111" },
      }),
    );
    expect(res.status).toBe(502);
  });

  it("re-throws unexpected fetch errors", async () => {
    mockFetch.mockRejectedValue(new Error("unexpected network error"));

    // Use a prefix not used in other tests to avoid the in-memory cache
    await expect(
      GET(
        createRequest("GET", "http://localhost:3000/api/watchtower/hibp", {
          searchParams: { prefix: "22222" },
        }),
      ),
    ).rejects.toThrow("unexpected network error");
  });

  it("evicts oldest entries FIFO at the cache cap instead of clearing everything", async () => {
    // Fresh module instance so the module-scoped cache starts empty and this
    // fill-to-cap state neither pollutes nor depends on the other tests'
    // reserved prefixes. Hoisted vi.mock declarations re-apply on re-import.
    vi.resetModules();
    const { GET: freshGET } = await import("./route");
    const MAX_CACHE_ENTRIES = 5_000; // mirrors the route's module-private constant

    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve("CAFE0:1"),
    });

    const prefixOf = (i: number) => i.toString(16).toUpperCase().padStart(5, "0");
    const request = (prefix: string) =>
      freshGET(
        createRequest("GET", "http://localhost:3000/api/watchtower/hibp", {
          searchParams: { prefix },
        }),
      );

    // Fill exactly to the cap (indices 0 .. MAX-1); every request misses.
    for (let i = 0; i < MAX_CACHE_ENTRIES; i++) {
      await request(prefixOf(i));
    }
    expect(mockFetch).toHaveBeenCalledTimes(MAX_CACHE_ENTRIES);

    // One more insert triggers eviction of exactly the oldest entry.
    await request(prefixOf(MAX_CACHE_ENTRIES));
    expect(mockFetch).toHaveBeenCalledTimes(MAX_CACHE_ENTRIES + 1);

    // A pre-capping-insert entry (the last one of the fill loop, NOT the entry
    // that triggered eviction) must still be served from cache: under FIFO only
    // the oldest entry is evicted, while a cache.clear() regression would wipe
    // it and force an upstream refetch.
    await request(prefixOf(MAX_CACHE_ENTRIES - 1));
    expect(mockFetch).toHaveBeenCalledTimes(MAX_CACHE_ENTRIES + 1);

    // The oldest entry was evicted and must refetch upstream.
    await request(prefixOf(0));
    expect(mockFetch).toHaveBeenCalledTimes(MAX_CACHE_ENTRIES + 2);
  });
});
