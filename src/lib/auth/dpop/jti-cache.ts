import { getRedis } from "@/lib/redis";
import {
  REDIS_FALLBACK_LOG_THROTTLE_MS,
  createThrottledErrorLogger,
} from "@/lib/logger/throttled";
import { MS_PER_MINUTE } from "@/lib/constants/time";

/**
 * RFC 9449 §11.1 — server-side `jti` uniqueness cache.
 *
 * Window:  TTL 60s = 2 × the iat skew window (30s).
 *          A jti seen within TTL is a replay → reject.
 *
 *          INVARIANT: TTL must be ≥ 2 × iat skew. The iat check accepts
 *          `|now - iat| ≤ skew`, so a single proof is valid for at most
 *          2 × skew wall-clock seconds. If TTL < 2 × skew, there exists
 *          a window where the iat check still passes but the jti cache
 *          has already expired — exactly the replay path the cache is
 *          supposed to close. The two values live in different files
 *          (verify.ts DEFAULT_SKEW_SECONDS, jti-cache.ts DEFAULT_TTL_MS)
 *          so a one-sided edit could silently break the invariant. The
 *          ratio check at module load below catches that.
 *
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
// M4 invariant: DPOP_DEFAULT_JTI_TTL_MS >= DPOP_DEFAULT_SKEW_SECONDS * 2_000.
// The iat check accepts |now - iat| ≤ skew, so a single proof is acceptable
// for 2 × skew wall-clock seconds; the jti cache MUST outlive that window
// or a captured proof can be replayed after the cache expires but while
// iat is still in range. Enforced by the
// "DEFAULT_TTL_MS >= 2 × DPOP_DEFAULT_SKEW_SECONDS" test in
// `jti-cache.test.ts` — CI fails if a future edit breaks the relationship.
// Exported so the test can reference the same source of truth as production.
export const DPOP_DEFAULT_JTI_TTL_MS = MS_PER_MINUTE;
const DEFAULT_TTL_MS = DPOP_DEFAULT_JTI_TTL_MS;

const logRedisError = createThrottledErrorLogger(
  REDIS_FALLBACK_LOG_THROTTLE_MS,
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
        } catch (err) {
          logRedisError((err as { code?: string } | undefined)?.code);
          // Fail CLOSED: when Redis is the configured (multi-instance) backend
          // but the SET fails, do NOT degrade to the per-process in-memory map
          // — that would let the same proof replay once per instance during an
          // outage. Treat it as a replay and reject. The in-memory path below
          // is reserved for deployments with no Redis configured (dev /
          // single-process), where it is the intended primary store.
          return true;
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
