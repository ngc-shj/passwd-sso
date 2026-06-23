/**
 * Shared favicon proxy helpers: host normalization, provider URL builder,
 * Redis-backed cache with in-memory fallback, and single-flight deduplication.
 *
 * Only server-side code may import this module. It exposes the upstream
 * provider URL in one place (SC3 — swapping providers touches only this file).
 */

import { isIP as netIsIP } from "node:net";
import { getRedis } from "@/lib/redis";
import { MS_PER_DAY, SEC_PER_DAY } from "@/lib/constants/time";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Maximum individual favicon body size cached (256 KB). */
export const FAVICON_MAX_BODY_BYTES = 256 * 1024;

/** Redis TTL for cached favicons (~7 days in seconds). */
const REDIS_TTL_SEC = 7 * SEC_PER_DAY;

/** In-memory cache TTL (~7 days). */
const MEMORY_TTL_MS = 7 * MS_PER_DAY;

/** Maximum number of entries in the in-memory cache. */
const MEMORY_CACHE_MAX = 2_000;

/** Redis key prefix. */
const REDIS_KEY_PREFIX = "favicon";

// ─── Host normalization ──────────────────────────────────────────────────────

/**
 * Normalize a raw favicon host string:
 *  1. Lowercase
 *  2. Strip a leading "www."
 *  3. Require the result matches ^[a-z0-9.-]+$ (strict allowlist)
 *  4. Reject empty and >253 chars
 *  5. Reject IP literals (net.isIP !== 0)
 *
 * Returns null on any violation — callers MUST reject the request on null.
 *
 * The same normalized value feeds both the cache key and the upstream URL,
 * so the SSRF guard and the cache always agree.
 */
export function normalizeFaviconHost(raw: string): string | null {
  if (!raw) return null;

  let host = raw.toLowerCase();

  // Strip leading "www." if present
  if (host.startsWith("www.")) {
    host = host.slice(4);
  }

  if (!host) return null;

  // Strict allowlist: only lowercase letters, digits, dots, hyphens
  if (!/^[a-z0-9.-]+$/.test(host)) return null;

  // DNS max length
  if (host.length > 253) return null;

  // Reject IP literals (both IPv4 and IPv6)
  if (netIsIP(host) !== 0) return null;

  return host;
}

// ─── Provider URL builder ────────────────────────────────────────────────────

/**
 * Build the upstream provider URL for a given normalized host and size.
 * Uses the non-redirecting Google faviconV2 endpoint (t1.gstatic.com)
 * so validateAndFetch (redirect:"error") works without modification.
 *
 * SC3: all provider URL logic is isolated here; swap providers by editing
 * this single function.
 */
export function buildFaviconProviderUrl(normalizedHost: string, size: 32 | 64): string {
  return (
    `https://t1.gstatic.com/faviconV2` +
    `?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL` +
    `&size=${size}` +
    `&url=https://${normalizedHost}`
  );
}

// ─── Cache layer ─────────────────────────────────────────────────────────────

type CacheEntry = {
  body: Buffer;
  contentType: string;
  expiresAt: number;
};

const memoryCache = new Map<string, CacheEntry>();

/** In-flight single-flight deduplication map: key → pending fetch promise. */
const inFlight = new Map<string, Promise<CacheEntry | null>>();

/** Build the cache key for a normalized host + size. */
function cacheKey(normalizedHost: string, size: 32 | 64): string {
  return `${REDIS_KEY_PREFIX}:${normalizedHost}:${size}`;
}

/** Evict stale memory-cache entries; clear all when at capacity. */
function evictMemoryCache(): void {
  const now = Date.now();
  for (const [k, v] of memoryCache) {
    if (v.expiresAt < now) memoryCache.delete(k);
  }
  if (memoryCache.size >= MEMORY_CACHE_MAX) {
    memoryCache.clear();
  }
}

/** Read from Redis cache. Returns null on miss or error. */
async function readRedisCache(key: string): Promise<CacheEntry | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    // Stored as two hash fields: "ct" (content-type), "b64" (base64 body)
    const result = await redis.hmget(key, "ct", "b64");
    const ct = result[0];
    const b64 = result[1];
    if (!ct || !b64) return null;
    const body = Buffer.from(b64, "base64");
    return { body, contentType: ct, expiresAt: Date.now() + MEMORY_TTL_MS };
  } catch {
    return null;
  }
}

/** Write to Redis cache. Best-effort; errors are silently dropped. */
async function writeRedisCache(key: string, entry: CacheEntry): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    const b64 = Buffer.from(entry.body).toString("base64");
    await redis.hset(key, "ct", entry.contentType, "b64", b64);
    await redis.expire(key, REDIS_TTL_SEC);
  } catch {
    // Best-effort
  }
}

/** Get a cached favicon. Returns null on miss. Checks memory first, then Redis. */
export async function getCachedFavicon(
  normalizedHost: string,
  size: 32 | 64,
): Promise<CacheEntry | null> {
  const key = cacheKey(normalizedHost, size);
  const now = Date.now();

  // Memory cache hit
  const mem = memoryCache.get(key);
  if (mem && mem.expiresAt > now) return mem;

  // Redis cache hit
  const redis = await readRedisCache(key);
  if (redis) {
    const entry = { ...redis, expiresAt: now + MEMORY_TTL_MS };
    // Backfill memory cache
    evictMemoryCache();
    memoryCache.set(key, entry);
    return entry;
  }

  return null;
}

/** Store a favicon in cache (memory + Redis). */
export async function setCachedFavicon(
  normalizedHost: string,
  size: 32 | 64,
  body: Buffer,
  contentType: string,
): Promise<void> {
  const key = cacheKey(normalizedHost, size);
  const entry: CacheEntry = {
    body,
    contentType,
    expiresAt: Date.now() + MEMORY_TTL_MS,
  };

  evictMemoryCache();
  memoryCache.set(key, entry);
  await writeRedisCache(key, entry);
}

/**
 * Fetch a favicon with single-flight deduplication.
 * If another request is already in-flight for the same key, waits for that
 * result rather than firing a duplicate upstream fetch.
 *
 * `fetcher` is called at most once per concurrent group; its result is
 * shared with all waiters. Returns null when fetcher returns null.
 */
export async function withSingleFlight(
  normalizedHost: string,
  size: 32 | 64,
  fetcher: () => Promise<CacheEntry | null>,
): Promise<CacheEntry | null> {
  const key = cacheKey(normalizedHost, size);

  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = fetcher().finally(() => {
    inFlight.delete(key);
  });

  inFlight.set(key, promise);
  return promise;
}

/**
 * Test hook: reset all module-level state (memory cache + in-flight map).
 * Only call this from tests.
 */
export function __clearFaviconCache(): void {
  memoryCache.clear();
  inFlight.clear();
}
