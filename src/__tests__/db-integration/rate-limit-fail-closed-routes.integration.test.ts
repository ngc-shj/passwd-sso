/**
 * Route-handler-level integration proof of the fail-closed chain (plan
 * contract C10, fail-closed-tranche2) — drives two real route handlers
 * end-to-end against a real broken Redis and a real DB, with NO mocks of
 * `@/lib/security/rate-limit` or `@/lib/security/rate-limit-audit`.
 *
 * Precedent: rate-limit-fail-closed-chain.integration.test.ts (tranche1 C5)
 * proves the library chain (createRateLimiter → checkRateLimitOrFail →
 * envelope) directly. This file proves the SAME chain is actually wired
 * into two representative route handlers — i.e. that the route bodies
 * really call the fail-closed path rather than merely being unit-tested
 * against a mocked limiter (see the 31 route.test.ts C2 mocks).
 *
 * Families (both pre-auth, minimal fixtures):
 *   1. POST /api/mcp/register — oauth envelope. The DCR rate limiter check
 *      precedes body parsing (route.ts:67-80), so a minimal/empty body is
 *      enough to reach it. Real-DB no-mutation proof: mcpClient row count
 *      unchanged.
 *   2. POST /api/share-links/verify-access — canonical envelope. Body parse
 *      precedes the limiter here (route.ts:37-38), so a schema-valid body is
 *      required to reach checkIpRateLimit/ipLimiter. Real-DB no-mutation
 *      proof: shareAccessLog row count unchanged (this route never writes
 *      that table on any path, but the count-before/count-after pattern
 *      still proves the 503 short-circuit did not fall through to any
 *      downstream write).
 *
 * Red-proof (RT7): same handlers driven with the REAL Redis client (when
 * REDIS_URL is set) proceed past the limiter and reach a non-503 domain
 * response for the same minimal/invalid fixture — proving the 503 above
 * discriminates on Redis failure, not on the fixture shape. Guarded by
 * `redisAvailable = !!process.env.REDIS_URL` (precedent:
 * admin-vault-reset-cross-tenant-sessions.integration.test.ts:35); the
 * broken-Redis cases run regardless of Redis availability.
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
import type { NextRequest } from "next/server";
import { createRequest } from "@/__tests__/helpers/request-builder";
import { createTestContext, type TestContext } from "./helpers";

// Real ioredis client pointed at a port nothing listens on — same shape as
// the tranche1 chain-test precedent (enableOfflineQueue:false +
// retryStrategy:null + a short connectTimeout so every command fails fast
// at the network layer instead of queuing for retry).
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

// Real ioredis client against the actual Redis (only connected/used by the
// red-proof cases, guarded by redisAvailable below).
const realRedis = process.env.REDIS_URL ? new IORedis(process.env.REDIS_URL) : null;
realRedis?.on("error", () => {});

// Switchable getRedis so the same route module can be driven against either
// client without re-importing — sound because createRateLimiter calls
// getRedis() per check (rate-limit.ts:54; Round 1 adjudication of Func-A1).
let activeRedis: IORedis = brokenRedis;

vi.mock("@/lib/redis", () => ({
  getRedis: () => activeRedis,
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

import { __resetThrottleForTests } from "@/lib/security/rate-limit-audit";
import { POST as mcpRegisterPOST } from "@/app/api/mcp/register/route";
import { POST as verifyAccessPOST } from "@/app/api/share-links/verify-access/route";

const dbAvailable = !!process.env.MIGRATION_DATABASE_URL || !!process.env.DATABASE_URL;
const redisAvailable = !!process.env.REDIS_URL;

// Precedent: rate-limit-fail-closed.integration.test.ts T4 fix — set BOTH
// the XFF header AND request.ip so extractClientIp returns the test IP
// regardless of TRUST_PROXY_HEADERS env state. The XFF path is gated by
// TRUST_PROXY_HEADERS; setting .ip covers the socket-fallback path too,
// hermetic against env config drift (checkIpRateLimit fails OPEN on a null
// IP, which would silently skip the Redis call this test needs to hit).
function requestWithIp(
  method: string,
  url: string,
  ip: string,
  body: unknown,
): NextRequest {
  const req = createRequest(method, url, {
    headers: { "x-forwarded-for": ip },
    body,
  });
  Object.defineProperty(req, "ip", { value: ip, configurable: true });
  return req;
}

describe.skipIf(!dbAvailable)(
  "rate-limit fail-closed route-handler integration (real Redis outage, C10)",
  () => {
    let ctx: TestContext;

    beforeAll(async () => {
      ctx = await createTestContext();
    });

    afterAll(async () => {
      brokenRedis.disconnect(false);
      realRedis?.disconnect(false);
      await ctx.cleanup();
    });

    beforeEach(() => {
      activeRedis = brokenRedis;
      __resetThrottleForTests();
    });

    afterEach(async () => {
      // Let the fire-and-forget emitRateLimitFailClosed (void'd inside
      // checkRateLimitOrFail) settle before the next test resets the
      // throttle / before teardown — same rationale as the chain-test
      // precedent (avoids an orphan audit_outbox insert racing cleanup).
      await new Promise((resolve) => setTimeout(resolve, 200));
      __resetThrottleForTests();
    });

    describe("POST /api/mcp/register (oauth envelope)", () => {
      it("broken Redis -> 503 temporarily_unavailable with Retry-After, no mcpClient row created", async () => {
        const countBefore = await ctx.su.prisma.mcpClient.count();

        const req = requestWithIp(
          "POST",
          "http://localhost:3000/api/mcp/register",
          "203.0.113.10",
          {},
        );

        const res = await mcpRegisterPOST(req);

        expect(res.status).toBe(503);
        const body = await res.json();
        expect(body).toEqual({ error: "temporarily_unavailable" });
        const retryAfter = res.headers.get("Retry-After");
        expect(retryAfter).toMatch(/^\d+$/);
        expect(Number(retryAfter)).toBeGreaterThan(0);

        const countAfter = await ctx.su.prisma.mcpClient.count();
        expect(countAfter).toBe(countBefore);
      });

      it.skipIf(!redisAvailable)(
        "red-proof: real Redis proceeds past the limiter to a non-503 domain response",
        async () => {
          activeRedis = realRedis as IORedis;

          const countBefore = await ctx.su.prisma.mcpClient.count();

          // Empty body: passes the limiter (real Redis reachable), then
          // fails Zod parsing at the body-parse step (route.ts:89-102) ->
          // 400, never reaching mcpClient.create. Proves the 503 above was
          // Redis-outage discrimination, not a fixture artifact.
          const req = requestWithIp(
            "POST",
            "http://localhost:3000/api/mcp/register",
            "203.0.113.11",
            {},
          );

          const res = await mcpRegisterPOST(req);

          expect(res.status).not.toBe(503);
          expect(res.status).toBe(400);

          const countAfter = await ctx.su.prisma.mcpClient.count();
          expect(countAfter).toBe(countBefore);
        },
      );
    });

    describe("POST /api/share-links/verify-access (canonical envelope)", () => {
      it("broken Redis -> 503 SERVICE_UNAVAILABLE with Retry-After, no shareAccessLog row created", async () => {
        const countBefore = await ctx.su.prisma.shareAccessLog.count();

        // Schema-valid body (verifyShareAccessSchema: token = 64-char hex,
        // password 1..43 chars) required — parse precedes the limiter here.
        const req = requestWithIp(
          "POST",
          "http://localhost:3000/api/share-links/verify-access",
          "203.0.113.20",
          { token: "a".repeat(64), password: "test-password" },
        );

        const res = await verifyAccessPOST(req);

        expect(res.status).toBe(503);
        const body = await res.json();
        expect(body).toEqual({ error: "SERVICE_UNAVAILABLE" });
        const retryAfter = res.headers.get("Retry-After");
        expect(retryAfter).toMatch(/^\d+$/);
        expect(Number(retryAfter)).toBeGreaterThan(0);

        const countAfter = await ctx.su.prisma.shareAccessLog.count();
        expect(countAfter).toBe(countBefore);
      });

      it.skipIf(!redisAvailable)(
        "red-proof: real Redis proceeds past the ipLimiter to a non-503 domain response",
        async () => {
          activeRedis = realRedis as IORedis;

          const countBefore = await ctx.su.prisma.shareAccessLog.count();

          // Same schema-valid-but-nonexistent-token body: passes both
          // limiters (real Redis reachable), then the share lookup misses
          // -> notFound() (route.ts:83-85). Proves the 503 above was
          // Redis-outage discrimination, not a fixture artifact.
          const req = requestWithIp(
            "POST",
            "http://localhost:3000/api/share-links/verify-access",
            "203.0.113.21",
            { token: "b".repeat(64), password: "test-password" },
          );

          const res = await verifyAccessPOST(req);

          expect(res.status).not.toBe(503);
          expect(res.status).toBe(404);

          const countAfter = await ctx.su.prisma.shareAccessLog.count();
          expect(countAfter).toBe(countBefore);
        },
      );
    });
  },
);
