import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { validateRedisConfig } from "@/lib/redis";

describe("createRateLimiter", () => {
  it("allows requests within the limit", async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 3 });

    expect((await limiter.check("key1")).allowed).toBe(true);
    expect((await limiter.check("key1")).allowed).toBe(true);
    expect((await limiter.check("key1")).allowed).toBe(true);
  });

  it("blocks requests exceeding the limit", async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2 });

    expect((await limiter.check("key2")).allowed).toBe(true);
    expect((await limiter.check("key2")).allowed).toBe(true);
    expect((await limiter.check("key2")).allowed).toBe(false);
  });

  it("tracks different keys independently", async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });

    expect((await limiter.check("keyA")).allowed).toBe(true);
    expect((await limiter.check("keyB")).allowed).toBe(true);
    expect((await limiter.check("keyA")).allowed).toBe(false);
    expect((await limiter.check("keyB")).allowed).toBe(false);
  });

  it("clears a specific key counter", async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });

    expect((await limiter.check("key3")).allowed).toBe(true);
    expect((await limiter.check("key3")).allowed).toBe(false);

    await limiter.clear("key3");
    expect((await limiter.check("key3")).allowed).toBe(true);
  });

  it("resets counter after window expires", async () => {
    const limiter = createRateLimiter({ windowMs: 50, max: 1 });

    expect((await limiter.check("key4")).allowed).toBe(true);
    expect((await limiter.check("key4")).allowed).toBe(false);

    // Wait for the window to expire
    await new Promise((r) => setTimeout(r, 60));

    expect((await limiter.check("key4")).allowed).toBe(true);
  });
});

describe("createRateLimiter — Redis pipeline", () => {
  // Mock ioredis so that getRedis() returns our fake client
  const mockExec = vi.fn();
  const mockPexpire = vi.fn().mockReturnThis();
  const mockIncr = vi.fn().mockReturnThis();
  const mockPttl = vi.fn().mockReturnThis();

  beforeEach(() => {
    vi.clearAllMocks();
    // Provide a REDIS_URL so that getRedis() creates a client
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    // Reset the cached Redis singleton so next test gets a fresh mock
    (globalThis as Record<string, unknown>).redisClient = undefined;
  });

  // Helper: inject a fake Redis client into the global singleton slot
  function injectFakeRedis(overrides?: { exec?: ReturnType<typeof vi.fn> }) {
    const exec = overrides?.exec ?? mockExec;
    const pipeline = vi.fn(() => ({
      incr: mockIncr,
      pexpire: mockPexpire,
      pttl: mockPttl,
      exec,
    }));
    const fakeRedis = { pipeline };
    (globalThis as Record<string, unknown>).redisClient = fakeRedis;
    return { pipeline, exec };
  }

  it("calls pipeline() instead of individual incr/pexpire/pttl commands", async () => {
    const { pipeline } = injectFakeRedis();
    mockExec.mockResolvedValue([
      [null, 1],
      [null, 1],
      [null, 50000],
    ]);

    const limiter = createRateLimiter({ windowMs: 60_000, max: 10 });
    await limiter.check("redis-key1");

    expect(pipeline).toHaveBeenCalledTimes(1);
    expect(mockIncr).toHaveBeenCalledWith("redis-key1");
    expect(mockPexpire).toHaveBeenCalledWith("redis-key1", 60_000, "NX");
    expect(mockPttl).toHaveBeenCalledWith("redis-key1");
  });

  it("uses NX flag with pexpire to only set TTL on first increment", async () => {
    injectFakeRedis();
    mockExec.mockResolvedValue([
      [null, 1],
      [null, 1],
      [null, 59000],
    ]);

    const limiter = createRateLimiter({ windowMs: 60_000, max: 10 });
    await limiter.check("redis-key2");

    // pexpire must be called with "NX" as third argument
    expect(mockPexpire).toHaveBeenCalledWith("redis-key2", 60_000, "NX");
  });

  it("executes all 3 commands in a single pipeline exec() call", async () => {
    const exec = vi.fn().mockResolvedValue([
      [null, 1],
      [null, 1],
      [null, 50000],
    ]);
    injectFakeRedis({ exec });

    const limiter = createRateLimiter({ windowMs: 60_000, max: 10 });
    await limiter.check("redis-key3");

    // Only one exec() call should have been made, containing all 3 commands
    expect(exec).toHaveBeenCalledTimes(1);
    // All 3 command methods must have been called before exec
    expect(mockIncr).toHaveBeenCalledTimes(1);
    expect(mockPexpire).toHaveBeenCalledTimes(1);
    expect(mockPttl).toHaveBeenCalledTimes(1);
  });

  it("rate-limited response includes correct retryAfter from PTTL", async () => {
    injectFakeRedis();
    const pttlValue = 42_000;
    mockExec.mockResolvedValue([
      [null, 6],      // count = 6 (> max=5)
      [null, 0],      // pexpire result
      [null, pttlValue], // pttl = 42000ms
    ]);

    const limiter = createRateLimiter({ windowMs: 60_000, max: 5 });
    const result = await limiter.check("redis-key4");

    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBe(pttlValue);
  });

  it("falls back to in-memory when pipeline exec() throws", async () => {
    injectFakeRedis();
    mockExec.mockRejectedValue(new Error("Redis connection refused"));

    const limiter = createRateLimiter({ windowMs: 60_000, max: 3 });
    // Should not throw; falls back to in-memory and allows request
    const result = await limiter.check("redis-fallback");

    expect(result.allowed).toBe(true);
  });
});

describe("validateRedisConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws in production when REDIS_URL is not set", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("REDIS_URL", "");

    expect(() => validateRedisConfig()).toThrow("REDIS_URL is required");
  });

  it("does not throw in production when REDIS_URL is set", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");

    expect(() => validateRedisConfig()).not.toThrow();
  });

  it("does not throw in development when REDIS_URL is not set", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("REDIS_URL", "");

    expect(() => validateRedisConfig()).not.toThrow();
  });

  it("does not throw in test when REDIS_URL is not set", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("REDIS_URL", "");

    expect(() => validateRedisConfig()).not.toThrow();
  });
});
