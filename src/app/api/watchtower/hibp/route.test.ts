import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: mockAuth }));

// Mock global fetch for HIBP API
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { GET } from "./route";

describe("GET /api/watchtower/hibp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: `user-${Date.now()}-${Math.random()}` } });
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

  it("rate limits after 30 requests", async () => {
    const userId = `rate-${Date.now()}`;
    mockAuth.mockResolvedValue({ user: { id: userId } });
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve("data"),
    });

    // First 30 should succeed (prefix needs to be different to avoid cache)
    for (let i = 0; i < 30; i++) {
      const prefix = `${String(i).padStart(5, "0").slice(0, 5).toUpperCase()}`;
      // Generate valid 5-char hex prefix
      const validPrefix = i.toString(16).padStart(5, "0").toUpperCase().slice(0, 5);
      const res = await GET(
        createRequest("GET", "http://localhost:3000/api/watchtower/hibp", {
          searchParams: { prefix: validPrefix },
        }),
      );
      expect(res.status).toBe(200);
    }

    // 31st should be rate limited
    const res = await GET(
      createRequest("GET", "http://localhost:3000/api/watchtower/hibp", {
        searchParams: { prefix: "FFFFF" },
      }),
    );
    expect(res.status).toBe(429);
  });
});
