import { beforeEach, describe, expect, it, vi } from "vitest";

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
    mockCheck.mockResolvedValue(true);
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

  it("returns 429 during cooldown", async () => {
    const userId = "cooldown-user";
    mockAuth.mockResolvedValue({ user: { id: userId } });
    mockCheck.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

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
