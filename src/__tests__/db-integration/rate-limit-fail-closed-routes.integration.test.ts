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
import { randomBytes } from "node:crypto";
import IORedis from "ioredis";
import { hashToken } from "@/lib/crypto/crypto-server";
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

/**
 * Selective-failure Redis (plan fail-closed-sc-t3-remaining, C4): routes each
 * command to the broken or the real client by key predicate, so one limiter
 * leg of a multi-limiter route can fail while its sibling succeeds. Covers
 * exactly the surface createRateLimiter uses (rate-limit.ts:60-106):
 * pipeline().incr/pexpire/pttl -> exec, plus del (limiter clear). The del
 * branch is defensive surface-completeness — the 503/404 paths under test
 * never call limiter.clear(). No command result is fabricated: everything
 * delegates to a real ioredis client.
 */
function createSelectiveRedis(
  broken: IORedis,
  real: IORedis,
  failKeyPredicate: (key: string) => boolean,
): IORedis {
  const pick = (key: string) => (failKeyPredicate(key) ? broken : real);
  type PipelineCmd = { cmd: "incr" | "pexpire" | "pttl"; args: unknown[] };
  const selective = {
    pipeline() {
      const commands: PipelineCmd[] = [];
      let routeKey: string | null = null;
      const shim = {
        incr(key: string) {
          routeKey ??= key;
          commands.push({ cmd: "incr", args: [key] });
          return shim;
        },
        pexpire(key: string, ms: number, mode?: string) {
          routeKey ??= key;
          commands.push({ cmd: "pexpire", args: mode !== undefined ? [key, ms, mode] : [key, ms] });
          return shim;
        },
        pttl(key: string) {
          routeKey ??= key;
          commands.push({ cmd: "pttl", args: [key] });
          return shim;
        },
        exec() {
          const pipeline = pick(routeKey ?? "").pipeline();
          for (const { cmd, args } of commands) {
            (pipeline[cmd] as (...a: unknown[]) => unknown)(...args);
          }
          return pipeline.exec();
        },
      };
      return shim;
    },
    del(key: string) {
      return pick(key).del(key);
    },
  };
  return selective as unknown as IORedis;
}

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

    // C4 (fail-closed-sc-t3-remaining): the whole-outage cases above cannot
    // reach verify-access's tokenLimiter — the ipLimiter leg fails closed
    // first. Selective failure (IP keys real, token keys broken) drives the
    // request PAST a passing ipLimiter into the token leg, proving the
    // route wires tokenLimiter's production checkRateLimitOrFail mapping.
    // Requires a reachable real Redis for the IP leg -> redisAvailable guard.
    describe.skipIf(!redisAvailable)(
      "POST /api/share-links/verify-access — tokenLimiter leg (selective Redis failure)",
      () => {
        // Reserved IPs (plan C4 hygiene): unused elsewhere in db-integration;
        // one request per case against the 5-req/min IP cap.
        const GREEN_IP = "203.0.113.30";
        const RED_IP = "203.0.113.31";

        // Fresh random token per run: the red-proof's 404 is guaranteed by
        // construction, not by fixture-absence convention. 64-hex satisfies
        // verifyShareAccessSchema's token shape.
        const randomHexToken = () => randomBytes(32).toString("hex");

        // Exact-key cleanup ledger. A pattern KEYS + bulk DEL would delete
        // counters this test never created (and KEYS blocks a large shared
        // Redis) — if a developer points REDIS_URL at a shared/staging
        // instance, that resets real protection state (external security
        // review 2026-07-20, P2-2). Key shapes derived from the route:
        // ip leg  rl:share_verify_ip:<ip>:<sha256(token)> (IPv4 passthrough
        // in rateLimitKeyFromIp; checkIpRateLimit keySuffix = tokenHash),
        // token leg rl:share_verify_token:<sha256(token)>.
        const createdKeys: string[] = [];
        const trackKeys = (ip: string, token: string) => {
          const tokenHash = hashToken(token);
          createdKeys.push(
            `rl:share_verify_ip:${ip}:${tokenHash}`,
            `rl:share_verify_token:${tokenHash}`,
          );
        };

        afterEach(async () => {
          // Drop exactly the counters this describe's cases created on the
          // REAL Redis (the green case's token incr went to the broken
          // client and never landed here — deleting its computed key is a
          // no-op, kept for symmetry).
          if (createdKeys.length > 0) {
            await (realRedis as IORedis).del(...createdKeys.splice(0));
          }
        });

        it("token leg broken, IP leg real -> 503 SERVICE_UNAVAILABLE with Retry-After, no shareAccessLog row", async () => {
          activeRedis = createSelectiveRedis(brokenRedis, realRedis as IORedis, (key) =>
            key.startsWith("rl:share_verify_token:"),
          );

          const countBefore = await ctx.su.prisma.shareAccessLog.count();

          const token = randomHexToken();
          trackKeys(GREEN_IP, token);
          const req = requestWithIp(
            "POST",
            "http://localhost:3000/api/share-links/verify-access",
            GREEN_IP,
            { token, password: "test-password" },
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

        it("red-proof: identical fixture with the token leg ALSO real -> non-503 domain response (404)", async () => {
          // Whole path real. The IP leg is identical to the case above, so
          // the 503 there is attributable ONLY to the token leg — a wrapper
          // that failed every key (or was wired backwards) would 503 here
          // too and fail this assertion.
          activeRedis = realRedis as IORedis;

          const countBefore = await ctx.su.prisma.shareAccessLog.count();

          const token = randomHexToken();
          trackKeys(RED_IP, token);
          const req = requestWithIp(
            "POST",
            "http://localhost:3000/api/share-links/verify-access",
            RED_IP,
            { token, password: "test-password" },
          );

          const res = await verifyAccessPOST(req);

          expect(res.status).not.toBe(503);
          expect(res.status).toBe(404);

          const countAfter = await ctx.su.prisma.shareAccessLog.count();
          expect(countAfter).toBe(countBefore);
        });
      },
    );
  },
);
