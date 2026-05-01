import { randomBytes } from "node:crypto";
import { getRedis } from "@/lib/redis";
import { createThrottledErrorLogger } from "@/lib/logger/throttled";

/**
 * RFC 9449 §8 — DPoP-Nonce.
 *
 * The server publishes a "current" nonce on the response (`DPoP-Nonce`
 * header) of `/api/mobile/token` and `/api/mobile/token/refresh`. The
 * nonce rotates every 5 minutes.
 *
 * Acceptance is currently NOT enforced — `verifyDpopProof` callers pass
 * `expectedNonce: null`. The header still rotates so the iOS client can
 * cache and echo it on a future tightening, and so the wire shape is in
 * place when we are ready to require nonce echo.
 */

const ROTATION_MS = 5 * 60 * 1000;
const NONCE_BYTES = 24; // 192 bits → 32 chars base64url
const KEY_CUR = "dpop:nonce:cur";
// Redis TTL is 2 × rotation so a small clock-skew window between rotations
// does not leave the server with a missing key.
const REDIS_TTL_SEC = Math.ceil((ROTATION_MS * 2) / 1000);

const logRedisError = createThrottledErrorLogger(
  30_000,
  "dpop-nonce.redis.fallback",
);

export interface DpopNonceService {
  /** The nonce the server is currently advertising. */
  current(): Promise<string>;
  /** Rotate if the current generation has aged past ROTATION_MS. Cheap to call on hot path. */
  rotateIfDue(): Promise<void>;
}

interface MemoryState {
  cur: string;
  rotatedAt: number;
}

function generateNonce(): string {
  return randomBytes(NONCE_BYTES).toString("base64url");
}

interface NonceServiceOptions {
  rotationMs?: number;
  now?: () => number;
}

export function createDpopNonceService(
  options: NonceServiceOptions = {},
): DpopNonceService {
  const rotationMs = options.rotationMs ?? ROTATION_MS;
  const now = options.now ?? Date.now;
  const memory: MemoryState = {
    cur: generateNonce(),
    rotatedAt: now(),
  };

  async function ensureRedisCurrent(): Promise<string | null> {
    const redis = getRedis();
    if (!redis) return null;
    try {
      const cur = await redis.get(KEY_CUR);
      if (cur) return cur;
      // First-time init: SET NX so concurrent workers don't race past each other.
      const nonce = generateNonce();
      const set = await redis.set(KEY_CUR, nonce, "EX", REDIS_TTL_SEC, "NX");
      if (set === "OK") return nonce;
      // Lost the race — re-read.
      return (await redis.get(KEY_CUR)) ?? nonce;
    } catch {
      logRedisError();
      return null;
    }
  }

  async function rotateRedis(): Promise<void> {
    const redis = getRedis();
    if (!redis) return;
    try {
      await redis.set(KEY_CUR, generateNonce(), "EX", REDIS_TTL_SEC);
    } catch {
      logRedisError();
    }
  }

  function rotateMemory(): void {
    memory.cur = generateNonce();
    memory.rotatedAt = now();
  }

  return {
    async current(): Promise<string> {
      const fromRedis = await ensureRedisCurrent();
      if (fromRedis) return fromRedis;
      return memory.cur;
    },

    async rotateIfDue(): Promise<void> {
      const redis = getRedis();
      if (redis) {
        // For Redis we don't need a local clock — the EX TTL on KEY_CUR
        // is the source of truth. Rotate if the key is missing or has
        // less than (REDIS_TTL_SEC × 1000 − rotationMs) ms left.
        try {
          const ttl = await redis.pttl(KEY_CUR);
          if (
            ttl === -2 ||
            ttl === -1 ||
            (ttl > 0 && ttl < REDIS_TTL_SEC * 1000 - rotationMs)
          ) {
            await rotateRedis();
          }
          return;
        } catch {
          logRedisError();
          // Fall through to in-memory rotation.
        }
      }
      if (now() - memory.rotatedAt >= rotationMs) {
        rotateMemory();
      }
    },
  };
}

let singleton: DpopNonceService | undefined;

export function getDpopNonceService(): DpopNonceService {
  if (!singleton) singleton = createDpopNonceService();
  return singleton;
}

/** Test-only: reset the module-level singleton between tests. */
export function _resetDpopNonceServiceForTests(): void {
  singleton = undefined;
}
