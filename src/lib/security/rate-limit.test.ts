/**
 * Tests for createRateLimiter — fixed-window rate limiter with Redis-first
 * (preferred) and in-memory fallback.
 *
 * Mock surface (allowlist):
 *   - "@/lib/redis"  : controllable getRedis() stub
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetRedis = vi.hoisted(() => vi.fn());
vi.mock("@/lib/redis", () => ({
  getRedis: mockGetRedis,
}));

import { createRateLimiter } from "./rate-limit";

interface PipelineMock {
  incr: ReturnType<typeof vi.fn>;
  pexpire: ReturnType<typeof vi.fn>;
  pttl: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
}

function makePipeline(execResults: unknown): PipelineMock {
  const pipeline: PipelineMock = {
    incr: vi.fn().mockReturnThis(),
    pexpire: vi.fn().mockReturnThis(),
    pttl: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(execResults),
  };
  return pipeline;
}

describe("createRateLimiter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  describe("in-memory fallback (no Redis)", () => {
    beforeEach(() => {
      mockGetRedis.mockReturnValue(null);
    });

    it("allows requests under the limit", async () => {
      const limiter = createRateLimiter({ windowMs: 60_000, max: 3 });
      expect((await limiter.check("k")).allowed).toBe(true);
      expect((await limiter.check("k")).allowed).toBe(true);
      expect((await limiter.check("k")).allowed).toBe(true);
    });

    it("rejects on the (max+1)-th request within the window", async () => {
      const limiter = createRateLimiter({ windowMs: 60_000, max: 2 });
      await limiter.check("k");
      await limiter.check("k");
      const result = await limiter.check("k");
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBeGreaterThan(0);
      expect(result.retryAfterMs).toBeLessThanOrEqual(60_000);
    });

    it("allows again after window rollover", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const limiter = createRateLimiter({ windowMs: 1000, max: 1 });
      expect((await limiter.check("k")).allowed).toBe(true);
      expect((await limiter.check("k")).allowed).toBe(false);

      vi.advanceTimersByTime(1001);
      expect((await limiter.check("k")).allowed).toBe(true);
    });

    it("isolates counters per key", async () => {
      const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
      expect((await limiter.check("alice")).allowed).toBe(true);
      expect((await limiter.check("alice")).allowed).toBe(false);
      // Different key — fresh budget
      expect((await limiter.check("bob")).allowed).toBe(true);
    });

    it("clear() resets the counter for a key (no Redis)", async () => {
      const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
      await limiter.check("k");
      expect((await limiter.check("k")).allowed).toBe(false);
      await limiter.clear("k");
      expect((await limiter.check("k")).allowed).toBe(true);
    });

    it("retryAfterMs reflects time-to-window-end", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const limiter = createRateLimiter({ windowMs: 5000, max: 1 });
      await limiter.check("k");
      vi.advanceTimersByTime(2000);
      const result = await limiter.check("k");
      expect(result.allowed).toBe(false);
      // Window started at t=0, ends at t=5000, we're at t=2000 → ~3000 ms
      expect(result.retryAfterMs).toBe(3000);
    });
  });

  describe("Redis path", () => {
    it("allows when Redis INCR returns count <= max", async () => {
      // results: [[err, count], [err, _], [err, ttl]]
      const pipeline = makePipeline([
        [null, 1],
        [null, "OK"],
        [null, 60_000],
      ]);
      mockGetRedis.mockReturnValue({
        pipeline: () => pipeline,
        del: vi.fn(),
      });
      const limiter = createRateLimiter({ windowMs: 60_000, max: 5 });
      const result = await limiter.check("k");
      expect(result.allowed).toBe(true);
      expect(pipeline.incr).toHaveBeenCalledWith("k");
      expect(pipeline.pexpire).toHaveBeenCalledWith("k", 60_000, "NX");
    });

    it("rejects when Redis INCR returns count > max, returns ttl as retryAfterMs", async () => {
      const pipeline = makePipeline([
        [null, 6],
        [null, 0],
        [null, 1234],
      ]);
      mockGetRedis.mockReturnValue({
        pipeline: () => pipeline,
        del: vi.fn(),
      });
      const limiter = createRateLimiter({ windowMs: 60_000, max: 5 });
      const result = await limiter.check("k");
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBe(1234);
    });

    it("falls back to windowMs when Redis returns negative TTL", async () => {
      const pipeline = makePipeline([
        [null, 99],
        [null, 0],
        [null, -2],
      ]);
      mockGetRedis.mockReturnValue({
        pipeline: () => pipeline,
        del: vi.fn(),
      });
      const limiter = createRateLimiter({ windowMs: 5000, max: 1 });
      const result = await limiter.check("k");
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBe(5000);
    });

    it("falls back to in-memory when Redis throws", async () => {
      const errorPipeline: PipelineMock = {
        incr: vi.fn().mockReturnThis(),
        pexpire: vi.fn().mockReturnThis(),
        pttl: vi.fn().mockReturnThis(),
        exec: vi.fn().mockRejectedValue(new Error("redis down")),
      };
      mockGetRedis.mockReturnValue({
        pipeline: () => errorPipeline,
        del: vi.fn(),
      });
      const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
      // First call: Redis throws → falls back to memory; allowed
      expect((await limiter.check("k")).allowed).toBe(true);
      // Second call: Redis still throws; in-memory now at limit
      expect((await limiter.check("k")).allowed).toBe(false);
    });

    it("falls back to in-memory when Redis pipeline returns null exec()", async () => {
      const pipeline: PipelineMock = {
        incr: vi.fn().mockReturnThis(),
        pexpire: vi.fn().mockReturnThis(),
        pttl: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(null),
      };
      mockGetRedis.mockReturnValue({
        pipeline: () => pipeline,
        del: vi.fn(),
      });
      const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
      expect((await limiter.check("k")).allowed).toBe(true);
    });

    it("clear() calls Redis DEL when Redis is available", async () => {
      const del = vi.fn().mockResolvedValue(1);
      mockGetRedis.mockReturnValue({
        pipeline: () => makePipeline([[null, 1], [null, "OK"], [null, 1000]]),
        del,
      });
      const limiter = createRateLimiter({ windowMs: 1000, max: 1 });
      await limiter.clear("user-42");
      expect(del).toHaveBeenCalledWith("user-42");
    });

    it("clear() falls back to memory delete when Redis DEL throws", async () => {
      const del = vi.fn().mockRejectedValue(new Error("redis down"));
      mockGetRedis.mockReturnValue({
        pipeline: () => makePipeline([[null, 1], [null, "OK"], [null, 1000]]),
        del,
      });
      const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
      // No assert on exception — clear must not throw to caller
      await expect(limiter.clear("k")).resolves.toBeUndefined();
    });
  });

  describe("boundary cases", () => {
    beforeEach(() => {
      mockGetRedis.mockReturnValue(null);
    });

    it("max=1 rejects immediately on second call", async () => {
      const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
      expect((await limiter.check("k")).allowed).toBe(true);
      expect((await limiter.check("k")).allowed).toBe(false);
    });

    it("supports keys with special characters", async () => {
      const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
      const result = await limiter.check("user:42|action=login");
      expect(result.allowed).toBe(true);
    });
  });
});
