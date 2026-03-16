import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockCheck } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockCheck: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/rate-limit", () => ({
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
});
