/**
 * Tests for the shared rate limiter instances exported from rate-limiters.ts.
 *
 * The module exposes pre-configured limiter singletons (no factory params).
 * v1ApiKeyLimiter is configured `failClosedOnRedisError: true` (M1): when Redis
 * is unreachable it must signal `redisErrored` (→ 503 at the route) instead of
 * falling back to the per-process in-memory Map (the cross-pod bypass this
 * remediates). The budget / clear / per-key mechanics of the Redis path are
 * covered at the factory level in rate-limit.test.ts; here we assert the
 * singleton's configured contract (fail-closed + Redis delegation).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetRedis = vi.hoisted(() => vi.fn());
vi.mock("@/lib/redis", () => ({
  getRedis: mockGetRedis,
}));

import { v1ApiKeyLimiter } from "./rate-limiters";

type PipelineResult = [Error | null, number][];
function makePipeline(results: PipelineResult) {
  const pipeline = {
    incr: vi.fn().mockReturnThis(),
    pexpire: vi.fn().mockReturnThis(),
    pttl: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(results),
  };
  return pipeline;
}

describe("rate-limiters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("v1ApiKeyLimiter", () => {
    it("exposes check + clear surface", () => {
      expect(typeof v1ApiKeyLimiter.check).toBe("function");
      expect(typeof v1ApiKeyLimiter.clear).toBe("function");
    });

    it("fails closed (redisErrored) when Redis is unreachable — no in-memory fallback (M1)", async () => {
      mockGetRedis.mockReturnValue(null);
      const result = await v1ApiKeyLimiter.check("test:v1:fail-closed");
      expect(result.allowed).toBe(false);
      expect(result.redisErrored).toBe(true);
    });

    it("allows via the Redis path when INCR count <= max", async () => {
      const pipeline = makePipeline([
        [null, 1], // incr
        [null, 1], // pexpire
        [null, 60_000], // pttl
      ]);
      mockGetRedis.mockReturnValue({ pipeline: () => pipeline });

      const result = await v1ApiKeyLimiter.check("test:v1:redis-allow");
      expect(result.allowed).toBe(true);
      expect(result.redisErrored).toBeUndefined();
      expect(pipeline.incr).toHaveBeenCalledWith("test:v1:redis-allow");
    });

    it("rejects (429-signal) via the Redis path when INCR count > max", async () => {
      const pipeline = makePipeline([
        [null, 101], // incr — over the 100 budget
        [null, 0],
        [null, 5_000], // pttl
      ]);
      mockGetRedis.mockReturnValue({ pipeline: () => pipeline });

      const result = await v1ApiKeyLimiter.check("test:v1:redis-reject");
      expect(result.allowed).toBe(false);
      expect(result.redisErrored).toBeUndefined();
      expect(result.retryAfterMs).toBe(5_000);
    });
  });
});
