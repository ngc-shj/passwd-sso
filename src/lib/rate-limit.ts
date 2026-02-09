import { getRedis } from "@/lib/redis";

interface RateLimiterOptions {
  /** Time window in milliseconds */
  windowMs: number;
  /** Maximum requests allowed within the window */
  max: number;
  /** Use Redis (with in-memory fallback) instead of in-memory only */
  useRedis?: boolean;
}

interface RateLimiter {
  /** Returns true if allowed, false if rate-limited */
  check(key: string): Promise<boolean>;
  /** Clear the counter for a key (e.g. on successful auth) */
  clear(key: string): Promise<void>;
}

const MAX_MAP_SIZE = 10_000;

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { windowMs, max, useRedis = false } = options;
  const store = new Map<string, { resetAt: number; count: number }>();

  async function checkRedis(key: string): Promise<boolean | null> {
    if (!useRedis) return null;
    const redis = getRedis();
    if (!redis) return null;
    try {
      const windowSec = Math.ceil(windowMs / 1000);
      const count = await redis.incr(key);
      if (count === 1) {
        await redis.expire(key, windowSec);
      }
      return count <= max;
    } catch {
      return null; // fallback to in-memory
    }
  }

  async function clearRedis(key: string): Promise<boolean> {
    if (!useRedis) return false;
    const redis = getRedis();
    if (!redis) return false;
    try {
      await redis.del(key);
      return true;
    } catch {
      return false;
    }
  }

  function checkMemory(key: string): boolean {
    const now = Date.now();
    const entry = store.get(key);
    if (!entry || entry.resetAt < now) {
      if (store.size >= MAX_MAP_SIZE) {
        // Evict expired entries first
        for (const [k, v] of store) {
          if (v.resetAt < now) store.delete(k);
        }
        // If still too large, clear all
        if (store.size >= MAX_MAP_SIZE) store.clear();
      }
      store.set(key, { resetAt: now + windowMs, count: 1 });
      return true;
    }
    if (entry.count >= max) return false;
    entry.count += 1;
    return true;
  }

  return {
    async check(key: string): Promise<boolean> {
      const redisResult = await checkRedis(key);
      if (redisResult !== null) return redisResult;
      return checkMemory(key);
    },
    async clear(key: string): Promise<void> {
      const cleared = await clearRedis(key);
      if (!cleared) {
        store.delete(key);
      }
    },
  };
}
