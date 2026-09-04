/**
 * CFP3 — `/api/mcp/token`'s per-IP limiter is bounded at its configured max.
 *
 * C1 (CF11) closed a fail-open here: the limiter used to sit behind `if (ip)`,
 * so a request whose client IP could not be parsed skipped rate limiting
 * entirely. The unit test in `src/app/api/mcp/token/route.test.ts` proves the
 * limiter is now consulted and names the bucket (`rl:mcp:token:ip:unknown`),
 * but it mocks `@/lib/security/rate-limit` at module scope, so it has no
 * counter to advance and cannot say whether the bucket is bounded at all. That
 * was recorded as CFP3's open half.
 *
 * This file closes it, driving the REAL route handler against the REAL limiter:
 * neither `@/lib/security/rate-limit` nor `@/lib/security/rate-limit-audit` is
 * mocked here. Vitest mocks are per file, so `route.test.ts`'s module-scope
 * mock is untouched and needs no unpicking — the cost recorded against CFP3
 * overstated this, which is what the Phase 3 review found.
 *
 * ─── Why a per-run IP rather than the `unknown` bucket ─────────────────────
 *
 * The bucket under the fail-open fix is literally `rl:mcp:token:ip:unknown` — a
 * FIXED key. Exhausting it would race every other working copy sharing this
 * dev Redis, and would leave the endpoint rate-limited for them for the rest of
 * the window. So the capacity property is driven on a per-run IP, which routes
 * to `rl:mcp:token:ip:<that ip>` through the same `checkRateLimitOrFail` call
 * with the same limiter instance. What is proven here is the bound; what is
 * proven in the unit test is that a null IP lands in a bucket at all. Neither
 * half is sufficient alone, and this comment is the tie.
 *
 * The IP is set BOTH as `x-forwarded-for` and as `request.ip` — the precedent
 * from `rate-limit-fail-closed-routes.integration.test.ts` — so the value
 * reaches `extractClientIp` regardless of `TRUST_PROXY_HEADERS`.
 *
 * ─── What a failure means, and why the allow arm asserts a STATUS ──────────
 *
 * The allowed arm asserts `400 unsupported_grant_type` — the concrete outcome
 * of a request that reached the limiter, was admitted, and then failed
 * downstream on its own terms — rather than the weaker `not 429`.
 *
 * The weaker form was the first version of this file and it could not fail for
 * the reason this comment used to claim. `ipRateLimiter` is
 * `failClosedOnRedisError: true`, and `checkRateLimitOrFail` renders that
 * refusal as `oauthTemporarilyUnavailable()` — **503**, not 429
 * (`src/lib/http/api-response.ts:187-194`). A totally unreachable Redis
 * therefore returns 503 on every iteration, `not.toBe(429)` accepts all thirty,
 * and the suite only reds at the final boundary with a generic
 * `expected 503 to be 429` naming neither the request index nor the arm. The
 * property this file exists to prove — the endpoint is not silently
 * fail-closed — went unasserted. Asserting the status the allow arm actually
 * produces is what makes the failure loud and specific.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { createRequest, parseResponse } from "@/__tests__/helpers/request-builder";
import { MCP_TOKEN_IP_RATE_MAX } from "@/lib/constants/auth/mcp";
import { __resetThrottleForTests } from "@/lib/security/rate-limit-audit";
import { getRedis } from "@/lib/redis";
import { POST as mcpTokenPOST } from "@/app/api/mcp/token/route";

const redisAvailable = !!process.env.REDIS_URL;

/**
 * An address in 198.18.0.0/15 — RFC 2544's benchmarking range, reserved for
 * exactly this kind of device testing and never routed to a real client.
 *
 * Randomised per run so two concurrent working copies cannot share a bucket.
 * The range matters as much as the randomisation: RFC 5737's documentation
 * blocks are a /24 each, so drawing from one gives 254 values and a collision
 * between two unrelated runs on this shared dev Redis is a live probability
 * rather than a remote one. /15 gives ~131k.
 *
 * It must be a value C1's boundary ACCEPTS — an unparseable one would collapse
 * into the shared `unknown` bucket, which is the key this file exists to stay
 * out of.
 */
function perRunIp(): string {
  const hex = randomUUID().replace(/-/g, "");
  const second = 18 + (parseInt(hex.slice(0, 2), 16) % 2);
  return `198.${second}.${parseInt(hex.slice(2, 4), 16)}.${parseInt(hex.slice(4, 6), 16)}`;
}

