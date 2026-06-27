import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockCheck } = vi.hoisted(() => ({
  mockCheck: vi.fn(),
}));

vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({
    check: mockCheck,
  }),
}));

import { checkScimRateLimit } from "./rate-limit";

describe("checkScimRateLimit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the allowed result when within rate limit", async () => {
    mockCheck.mockResolvedValue({ allowed: true });
    const result = await checkScimRateLimit("team-1");
    expect(result.allowed).toBe(true);
    expect(mockCheck).toHaveBeenCalledWith("rl:scim:team-1");
  });

  it("returns the denied result when rate limited", async () => {
    mockCheck.mockResolvedValue({ allowed: false, retryAfterMs: 1000 });
    const result = await checkScimRateLimit("team-1");
    expect(result.allowed).toBe(false);
  });

  it("propagates redisErrored so the caller can fail closed (503)", async () => {
    mockCheck.mockResolvedValue({ allowed: false, redisErrored: true });
    const result = await checkScimRateLimit("team-1");
    expect(result.allowed).toBe(false);
    expect(result.redisErrored).toBe(true);
  });

  it("uses team-specific key", async () => {
    mockCheck.mockResolvedValue({ allowed: true });
    await checkScimRateLimit("team-abc");
    expect(mockCheck).toHaveBeenCalledWith("rl:scim:team-abc");
  });
});
