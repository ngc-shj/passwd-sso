import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for the reprompt verification cache boundary logic.
 * The cache in useReprompt uses Date.now() with a 30-second TTL,
 * scoped per entry ID. These tests verify the exact boundary values.
 */

const CACHE_TTL_MS = 30_000;

/**
 * Replicates the isCacheValid check from useReprompt:
 *   const verifiedAt = cacheRef.current.get(entryId);
 *   return verifiedAt !== undefined && Date.now() - verifiedAt <= CACHE_TTL_MS;
 */
function isCacheValid(cache: Map<string, number>, entryId: string): boolean {
  const verifiedAt = cache.get(entryId);
  return verifiedAt !== undefined && Date.now() - verifiedAt <= CACHE_TTL_MS;
}

describe("useReprompt cache boundary", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("cache hit immediately after verification (0ms)", () => {
    const cache = new Map<string, number>();
    cache.set("entry-1", Date.now());
    expect(isCacheValid(cache, "entry-1")).toBe(true);
  });

  it("cache hit at 29,999ms", () => {
    const cache = new Map<string, number>();
    cache.set("entry-1", Date.now());
    vi.advanceTimersByTime(29_999);
    expect(isCacheValid(cache, "entry-1")).toBe(true);
  });

  it("cache hit at exactly 30,000ms (TTL boundary)", () => {
    const cache = new Map<string, number>();
    cache.set("entry-1", Date.now());
    vi.advanceTimersByTime(30_000);
    expect(isCacheValid(cache, "entry-1")).toBe(true);
  });

  it("cache miss at 30,001ms (expired)", () => {
    const cache = new Map<string, number>();
    cache.set("entry-1", Date.now());
    vi.advanceTimersByTime(30_001);
    expect(isCacheValid(cache, "entry-1")).toBe(false);
  });

  it("cache miss for different entry ID (entry-scoped)", () => {
    const cache = new Map<string, number>();
    cache.set("entry-1", Date.now());
    expect(isCacheValid(cache, "entry-1")).toBe(true);
    expect(isCacheValid(cache, "entry-2")).toBe(false);
  });

  it("cache miss for unverified entry", () => {
    const cache = new Map<string, number>();
    expect(isCacheValid(cache, "entry-1")).toBe(false);
  });

  it("re-verification refreshes cache TTL", () => {
    const cache = new Map<string, number>();
    cache.set("entry-1", Date.now());

    // Advance 20 seconds
    vi.advanceTimersByTime(20_000);
    expect(isCacheValid(cache, "entry-1")).toBe(true);

    // Re-verify (refresh cache)
    cache.set("entry-1", Date.now());

    // Advance another 25 seconds (45s total from first, 25s from refresh)
    vi.advanceTimersByTime(25_000);
    expect(isCacheValid(cache, "entry-1")).toBe(true);

    // Advance past refresh TTL
    vi.advanceTimersByTime(6_000);
    expect(isCacheValid(cache, "entry-1")).toBe(false);
  });

  it("multiple entries have independent caches", () => {
    const cache = new Map<string, number>();
    cache.set("entry-a", Date.now());

    vi.advanceTimersByTime(15_000);
    cache.set("entry-b", Date.now());

    vi.advanceTimersByTime(16_000);
    // entry-a: 31s elapsed → expired
    expect(isCacheValid(cache, "entry-a")).toBe(false);
    // entry-b: 16s elapsed → still valid
    expect(isCacheValid(cache, "entry-b")).toBe(true);
  });
});
