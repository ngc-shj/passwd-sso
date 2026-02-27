import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockCheck } = vi.hoisted(() => ({
  mockCheck: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({
    check: mockCheck,
  }),
}));

import { checkScimRateLimit } from "./rate-limit";

describe("checkScimRateLimit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true when within rate limit", async () => {
    mockCheck.mockResolvedValue(true);
    const result = await checkScimRateLimit("team-1");
    expect(result).toBe(true);
    expect(mockCheck).toHaveBeenCalledWith("rl:scim:team-1");
  });

  it("returns false when rate limited", async () => {
    mockCheck.mockResolvedValue(false);
    const result = await checkScimRateLimit("team-1");
    expect(result).toBe(false);
  });

  it("uses team-specific key", async () => {
    mockCheck.mockResolvedValue(true);
    await checkScimRateLimit("team-abc");
    expect(mockCheck).toHaveBeenCalledWith("rl:scim:team-abc");
  });
});
