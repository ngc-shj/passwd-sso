import { getRedis, validateRedisConfig } from "@/lib/redis";
import { RATE_LIMIT_MAP_MAX_SIZE } from "@/lib/validations/common.server";

interface RateLimiterOptions {
  /** Time window in milliseconds */
  windowMs: number;
  /** Maximum requests allowed within the window */
  max: number;
}

interface RateLimitResult {
  allowed: boolean;
  /** Milliseconds until the rate limit resets (present when rate-limited) */
  retryAfterMs?: number;
}

interface RateLimiter {
  /** Returns { allowed, retryAfterMs? } */
  check(key: string): Promise<RateLimitResult>;
  /** Clear the counter for a key (e.g. on successful auth) */
  clear(key: string): Promise<void>;
}

let redisConfigValidated = false;

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { windowMs, max } = options;
  const store = new Map<string, { resetAt: number; count: number }>();

  async function checkRedis(key: string): Promise<RateLimitResult | null> {
    const redis = getRedis();
    if (!redis) return null;
    try {
      // Pipeline: INCR + conditional PEXPIRE + PTTL in one round-trip.
      // PEXPIRE only sets TTL on first increment (count === 1).
      // PTTL is always included so rate-limited responses don't need a second call.
      const pipeline = redis.pipeline();
      pipeline.incr(key);
      pipeline.pexpire(key, windowMs, "NX"); // NX: only set if no TTL exists
      pipeline.pttl(key);
      const results = await pipeline.exec();

      // ioredis pipeline results: [[err, value], ...]
      if (!results) return null;
      const count = results[0]?.[1] as number;
      const ttl = results[2]?.[1] as number;

      if (count <= max) {
        return { allowed: true };
      }
      return {
        allowed: false,
        retryAfterMs: ttl > 0 ? ttl : windowMs,
      };
    } catch {
      return null; // fallback to in-memory
    }
  }

  async function clearRedis(key: string): Promise<boolean> {
    const redis = getRedis();
    if (!redis) return false;
    try {
      await redis.del(key);
      return true;
    } catch {
      return false;
    }
  }

  function checkMemory(key: string): RateLimitResult {
    const now = Date.now();
    const entry = store.get(key);
    if (!entry || entry.resetAt < now) {
      if (store.size >= RATE_LIMIT_MAP_MAX_SIZE) {
        // Evict expired entries first
        for (const [k, v] of store) {
          if (v.resetAt < now) store.delete(k);
        }
        // If still too large, clear all
        if (store.size >= RATE_LIMIT_MAP_MAX_SIZE) store.clear();
      }
      store.set(key, { resetAt: now + windowMs, count: 1 });
      return { allowed: true };
    }
    if (entry.count >= max) {
      return {
        allowed: false,
        retryAfterMs: entry.resetAt - now,
      };
    }
    entry.count += 1;
    return { allowed: true };
  }

  return {
    async check(key: string): Promise<RateLimitResult> {
      // Validate Redis config on first request (not at module load / build time)
      if (!redisConfigValidated) {
        validateRedisConfig();
        redisConfigValidated = true;
      }
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
