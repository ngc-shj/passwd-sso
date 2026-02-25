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
    const result = await checkScimRateLimit("org-1");
    expect(result).toBe(true);
    expect(mockCheck).toHaveBeenCalledWith("rl:scim:org-1");
  });

  it("returns false when rate limited", async () => {
    mockCheck.mockResolvedValue(false);
    const result = await checkScimRateLimit("org-1");
    expect(result).toBe(false);
  });

  it("uses org-specific key", async () => {
    mockCheck.mockResolvedValue(true);
    await checkScimRateLimit("org-abc");
    expect(mockCheck).toHaveBeenCalledWith("rl:scim:org-abc");
  });
});
