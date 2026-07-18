/**
 * Integration proof of the production fail-closed chain (plan contract C5,
 * fail-closed-tranche1) — real broken Redis, no limiter/rate-limit mocks.
 *
 * NOTE on filename: `rate-limit-fail-closed.integration.test.ts` is already
 * taken by AC5.4a (PR #473, `emitRateLimitFailClosed` → audit_outbox write
 * proof) — a different, already-shipped contract. This file is the
 * tranche1-C5 deliverable under a non-colliding name; see plan
 * docs/archive/review/fail-closed-tranche1-plan.md § C5.
 *
 * Proves, against a real ioredis client pointed at a non-listening port
 * (network-layer failure, no mocking of @/lib/security/rate-limit or
 * @/lib/security/rate-limit-audit):
 *   1. createRateLimiter({ failClosedOnRedisError: true }).check() resolves
 *      { allowed: false, redisErrored: true }.
 *   2. production checkRateLimitOrFail maps that result to the canonical
 *      503 envelope (+ Retry-After) and to the oauth 503 envelope
 *      (+ Retry-After, no error_description).
 *   3. Red-proof sibling: the SAME broken Redis WITHOUT
 *      failClosedOnRedisError falls back open (in-memory fallback,
 *      { allowed: true }, no redisErrored) — proves the assertions above
 *      discriminate on the option rather than on Redis being down per se.
 *
 * `emitRateLimitFailClosed` fires as `void` inside checkRateLimitOrFail; it
 * is error-swallowed and awaited indirectly here via a short flush delay so
 * it cannot produce an unhandled rejection during the test run.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import IORedis from "ioredis";
import { createRequest } from "@/__tests__/helpers/request-builder";
import {
  createTestContext,
  type TestContext,
} from "./helpers";

// Real ioredis client pointed at a port nothing listens on. With
// enableOfflineQueue:false + retryStrategy:null + a short connectTimeout,
// every command fails fast at the network layer instead of queuing for
// retry — matches the vault-reset-cache-tombstone-redis-failure precedent
// so the test stays well under the lane's 30s testTimeout.
const brokenRedis = new IORedis({
  host: "127.0.0.1",
  port: 1,
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 0,
  retryStrategy: () => null,
  connectTimeout: 100,
});
brokenRedis.on("error", () => {});

vi.mock("@/lib/redis", () => ({
  getRedis: () => brokenRedis,
  validateRedisConfig: () => {},
}));

vi.mock("@/lib/logger", () => {
  const noop = vi.fn();
  const child = { info: noop, warn: noop, error: noop };
  return {
    default: {
      info: noop,
      warn: noop,
      error: noop,
      child: vi.fn().mockReturnValue(child),
    },
    getLogger: () => ({ info: noop, warn: noop, error: noop }),
    requestContext: { run: (_s: unknown, fn: () => unknown) => fn(), getStore: () => undefined },
  };
});

import { createRateLimiter } from "@/lib/security/rate-limit";
import {
  checkRateLimitOrFail,
  __resetThrottleForTests,
} from "@/lib/security/rate-limit-audit";

const dbAvailable = !!process.env.MIGRATION_DATABASE_URL || !!process.env.DATABASE_URL;

describe.skipIf(!dbAvailable)(
  "rate-limit fail-closed production chain under real Redis outage (integration)",
  () => {
    let ctx: TestContext;
    let tenantId: string;
    let userId: string;

    beforeAll(async () => {
      ctx = await createTestContext();
    });

    afterAll(async () => {
      brokenRedis.disconnect(false);
      await ctx.cleanup();
    });

    beforeEach(async () => {
      tenantId = await ctx.createTenant();
      userId = await ctx.createUser(tenantId);
      __resetThrottleForTests();
    });

    afterEach(async () => {
      // Let the fire-and-forget emitRateLimitFailClosed (void'd inside
      // checkRateLimitOrFail) settle BEFORE tearing down the tenant row —
      // otherwise its in-flight audit_outbox insert can land after
      // deleteTestData's own `DELETE FROM audit_outbox` step, leaving an
      // orphan row that then FK-violates the `DELETE FROM tenants` step.
      await new Promise((resolve) => setTimeout(resolve, 200));
      await ctx.deleteTestData(tenantId);
      __resetThrottleForTests();
    });

    it("createRateLimiter fail-closed check() resolves { allowed: false, redisErrored: true } against unreachable Redis", async () => {
      const limiter = createRateLimiter({
        windowMs: 1000,
        max: 1,
        failClosedOnRedisError: true,
      });

      const result = await limiter.check(`rlfc-test:${userId}`);

      expect(result).toEqual({ allowed: false, redisErrored: true });
    });

    it("checkRateLimitOrFail maps redisErrored to the canonical 503 envelope with Retry-After", async () => {
      const limiter = createRateLimiter({
        windowMs: 1000,
        max: 1,
        failClosedOnRedisError: true,
      });
      const req = createRequest("POST", "http://localhost:3000/api/vault/unlock");

      const res = await checkRateLimitOrFail({
        req,
        scope: "vault.unlock",
        userId,
        tenantId,
        limiter,
        key: `rlfc-canonical:${userId}`,
      });

      expect(res).not.toBeNull();
      expect(res?.status).toBe(503);
      const body = await res?.json();
      expect(body).toEqual({ error: "SERVICE_UNAVAILABLE" });
      const retryAfter = res?.headers.get("Retry-After");
      // RFC 9110 delay-seconds: non-negative integer string (Number() would
      // accept "", whitespace, negatives, decimals).
      expect(retryAfter).toMatch(/^\d+$/);
      expect(Number(retryAfter)).toBeGreaterThan(0);
    });

    it("checkRateLimitOrFail maps redisErrored to the oauth 503 envelope with Retry-After, no error_description", async () => {
      const limiter = createRateLimiter({
        windowMs: 1000,
        max: 1,
        failClosedOnRedisError: true,
      });
      const req = createRequest("POST", "http://localhost:3000/api/mcp/token");

      const res = await checkRateLimitOrFail({
        req,
        scope: "mcp.token",
        userId,
        tenantId,
        envelope: "oauth",
        limiter,
        key: `rlfc-oauth:${userId}`,
      });

      expect(res).not.toBeNull();
      expect(res?.status).toBe(503);
      const body = await res?.json();
      expect(body).toEqual({ error: "temporarily_unavailable" });
      expect(body).not.toHaveProperty("error_description");
      const retryAfter = res?.headers.get("Retry-After");
      // RFC 9110 delay-seconds: non-negative integer string (Number() would
      // accept "", whitespace, negatives, decimals).
      expect(retryAfter).toMatch(/^\d+$/);
      expect(Number(retryAfter)).toBeGreaterThan(0);
    });

    // Red-proof (RT7): same broken Redis, but the limiter did NOT opt into
    // failClosedOnRedisError — proves the assertions above discriminate on
    // the option, not merely on "Redis is down".
    it("red-proof: the same broken Redis WITHOUT failClosedOnRedisError falls back open (in-memory)", async () => {
      const limiter = createRateLimiter({
        windowMs: 1000,
        max: 1,
        // failClosedOnRedisError intentionally omitted (default false).
      });

      const result = await limiter.check(`rlfc-fallback:${userId}`);

      expect(result.allowed).toBe(true);
      expect(result).not.toHaveProperty("redisErrored");
    });
  },
);
