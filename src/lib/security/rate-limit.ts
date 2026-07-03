import { getRedis } from "@/lib/redis";
import { RATE_LIMIT_MAP_MAX_SIZE } from "@/lib/validations/common.server";
import {
  REDIS_FALLBACK_LOG_THROTTLE_MS,
  createThrottledErrorLogger,
} from "@/lib/logger/throttled";

const logRedisError = createThrottledErrorLogger(
  REDIS_FALLBACK_LOG_THROTTLE_MS,
  "rate-limit.redis.fallback",
);

export interface RateLimiterOptions {
  /** Time window in milliseconds */
  windowMs: number;
  /** Maximum requests allowed within the window */
  max: number;
  /**
   * When true, Redis errors (null from getRedis() or pipeline exec failure)
   * cause check() to return { allowed: false, redisErrored: true } instead
   * of falling back to the in-memory Map. Caller MUST translate this to a
   * 503 response (route-specific envelope). Default: false (preserves the
   * current fail-open in-memory fallback for non-opt-in call sites).
   */
  failClosedOnRedisError?: boolean;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Milliseconds until the rate limit resets (present when rate-limited) */
  retryAfterMs?: number;
  /**
   * True ONLY when failClosedOnRedisError=true triggered fail-closed.
   * Always absent (not even false) when option is false.
   * Caller branches:
   *   redisErrored===true       → 503 (route-specific envelope)
   *   !allowed && !redisErrored → 429
   */
  redisErrored?: true;
}

export interface RateLimiter {
  /** Returns { allowed, retryAfterMs?, redisErrored? } */
  check(key: string): Promise<RateLimitResult>;
  /** Clear the counter for a key (e.g. on successful auth) */
  clear(key: string): Promise<void>;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { windowMs, max, failClosedOnRedisError = false } = options;
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

      // ioredis pipeline results: [[err, value], ...]. A whole-pipeline failure
      // throws or yields null (handled above); a PER-COMMAND failure does NOT
      // throw — the offending entry is [err, null]. Treat any per-command error
      // (or a non-numeric INCR/PTTL value) as a Redis failure and signal null so
      // the caller honors failClosedOnRedisError. Without this, a failed INCR
      // leaves count = null, and `null <= max` coerces to true → fail-OPEN even
      // for a fail-closed limiter.
      if (!results) return null;
      const commandError = results.find(([err]) => err != null)?.[0];
      if (commandError) {
        logRedisError((commandError as { code?: string } | undefined)?.code);
        return null;
      }

      const count = results[0]?.[1];
      const ttl = results[2]?.[1];
      if (typeof count !== "number" || typeof ttl !== "number") {
        // Unexpected pipeline shape — surface it like any other Redis failure
        // for operational visibility (symmetry with the per-command error log).
        logRedisError("unexpected_pipeline_shape");
        return null;
      }

      if (count <= max) {
        return { allowed: true };
      }
      return {
        allowed: false,
        retryAfterMs: ttl > 0 ? ttl : windowMs,
      };
    } catch (err) {
      logRedisError((err as { code?: string } | undefined)?.code);
      return null; // signal upstream — caller decides fail-open vs fail-closed
    }
  }

  async function clearRedis(key: string): Promise<boolean> {
    const redis = getRedis();
    if (!redis) return false;
    try {
      await redis.del(key);
      return true;
    } catch (err) {
      logRedisError((err as { code?: string } | undefined)?.code);
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
        // If still too large, drop the OLDEST entries (Maps preserve insertion
        // order) until back under cap. NEVER clear all: a flood of distinct
        // keys during a Redis outage would otherwise reset every live counter,
        // handing attackers a rate-limit reset. Mirrors the bounded-LRU
        // eviction in rate-limit-audit.ts (pruneAndAdd).
        while (store.size >= RATE_LIMIT_MAP_MAX_SIZE) {
          const oldest = store.keys().next();
          if (oldest.done) break;
          store.delete(oldest.value);
        }
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
      const redisResult = await checkRedis(key);
      if (redisResult !== null) return redisResult;
      // Redis returned null (no client / pipeline failure).
      if (failClosedOnRedisError) {
        return { allowed: false, redisErrored: true };
      }
      return checkMemory(key);
    },
    async clear(key: string): Promise<void> {
      const cleared = await clearRedis(key);
      if (!cleared) {
        // Best-effort in-memory cleanup even in fail-closed mode (orphan-avoidance).
        store.delete(key);
      }
    },
  };
}
