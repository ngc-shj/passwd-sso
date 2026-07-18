/**
 * Shared contract-test helper for the `failClosedOnRedisError: true` 503
 * path (fail-closed-tranche1 plan, contract C1).
 *
 * Consumers (the 18 colocated `route.test.ts` files, C2) call
 * `assertRedisFailClosed` with their existing limiter/factory mocks to prove:
 *   1. the limiter under test is reached,
 *   2. a Redis error maps to the documented 503 envelope (incl. Retry-After),
 *   3. no write-primitive mutation executes,
 *   4. the limiter under test was constructed with `failClosedOnRedisError: true`
 *      — attributed via strict identity on `limiterFactory.mock.results`, so a
 *      sibling limiter in a multi-limiter route cannot mask a silent opt-in
 *      removal on the limiter actually under test.
 *
 * The helper deliberately does NOT touch `@/lib/security/rate-limit-audit` —
 * production `checkRateLimitOrFail` must stay in the tested path (RT5).
 */

import { expect, vi } from "vitest";
import type { Mock } from "vitest";
import type { RateLimitResult } from "@/lib/security/rate-limit";

export type RedisErroredFailure = RateLimitResult & { redisErrored: true };

export type FailClosedExpectation =
  | { envelope: "canonical" }
  | { envelope: "oauth" }
  | { envelope: "custom"; status: number; body: Record<string, unknown> };

/**
 * Snapshot a `createRateLimiter` factory mock's recorded (args, returnValue)
 * pairs BEFORE a `vi.clearAllMocks()`/`resetAllMocks()` wipes them.
 *
 * The factory is invoked once at module load time (module-level
 * `const xLimiter = createRateLimiter(...)`), which happens before any
 * `beforeEach` runs. In files whose `beforeEach` calls
 * `vi.clearAllMocks()`, that hygiene step wipes `mock.calls`/`mock.results`
 * on every `vi.fn()` — including the factory — before the first test body
 * runs, so `limiterFactory.mock.results` is empty by the time
 * `assertRedisFailClosed` would read it.
 *
 * `snapshotFactory` must be called once at module scope, right after the
 * route import (before any test/`beforeEach` executes), to capture the
 * real call args + return values into plain data. Call `.replay()` inside
 * the test (built fresh each time, after any prior clear) to get a
 * `Mock` whose own `mock.calls`/`mock.results` are populated for
 * `assertRedisFailClosed`'s attribution step — the replay's data comes only
 * from the real captured module-load invocations, so this does not
 * fabricate factory behavior.
 */
export function snapshotFactory(mock: Mock): { replay: () => Mock } {
  const args = mock.mock.calls.map((call) => call[0]);
  const results = mock.mock.results.map((result) => result.value);
  return {
    replay: () => {
      const replayed = vi.fn();
      for (const value of results) replayed.mockReturnValueOnce(value);
      for (const callArgs of args) replayed(callArgs);
      return replayed;
    },
  };
}

export async function assertRedisFailClosed(options: {
  /** Executes the route handler and returns its Response. Any thunk. */
  invoke: () => Promise<Response>;
  /** The mocked limiter under test — MUST be the factory result object itself. */
  limiter: { check: Mock };
  expectation: FailClosedExpectation;
  /** Write-primitive spies; each asserted .not.toHaveBeenCalled(). Must be non-empty. */
  assertNoMutation: readonly Mock[];
  /** Recorded createRateLimiter factory mock. Mandatory — see module doc. */
  limiterFactory: Mock;
  /**
   * The redisErrored fixture the limiter's check() resolves to. REQUIRED —
   * callers pass the literal (e.g. `{ allowed: false, redisErrored: true }`)
   * inline at each callsite so it is type-checked code, not a comment.
   */
  failure: RedisErroredFailure;
}): Promise<void> {
  const { invoke, limiter, expectation, assertNoMutation, limiterFactory, failure } = options;

  if (assertNoMutation.length === 0) {
    throw new Error(
      "assertRedisFailClosed: assertNoMutation must be non-empty — pass at least one write-primitive spy",
    );
  }

  // 1. Arrange: limiter-layer mock only. Sibling limiters in multi-limiter
  // routes must be arranged by the caller before invoking this helper.
  limiter.check.mockResolvedValue(failure);

  // 2. Act
  const res = await invoke();

  // 3. Assert limiter reached
  expect(limiter.check).toHaveBeenCalled();

  // 4. Assert envelope
  const body: unknown = await res.json();
  const retryAfter = res.headers.get("Retry-After");

  if (expectation.envelope === "canonical") {
    expect(res.status).toBe(503);
    expect(body).toMatchObject({ error: "SERVICE_UNAVAILABLE" });
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).not.toBeNaN();
  } else if (expectation.envelope === "oauth") {
    expect(res.status).toBe(503);
    expect(body).toMatchObject({ error: "temporarily_unavailable" });
    expect(body).not.toHaveProperty("error_description");
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).not.toBeNaN();
  } else {
    expect(res.status).toBe(expectation.status);
    expect(body).toEqual(expectation.body);
  }

  // 5. Assert no mutation
  for (const spy of assertNoMutation) {
    expect(spy).not.toHaveBeenCalled();
  }

  // 6. Assert factory options (attributed, identity-only).
  const callIndex = limiterFactory.mock.results.findIndex(
    (result) => result.value === limiter,
  );
  if (callIndex === -1) {
    throw new Error(
      "assertRedisFailClosed: limiter not produced by limiterFactory — pass the factory result object itself",
    );
  }
  const factoryArgs = limiterFactory.mock.calls[callIndex] as unknown[];
  const factoryOptions = factoryArgs[0] as { failClosedOnRedisError?: boolean };
  expect(factoryOptions.failClosedOnRedisError).toBe(true);
}
