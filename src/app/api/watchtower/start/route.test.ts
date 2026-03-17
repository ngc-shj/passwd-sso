import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockAuth, mockCheck } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockCheck: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: vi.fn(() => ({
    check: mockCheck,
    clear: vi.fn(),
  })),
}));

import { POST } from "./route";

describe("POST /api/watchtower/start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheck.mockResolvedValue({ allowed: true });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST();
    expect(res.status).toBe(401);
  });

  it("starts scan when no cooldown exists", async () => {
    mockAuth.mockResolvedValue({ user: { id: `user-${Date.now()}` } });
    const res = await POST();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(mockCheck).toHaveBeenCalledTimes(1);
    expect(mockCheck.mock.calls[0][0]).toContain("rl:watchtower:start:");
  });

  it("accepts NextRequest argument", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-req-test" } });
    const req = new NextRequest("http://localhost:3000/api/watchtower/start", {
      method: "POST",
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(Object.keys(json)).toContain("ok");
    expect(typeof json.ok).toBe("boolean");
  });

  it("returns 429 during cooldown", async () => {
    const userId = "cooldown-user";
    mockAuth.mockResolvedValue({ user: { id: userId } });
    mockCheck.mockResolvedValueOnce({ allowed: true }).mockResolvedValueOnce({ allowed: false });

    const first = await POST();
    expect(first.status).toBe(200);

    const second = await POST();
    expect(second.status).toBe(429);
    const body = await second.json();
    expect(body.error).toBe("RATE_LIMIT_EXCEEDED");
    expect(mockCheck).toHaveBeenLastCalledWith(
      `rl:watchtower:start:${userId}`
    );
  });
});
