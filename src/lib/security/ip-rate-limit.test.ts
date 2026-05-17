import { describe, it, expect, vi, beforeEach } from "vitest";

const mockWarn = vi.fn();
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ warn: mockWarn, error: vi.fn(), info: vi.fn() }),
}));

// Identity passthrough so the assertion against the key value is readable.
// The actual IPv6→/64 normalization is covered by ip-access.test.ts; do
// not duplicate that contract here.
vi.mock("@/lib/auth/policy/ip-access", () => ({
  rateLimitKeyFromIp: (ip: string) => ip,
}));

import { checkIpRateLimit } from "./ip-rate-limit";

describe("checkIpRateLimit", () => {
  beforeEach(() => {
    mockWarn.mockReset();
  });

  it("forwards to the limiter with `rl:<scope>:<ip>` key when ip is present", async () => {
    const check = vi.fn().mockResolvedValue({ allowed: true });
    const res = await checkIpRateLimit({
      ip: "203.0.113.5",
      pathname: "/api/x",
      scope: "test_scope",
      limiter: { check },
    });
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith("rl:test_scope:203.0.113.5");
    expect(res).toEqual({ allowed: true });
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("passes through the limiter's deny result (allowed=false, retryAfterMs)", async () => {
    const check = vi.fn().mockResolvedValue({ allowed: false, retryAfterMs: 1500 });
    const res = await checkIpRateLimit({
      ip: "203.0.113.5",
      pathname: "/api/x",
      scope: "test_scope",
      limiter: { check },
    });
    expect(res).toEqual({ allowed: false, retryAfterMs: 1500 });
  });

  it("fails open (allowed=true) with a warn log when ip is null", async () => {
    const check = vi.fn();
    const res = await checkIpRateLimit({
      ip: null,
      pathname: "/api/x",
      scope: "test_scope",
      limiter: { check },
    });
    expect(check).not.toHaveBeenCalled();
    expect(res).toEqual({ allowed: true });
    expect(mockWarn).toHaveBeenCalledWith(
      { pathname: "/api/x", scope: "test_scope" },
      "rate_limit_skipped_unknown_ip",
    );
  });

  // AC1.5 — wrapper propagates redisErrored from inner limiter
  it("propagates redisErrored: true from the inner limiter to the caller", async () => {
    const check = vi.fn().mockResolvedValue({ allowed: false, redisErrored: true });
    const res = await checkIpRateLimit({
      ip: "203.0.113.5",
      pathname: "/api/x",
      scope: "test_scope",
      limiter: { check },
    });
    expect(res).toEqual({ allowed: false, redisErrored: true });
  });
});
