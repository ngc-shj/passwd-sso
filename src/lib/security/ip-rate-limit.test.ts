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

  // M2 — high-risk opt-in: unknown IP routes through the shared bounded bucket
  // instead of failing open.
  it("routes IP-less requests through unknownIpLimiter with the shared `unknown-ip` key when provided", async () => {
    const primaryCheck = vi.fn();
    const unknownCheck = vi.fn().mockResolvedValue({ allowed: true });
    const res = await checkIpRateLimit({
      ip: null,
      pathname: "/api/x",
      scope: "test_scope",
      limiter: { check: primaryCheck },
      unknownIpLimiter: { check: unknownCheck },
    });
    // Primary (per-IP) limiter is never touched for an IP-less request.
    expect(primaryCheck).not.toHaveBeenCalled();
    expect(unknownCheck).toHaveBeenCalledWith("rl:test_scope:unknown-ip");
    expect(res).toEqual({ allowed: true });
    // Still warns so operators see the IP-less traffic.
    expect(mockWarn).toHaveBeenCalledWith(
      { pathname: "/api/x", scope: "test_scope" },
      "rate_limit_skipped_unknown_ip",
    );
  });

  it("appends keySuffix to the shared unknown-ip key so resources stay partitioned", async () => {
    const unknownCheck = vi.fn().mockResolvedValue({ allowed: true });
    await checkIpRateLimit({
      ip: null,
      pathname: "/s/abc",
      scope: "send_download",
      keySuffix: "tok123",
      limiter: { check: vi.fn() },
      unknownIpLimiter: { check: unknownCheck },
    });
    expect(unknownCheck).toHaveBeenCalledWith("rl:send_download:unknown-ip:tok123");
  });

  it("passes through a deny from the unknownIpLimiter (shared budget exhausted)", async () => {
    const unknownCheck = vi
      .fn()
      .mockResolvedValue({ allowed: false, retryAfterMs: 2000 });
    const res = await checkIpRateLimit({
      ip: null,
      pathname: "/api/x",
      scope: "test_scope",
      limiter: { check: vi.fn() },
      unknownIpLimiter: { check: unknownCheck },
    });
    expect(res).toEqual({ allowed: false, retryAfterMs: 2000 });
  });

  it("still fails open when boundUnknownIp is absent (low-risk default)", async () => {
    const res = await checkIpRateLimit({
      ip: null,
      pathname: "/api/x",
      scope: "low_risk",
      limiter: { check: vi.fn() },
    });
    expect(res).toEqual({ allowed: true });
  });
});

// getUnknownIpLimiter is exercised via boundUnknownIp; mock createRateLimiter so
// the shared bucket is asserted without touching Redis.
describe("checkIpRateLimit boundUnknownIp shared bucket", () => {
  it("uses getUnknownIpLimiter() for the shared bucket when boundUnknownIp is true", async () => {
    vi.resetModules();
    const sharedCheck = vi.fn().mockResolvedValue({ allowed: true });
    vi.doMock("@/lib/logger", () => ({
      getLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
    }));
    vi.doMock("@/lib/auth/policy/ip-access", () => ({
      rateLimitKeyFromIp: (ip: string) => ip,
    }));
    vi.doMock("@/lib/security/rate-limit", () => ({
      createRateLimiter: vi.fn(() => ({ check: sharedCheck })),
    }));
    const mod = await import("./ip-rate-limit");
    const res = await mod.checkIpRateLimit({
      ip: null,
      pathname: "/api/x",
      scope: "high_risk",
      limiter: { check: vi.fn() },
      boundUnknownIp: true,
    });
    expect(sharedCheck).toHaveBeenCalledWith("rl:high_risk:unknown-ip");
    expect(res).toEqual({ allowed: true });
    vi.doUnmock("@/lib/security/rate-limit");
  });
});
