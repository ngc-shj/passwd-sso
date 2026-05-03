/**
 * Tests for the shared rate limiter instances exported from rate-limiters.ts.
 *
 * The module exposes pre-configured limiter singletons (no factory params).
 * The behavioral surface is tested via behavioral check + a smoke test that
 * the singleton has the expected window/max budget.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetRedis = vi.hoisted(() => vi.fn());
vi.mock("@/lib/redis", () => ({
  getRedis: mockGetRedis,
}));

import { v1ApiKeyLimiter } from "./rate-limiters";
import { MS_PER_MINUTE } from "@/lib/constants/time";

describe("rate-limiters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mockGetRedis.mockReturnValue(null); // force in-memory path
  });

  describe("v1ApiKeyLimiter", () => {
    it("exposes check + clear surface", () => {
      expect(typeof v1ApiKeyLimiter.check).toBe("function");
      expect(typeof v1ApiKeyLimiter.clear).toBe("function");
    });

    it("allows the first 100 requests then rejects", async () => {
      // Use a unique key to avoid collisions with other tests in the suite
      const key = `test:rate-limiters:100-budget:${Date.now()}-${Math.random()}`;
      // Within budget
      for (let i = 0; i < 100; i++) {
        const result = await v1ApiKeyLimiter.check(key);
        expect(result.allowed).toBe(true);
      }
      // 101st must be rejected
      const blocked = await v1ApiKeyLimiter.check(key);
      expect(blocked.allowed).toBe(false);
      expect(blocked.retryAfterMs).toBeGreaterThan(0);
    });

    it("retryAfterMs reflects the per-minute window when over budget", async () => {
      const key = `test:rate-limiters:retry-after:${Date.now()}-${Math.random()}`;
      for (let i = 0; i < 100; i++) {
        await v1ApiKeyLimiter.check(key);
      }
      const blocked = await v1ApiKeyLimiter.check(key);
      expect(blocked.retryAfterMs).toBeLessThanOrEqual(MS_PER_MINUTE);
    });

    it("clear() resets the counter", async () => {
      const key = `test:rate-limiters:clear:${Date.now()}-${Math.random()}`;
      for (let i = 0; i < 100; i++) {
        await v1ApiKeyLimiter.check(key);
      }
      expect((await v1ApiKeyLimiter.check(key)).allowed).toBe(false);
      await v1ApiKeyLimiter.clear(key);
      expect((await v1ApiKeyLimiter.check(key)).allowed).toBe(true);
    });

    it("isolates counters per key (independent budgets)", async () => {
      const a = `test:rate-limiters:isolate:A:${Date.now()}-${Math.random()}`;
      const b = `test:rate-limiters:isolate:B:${Date.now()}-${Math.random()}`;
      // Burn A to its limit
      for (let i = 0; i < 100; i++) {
        await v1ApiKeyLimiter.check(a);
      }
      expect((await v1ApiKeyLimiter.check(a)).allowed).toBe(false);
      // B has its own budget
      expect((await v1ApiKeyLimiter.check(b)).allowed).toBe(true);
    });
  });
});
