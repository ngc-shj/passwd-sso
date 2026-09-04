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
 * ─── What a failure means ──────────────────────────────────────────────────
 *
 * The first request must be ALLOWED. `ipRateLimiter` is
 * `failClosedOnRedisError: true`, so an unreachable Redis denies immediately —
 * this suite then reds on its first assertion with a message naming the
 * allowed arm, rather than passing for the wrong reason or skipping silently.
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
 * An address in TEST-NET-1 (RFC 5737, reserved for documentation), randomised
 * per run so two concurrent working copies cannot share a bucket. It must be a
 * value C1's boundary ACCEPTS — an unparseable one would collapse into the
 * shared `unknown` bucket, which is the key this file exists to stay out of.
 */
function perRunIp(): string {
  const n = parseInt(randomUUID().replace(/-/g, "").slice(0, 8), 16);
  return `192.0.2.${(n % 254) + 1}`;
}

function tokenRequest(ip: string): NextRequest {
  const req = createRequest("POST", "http://localhost:3000/api/mcp/token", {
    headers: { "x-forwarded-for": ip },
    // No grant_type: the limiter runs immediately after the body read, so the
    // request reaches it and then fails downstream on its own terms. What is
    // asserted below is only whether the LIMITER refused, never the domain
    // outcome — a body that succeeded would mint tokens this file has no
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
    // unreachable Redis — satisfies the deny assertion below on its own.
    for (let i = 1; i <= MCP_TOKEN_IP_RATE_MAX; i++) {
      const { status } = await parseResponse(await mcpTokenPOST(tokenRequest(ip)));
      expect(status, `request ${i} of ${MCP_TOKEN_IP_RATE_MAX} was rate-limited`).not.toBe(429);
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
    const fresh = perRunIp();
    expect(fresh).not.toBe(exhausted);
    usedKeys.push(`rl:mcp:token:ip:${exhausted}`, `rl:mcp:token:ip:${fresh}`);

    for (let i = 0; i <= MCP_TOKEN_IP_RATE_MAX; i++) {
      await mcpTokenPOST(tokenRequest(exhausted));
    }
    const { status: blocked } = await parseResponse(await mcpTokenPOST(tokenRequest(exhausted)));
    expect(blocked).toBe(429);

    const { status: allowed } = await parseResponse(await mcpTokenPOST(tokenRequest(fresh)));
    expect(allowed).not.toBe(429);
  });
});
