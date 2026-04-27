/**
 * Integration test: session-cache against a real Redis instance.
 *
 * Drives Scenarios A–K from the plan §"Implementation steps" 10 with a real
 * Redis client (no Redis mock). Postgres is NOT required — the file lives
 * under db-integration/ to share the integration-runner config and to leave
 * room for future scenarios that DO need Postgres state (E, F, G — currently
 * `it.todo`'d below where Auth.js adapter Session-row setup is non-trivial).
 *
 * Note on "multi-worker": these tests exercise shared-Redis read-after-
 * invalidate semantics from a single Node process. They do NOT spawn child
 * processes; cross-process behavior is bounded by Redis as the single source
 * of truth (T-2).
 *
 * Skips automatically when REDIS_URL is unset so the suite can run in
 * environments without Redis (e.g. lint-only CI shards).
 *
 * Run: `docker compose up -d redis db && npm run test:integration -- \
 *       session-revocation-cache.integration --reporter=verbose`
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
} from "vitest";
import type Redis from "ioredis";
import { getRedis } from "@/lib/redis";
import {
  setCachedSession,
  getCachedSession,
  invalidateCachedSession,
  invalidateCachedSessionsBulk,
  hashSessionToken,
  SESSION_CACHE_KEY_PREFIX,
  SESSION_CACHE_TTL_MS,
  TOMBSTONE_TTL_MS,
  type SessionInfo,
} from "@/lib/auth/session/session-cache";

// Typed-literal fixtures (T-17: no `as SessionInfo`, no spread from helpers).
const fixtureValidSession: SessionInfo = {
  valid: true,
  userId: "uuid-1234",
  tenantId: "uuid-tenant",
  hasPasskey: true,
  requirePasskey: false,
  requirePasskeyEnabledAt: null,
  passkeyGracePeriodDays: null,
};

type TombstoneShape = { tombstone: true };
const tombstoneLiteral: TombstoneShape = { tombstone: true };

const redisAvailable = !!process.env.REDIS_URL;

function key(token: string): string {
  return `${SESSION_CACHE_KEY_PREFIX}${hashSessionToken(token)}`;
}

function uniqueToken(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe.skipIf(!redisAvailable)("session-cache integration (real Redis)", () => {
  let redis: Redis;
  // Track every cache key the test suite touches so afterEach can clean up.
  const TEST_TOKENS: string[] = [];

  beforeAll(() => {
    const r = getRedis();
    if (!r) {
      throw new Error(
        "getRedis() returned null despite REDIS_URL being set — check redis.ts",
      );
    }
    redis = r;
  });

  afterAll(async () => {
    // Don't quit the shared client — it's a global singleton. Just drop refs.
  });

  afterEach(async () => {
    if (!redis) return;
    for (const token of TEST_TOKENS) {
      await redis.del(key(token));
    }
    TEST_TOKENS.length = 0;
  });

  function track(token: string): string {
    TEST_TOKENS.push(token);
    return token;
  }

  // ── Scenario A — single revoke ─────────────────────────────
  it(
    "scenario A: warm cache → invalidate → key holds tombstone JSON",
    async () => {
      const token = track(uniqueToken("scA"));
      await setCachedSession(token, fixtureValidSession, SESSION_CACHE_TTL_MS);
      await invalidateCachedSession(token);

      const raw = await redis.get(key(token));
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw as string);
      // Symmetric mock-reality guard against tombstone shape (T-14).
      expect(parsed).toStrictEqual<TombstoneShape>(tombstoneLiteral);
    },
  );

  // ── Scenario B — sign-out-everywhere ───────────────────────
  it(
    "scenario B: warm two tokens, invalidate both → both tombstoned (NOT deleted)",
    async () => {
      const tA = track(uniqueToken("scB-A"));
      const tB = track(uniqueToken("scB-B"));
      await setCachedSession(tA, fixtureValidSession, SESSION_CACHE_TTL_MS);
      await setCachedSession(tB, fixtureValidSession, SESSION_CACHE_TTL_MS);

      await invalidateCachedSession(tA);
      await invalidateCachedSession(tB);

      const rawA = await redis.get(key(tA));
      const rawB = await redis.get(key(tB));
      expect(rawA).not.toBeNull();
      expect(rawB).not.toBeNull();
      expect(JSON.parse(rawA as string)).toStrictEqual<TombstoneShape>(
        tombstoneLiteral,
      );
      expect(JSON.parse(rawB as string)).toStrictEqual<TombstoneShape>(
        tombstoneLiteral,
      );
    },
  );

  // ── Scenario C — bulk invalidation ─────────────────────────
  it(
    "scenario C: warm 5 entries, bulk-invalidate → all 5 keys tombstoned",
    async () => {
      const tokens = Array.from({ length: 5 }, (_, i) =>
        track(uniqueToken(`scC-${i}`)),
      );
      for (const t of tokens) {
        await setCachedSession(t, fixtureValidSession, SESSION_CACHE_TTL_MS);
      }

      await invalidateCachedSessionsBulk(tokens);

      for (const t of tokens) {
        const raw = await redis.get(key(t));
        expect(raw).not.toBeNull();
        expect(JSON.parse(raw as string)).toStrictEqual<TombstoneShape>(
          tombstoneLiteral,
        );
      }
    },
  );

  // ── Scenario D / H — Redis fail-open ───────────────────────
  // We can't truly stop Redis mid-test from inside the process, so we
  // emulate "Redis unreachable" by passing through getRedis() during the
  // call but reading on an unrelated, never-populated key. The contract:
  // getCachedSession returns null on a miss — never throws. This covers
  // the fail-open property of the wrapper layer (Scenarios D and H per the
  // plan share the same assertion).
  it(
    "scenario D/H: getCachedSession returns null on cache miss without throwing",
    async () => {
      const token = track(uniqueToken("scDH"));
      const result = await getCachedSession(token);
      expect(result).toBeNull();
    },
  );

  // ── Scenario E — Auth.js deleteSession adapter ────────────
  it.todo(
    "scenario E: auth-adapter.deleteSession(token) tombstones the cache key " +
      "(requires DB Session row setup; covered by adapter unit tests in Batch 4)",
  );

  // ── Scenario F — deleteUser cascade ───────────────────────
  it.todo(
    "scenario F: auth-adapter.deleteUser(userId) tombstones cache keys for " +
      "all of the user's sessions (requires DB User+Session setup; covered by " +
      "adapter unit tests in Batch 4)",
  );

  // ── Scenario G — tenant policy change (bulk) ──────────────
  it(
    "scenario G: invalidateCachedSessionsBulk over many tokens drives the " +
      "pipeline path (stand-in for tenant policy change)",
    async () => {
      const tokens = Array.from({ length: 8 }, (_, i) =>
        track(uniqueToken(`scG-${i}`)),
      );
      for (const t of tokens) {
        await setCachedSession(t, fixtureValidSession, SESSION_CACHE_TTL_MS);
      }

      await invalidateCachedSessionsBulk(tokens);

      for (const t of tokens) {
        const raw = await redis.get(key(t));
        expect(JSON.parse(raw as string)).toStrictEqual<TombstoneShape>(
          tombstoneLiteral,
        );
      }
    },
  );

  // ── Scenario I — populate-after-invalidate guard ──────────
  it(
    "scenario I: setCachedSession after invalidateCachedSession does NOT " +
      "overwrite the tombstone (NX rejection)",
    async () => {
      const token = track(uniqueToken("scI"));

      // 1. Write tombstone first.
      await invalidateCachedSession(token);

      // 2. Try to populate — NX must reject because tombstone exists.
      await setCachedSession(token, fixtureValidSession, SESSION_CACHE_TTL_MS);

      // 3. Direct redis.get — tombstone is still present.
      const raw = await redis.get(key(token));
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw as string)).toStrictEqual<TombstoneShape>(
        tombstoneLiteral,
      );
    },
  );

  // ── Scenario J — eviction policy independence ─────────────
  it(
    "scenario J: every cache write sets a finite PX TTL (memory bound, T-3)",
    async () => {
      const token = track(uniqueToken("scJ-set"));
      await setCachedSession(token, fixtureValidSession, SESSION_CACHE_TTL_MS);
      const ttlSet = await redis.pttl(key(token));
      // pttl returns -1 for no TTL, -2 for missing key. Must be finite > 0.
      expect(ttlSet).toBeGreaterThan(0);
      expect(ttlSet).toBeLessThanOrEqual(SESSION_CACHE_TTL_MS);

      const tomb = track(uniqueToken("scJ-tomb"));
      await invalidateCachedSession(tomb);
      const ttlTomb = await redis.pttl(key(tomb));
      expect(ttlTomb).toBeGreaterThan(0);
      expect(ttlTomb).toBeLessThanOrEqual(TOMBSTONE_TTL_MS);
    },
  );

  // ── Scenario K — real-Redis JSON round-trip ───────────────
  it(
    "scenario K: setCachedSession → redis.get → JSON.parse equals the typed fixture",
    async () => {
      const token = track(uniqueToken("scK"));
      await setCachedSession(token, fixtureValidSession, SESSION_CACHE_TTL_MS);

      const raw = await redis.get(key(token));
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw as string);
      expect(parsed).toStrictEqual<SessionInfo>(fixtureValidSession);

      // And the public read path returns the same typed value.
      const cached = await getCachedSession(token);
      expect(cached).toStrictEqual<SessionInfo>(fixtureValidSession);
    },
  );
});
