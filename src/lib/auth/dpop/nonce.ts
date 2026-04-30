import { randomBytes, timingSafeEqual } from "node:crypto";
import { getRedis } from "@/lib/redis";
import { createThrottledErrorLogger } from "@/lib/logger/throttled";

/**
 * RFC 9449 §8 — DPoP-Nonce.
 *
 * We do not issue per-request nonces (that would require synchronous
 * Redis on every protected call). Instead the server publishes a
 * "current" nonce that rotates every 5 minutes; both the current and
 * the immediately-prior generation are accepted, so a client may use
 * a slightly stale nonce briefly during rotation without being kicked.
 *
 * Issuance:
 *   /api/mobile/token and /api/mobile/token/refresh respond with
 *   `DPoP-Nonce: <current()>`. Clients echo on the next call.
 *
 * Acceptance:
 *   `isAccepted(value)` returns true iff `value` matches `cur` or
 *   `prev`. Constant-time string compare to avoid leaking how close
 *   the candidate is to a valid nonce.
 *
 * Threat model:
 *   Mitigates pre-generated DPoP proofs lifted from a brief device
 *   compromise — a proof signed before nonce rotation will be
 *   rejected after at most 2 × ROTATION_MS.
 */

const ROTATION_MS = 5 * 60 * 1000; // 5 minutes
const NONCE_BYTES = 24; // 192 bits → 32 chars base64url
const KEY_CUR = "dpop:nonce:cur";
const KEY_PREV = "dpop:nonce:prev";
// Redis TTL = 2 × rotation so prev never disappears mid-window.
const REDIS_TTL_SEC = Math.ceil((ROTATION_MS * 2) / 1000);

const logRedisError = createThrottledErrorLogger(
  30_000,
  "dpop-nonce.redis.fallback",
);

export interface DpopNonceService {
  /** The nonce the server is currently advertising. */
  current(): Promise<string>;
  /** True if `value` matches the current or immediately-prior nonce. */
  isAccepted(value: string): Promise<boolean>;
  /** Rotate if the current generation has aged past ROTATION_MS. Cheap to call on hot path. */
  rotateIfDue(): Promise<void>;
}

interface MemoryState {
  cur: string;
  prev: string | null;
  rotatedAt: number;
}

function generateNonce(): string {
  return randomBytes(NONCE_BYTES).toString("base64url");
}

function safeStringEqual(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) return false;
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

interface NonceServiceOptions {
  rotationMs?: number;
  now?: () => number;
}

export function createDpopNonceService(options: NonceServiceOptions = {}): DpopNonceService {
  const rotationMs = options.rotationMs ?? ROTATION_MS;
  const now = options.now ?? Date.now;
  const memory: MemoryState = {
    cur: generateNonce(),
    prev: null,
    rotatedAt: now(),
  };

  async function getRedisState(): Promise<{ cur: string | null; prev: string | null } | null> {
    const redis = getRedis();
    if (!redis) return null;
    try {
      const [cur, prev] = await redis.mget(KEY_CUR, KEY_PREV);
      return { cur: cur ?? null, prev: prev ?? null };
    } catch {
      logRedisError();
      return null;
    }
  }

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

  async function rotateRedis(): Promise<string | null> {
    const redis = getRedis();
    if (!redis) return null;
    try {
      const cur = await redis.get(KEY_CUR);
      const next = generateNonce();
      const pipeline = redis.pipeline();
      if (cur) pipeline.set(KEY_PREV, cur, "EX", REDIS_TTL_SEC);
      pipeline.set(KEY_CUR, next, "EX", REDIS_TTL_SEC);
      await pipeline.exec();
      return next;
    } catch {
      logRedisError();
      return null;
    }
  }

  function rotateMemory(): void {
    memory.prev = memory.cur;
    memory.cur = generateNonce();
    memory.rotatedAt = now();
  }

  return {
    async current(): Promise<string> {
      const fromRedis = await ensureRedisCurrent();
      if (fromRedis) return fromRedis;
      return memory.cur;
    },

    async isAccepted(value: string): Promise<boolean> {
      if (typeof value !== "string" || value.length === 0) return false;
      const state = await getRedisState();
      if (state) {
        if (state.cur && safeStringEqual(state.cur, value)) return true;
        if (state.prev && safeStringEqual(state.prev, value)) return true;
        return false;
      }
      // In-memory fallback.
      if (safeStringEqual(memory.cur, value)) return true;
      if (memory.prev && safeStringEqual(memory.prev, value)) return true;
      return false;
    },

    async rotateIfDue(): Promise<void> {
      const redis = getRedis();
      if (redis) {
        // For Redis we don't need a local clock — the EX TTL on KEY_CUR
        // is the source of truth. If KEY_CUR has expired or is about to,
        // rotate; otherwise no-op. We approximate by reading TTL.
        try {
          const ttl = await redis.pttl(KEY_CUR);
          // ttl in ms: -2 = no key, -1 = no expiry. Rotate if < rotationMs remaining.
          if (ttl === -2 || (ttl > 0 && ttl < REDIS_TTL_SEC * 1000 - rotationMs)) {
            await rotateRedis();
          } else if (ttl === -1) {
            // Key without expiry shouldn't happen — fix it.
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