/**
 * A per-run address distinct from `other`, retried rather than asserted.
 *
 * A bare `expect(fresh).not.toBe(exhausted)` is a self-inflicted failure at the
 * collision rate — noise that looks like a defect and is not one. Bounded and
 * loud rather than a `while (true)`: eight identical draws means the entropy
 * source is broken, which must say so instead of hanging the suite.
 */
function perRunIpDistinctFrom(other: string): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const ip = perRunIp();
    if (ip !== other) return ip;
  }
  throw new Error(
    "perRunIp() returned the same address 8 times — its entropy source is broken, " +
      "so this suite cannot distinguish two buckets and must not report a verdict",
  );
}

function tokenRequest(ip: string): NextRequest {
  const req = createRequest("POST", "http://localhost:3000/api/mcp/token", {
    headers: { "x-forwarded-for": ip },
    // No grant_type, deliberately: the limiter runs immediately after the body
    // read, so the request reaches it and then fails downstream at the
    // grant-type switch with `400 unsupported_grant_type`. That 400 is what the
    // allow arm asserts — it is the nearest observable evidence that a request
    // was ADMITTED, and it is reachable without minting tokens this file has no
    // business creating.
    body: {},
  });
  Object.defineProperty(req, "ip", { value: ip, configurable: true });
  return req;
}

describe.skipIf(!redisAvailable)("/api/mcp/token per-IP rate limit capacity (CFP3)", () => {
  const usedKeys: string[] = [];

  beforeAll(() => {
    __resetThrottleForTests();
  });

  afterAll(async () => {
    // Reclaim this run's buckets so a re-run inside the same window starts
    // clean and nothing is left counting against an address we invented.
    const redis = getRedis();
    if (redis && usedKeys.length > 0) {
      await Promise.all(usedKeys.map((k) => redis.del(k).catch(() => 0)));
    }
    vi.restoreAllMocks();
  });

  it("allows exactly MCP_TOKEN_IP_RATE_MAX requests from one IP and refuses the next", async () => {
    const ip = perRunIp();
    usedKeys.push(`rl:mcp:token:ip:${ip}`);

    // The allow arm, and it is the load-bearing half: a limiter that refused
    // everything — which is what `failClosedOnRedisError` does against an
    // unreachable Redis — satisfies a `not 429` assertion on its own, because
    // that refusal is a 503. So assert the status an ADMITTED request produces.
    for (let i = 1; i <= MCP_TOKEN_IP_RATE_MAX; i++) {
      const { status, json } = await parseResponse(await mcpTokenPOST(tokenRequest(ip)));
      expect(
        status,
        `request ${i} of ${MCP_TOKEN_IP_RATE_MAX} did not reach the handler ` +
          `(429 = rate-limited, 503 = limiter failed closed)`,
      ).toBe(400);
      expect(json.error).toBe("unsupported_grant_type");
    }

    // The boundary and its tie: the cap is the number of requests ADMITTED, so
    // request max is the last allowed one and max+1 is the first refused.
    const res = await mcpTokenPOST(tokenRequest(ip));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(429);
    expect(json.error).toBe("slow_down");
  });

  it("bounds each IP separately — a second address is unaffected by the first's exhaustion", async () => {
    // Without this the case above is also satisfied by a limiter keyed on
    // nothing at all (a global counter), which would take the whole endpoint
    // down for every caller once any one of them crossed the bound.
    const exhausted = perRunIp();
    const fresh = perRunIpDistinctFrom(exhausted);
    usedKeys.push(`rl:mcp:token:ip:${exhausted}`, `rl:mcp:token:ip:${fresh}`);

    for (let i = 0; i <= MCP_TOKEN_IP_RATE_MAX; i++) {
      await mcpTokenPOST(tokenRequest(exhausted));
    }
    const { status: blocked } = await parseResponse(await mcpTokenPOST(tokenRequest(exhausted)));
    expect(blocked).toBe(429);

    // The concrete admitted status again, for the same reason: `not 429` would
    // also accept the 503 a fail-closed limiter returns, and this arm's whole
    // claim is that the SECOND address was admitted.
    const { status: allowed, json } = await parseResponse(
      await mcpTokenPOST(tokenRequest(fresh)),
    );
    expect(allowed).toBe(400);
    expect(json.error).toBe("unsupported_grant_type");
  });
});
