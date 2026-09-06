/**
 * C3 / N2 — sign-in still works when the session-timeout cache is cold.
 *
 * `createSession` opens a `withBypassRls`, and `resolveEffectiveSessionTimeouts`
 * opens its own on a cache MISS. That was bypass-in-bypass, which the guard used
 * to allow; C3 rejects it, so the call was hoisted above the opener. If the
 * hoist is ever undone, every sign-in on a cold cache throws
 * `INVALID_RLS_NESTING` — and a cold cache is the state after every deploy.
 *
 * Nothing else in the tree can see that. `auth-adapter.test.ts` mocks
 * `session-timeout` wholesale AND overrides `withBypassRls` with a passthrough
 * that never enters `tenantRlsStorage.run`, so the guard cannot fire there;
 * `session-timeout.test.ts` stubs `@/lib/tenant-rls`; and the existing
 * `session-timeout` integration test calls the resolver directly rather than
 * through `createSession`. This file is the only venue where the real guard, the
 * real opener and the real resolver run together.
 *
 * Both cache cells are asserted, and the warm one is warmed OUTSIDE
 * `createSession` on purpose: warming it with a first `createSession` call makes
 * that call itself a miss, so both cells redden under the same mutation and the
 * pair distinguishes nothing. Warmed externally, the warm cell stays green when
 * the hoist is undone — which is what makes the cold cell the load-bearing one
 * rather than merely the first one.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, type TestContext } from "./helpers";
import { createCustomAdapter } from "@/lib/auth/session/auth-adapter";
import {
  resolveEffectiveSessionTimeouts,
  _internal as sessionTimeoutInternal,
} from "@/lib/auth/session/session-timeout";

describe("createSession with a cold session-timeout cache (C3/N2)", () => {
  let ctx: TestContext;
  let tenantId: string;
  let userId: string;
  const createdTokens: string[] = [];

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.cleanup();
  });
  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    userId = await ctx.createUser(tenantId);
  });
  afterEach(async () => {
    // Registered here rather than at the end of each `it`, so it runs on the
    // failure path too.
    createdTokens.length = 0;
    await ctx.deleteTestData(tenantId);
  });

  async function createSession() {
    const adapter = createCustomAdapter();
    const sessionToken = randomUUID();
    createdTokens.push(sessionToken);
    return adapter.createSession!({
      sessionToken,
      userId,
      expires: new Date(Date.now() + 60_000),
    });
  }

  it("creates a session when the cache is COLD", async () => {
    sessionTimeoutInternal.clear();
    // Asserted positively: a cache that was never populated and one that was
    // cleared are the same state here, but a `clear` that silently did nothing
    // would leave this test measuring the warm path under a cold name.
    expect(sessionTimeoutInternal.cache.size).toBe(0);

    const created = await createSession();

    expect(created.userId).toBe(userId);
    // The miss populated it — which is what proves the resolver actually ran
    // rather than being short-circuited by a stale entry.
    expect(sessionTimeoutInternal.cache.size).toBeGreaterThan(0);
  });

  it("creates a session when the cache is WARM", async () => {
    // The allow-side companion, and the warming has to happen OUTSIDE
    // createSession for it to be one. Warming it with a first createSession
    // call — the obvious shape — makes this cell red under the same mutation as
    // the cold cell, because that first call is itself a miss. Measured: with
    // the resolver moved back inside the opener, warming-by-createSession
    // reddens BOTH cells, and the pair stops distinguishing anything.
    sessionTimeoutInternal.clear();
    await resolveEffectiveSessionTimeouts(userId, null);
    const warmedSize = sessionTimeoutInternal.cache.size;
    expect(warmedSize).toBeGreaterThan(0);

    const created = await createSession();

    expect(created.userId).toBe(userId);
    expect(sessionTimeoutInternal.cache.size).toBe(warmedSize);
  });
});
