import { getRedis } from "@/lib/redis";
import { createThrottledErrorLogger } from "@/lib/logger/throttled";

/**
 * RFC 9449 §11.1 — server-side `jti` uniqueness cache.
 *
 * Window:  TTL 60s = 2 × the iat skew window (30s).
 *          A jti seen within TTL is a replay → reject.
 * Scope:   per `jkt` (DPoP public-key thumbprint) so that one device's
 *          jti space can never collide with another.
 * Storage: Redis with `SET key 1 PX 60000 NX`. NX ensures atomic
 *          first-sight detection; in-memory fallback mirrors the same
 *          semantics for dev / single-process deployments.
 */
export interface JtiCache {
  /**
   * Returns true if `(jkt, jti)` was already seen within the TTL window
   * (i.e. the proof is a replay and must be rejected). Returns false
   * on first sight, having atomically persisted the entry.
   */
  hasOrRecord(jkt: string, jti: string): Promise<boolean>;
}

// Default 60s — RFC 9449 §11.1 guidance (2 × 30s skew window).
const DEFAULT_TTL_MS = 60_000;

const logRedisError = createThrottledErrorLogger(
  30_000,
  "dpop-jti-cache.redis.fallback",
);

interface InMemoryEntry {
  expiresAt: number;
}

interface InMemoryStore {
  map: Map<string, InMemoryEntry>;
  /** Soft cap to bound memory in the Redis-less fallback path. */
  maxSize: number;
}

const IN_MEMORY_MAX = 10_000;

function makeKey(jkt: string, jti: string): string {
  // Redis key shape kept flat & explicit so ops can scan/expire.
  return `dpop:jti:${jkt}:${jti}`;
}

function checkMemory(store: InMemoryStore, key: string, ttlMs: number, now: number): boolean {
  const entry = store.map.get(key);
  if (entry && entry.expiresAt > now) return true;
  // First sight (or expired). Re-persist with fresh TTL.
  if (store.map.size >= store.maxSize) {
    // Evict expired first, then bulk-clear if still saturated.
    for (const [k, v] of store.map) {
      if (v.expiresAt <= now) store.map.delete(k);
    }
    if (store.map.size >= store.maxSize) store.map.clear();
  }
  store.map.set(key, { expiresAt: now + ttlMs });
  return false;
}

/**
 * Build a JtiCache. Exposed for tests; production uses `getJtiCache()`.
 */
export function createJtiCache(options: { ttlMs?: number; now?: () => number } = {}): JtiCache {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  const memory: InMemoryStore = { map: new Map(), maxSize: IN_MEMORY_MAX };

  return {
    async hasOrRecord(jkt: string, jti: string): Promise<boolean> {
      const key = makeKey(jkt, jti);
      const redis = getRedis();
      if (redis) {
        try {
          // SET key 1 PX <ttl> NX → "OK" on first sight, null on replay.
          const result = await redis.set(key, "1", "PX", ttlMs, "NX");
          return result === null;
        } catch {
          logRedisError();
          // Fall through to in-memory fallback.
        }
      }
      return checkMemory(memory, key, ttlMs, now());
    },
  };
}

let singleton: JtiCache | undefined;

export function getJtiCache(): JtiCache {
  if (!singleton) singleton = createJtiCache();
  return singleton;
}

/** Test-only: reset the module-level singleton between tests. */
export function _resetJtiCacheForTests(): void {
  singleton = undefined;
}
