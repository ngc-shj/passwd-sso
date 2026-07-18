/**
 * Helper self-test (red-proof) for `assertRedisFailClosed` — plan contract C6.
 *
 * 21 fail-closed cases across 18 route files depend on this single helper;
 * a helper bug must not vacuously green the tranche. Case (1) proves a
 * correct invocation passes; cases (2)-(7) each deliberately break one
 * behavior and prove the helper rejects.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import { assertRedisFailClosed, snapshotFactory } from "./fail-closed";

function makeLimiter(): { check: Mock } {
  return { check: vi.fn() };
}

/** Records factory calls the way a `vi.fn((opts) => ({check, clear}))` mock does. */
function makeLimiterFactory(): Mock {
  return vi.fn((_opts: unknown) => makeLimiter());
}

function canonicalResponse(): Response {
  return new Response(JSON.stringify({ error: "SERVICE_UNAVAILABLE" }), {
    status: 503,
    headers: { "Retry-After": "30" },
  });
}

/**
 * Minimal fake route: calls the limiter under test (as a real handler would
 * via `checkRateLimitOrFail`) and returns `onRedisErrored()` (default: the
 * canonical 503 envelope) when the limiter reports redisErrored.
 */
function fakeRoute(
  limiter: { check: Mock },
  onRedisErrored: () => Response = canonicalResponse,
): () => Promise<Response> {
  return async () => {
    const result = await limiter.check("k");
    if (result.redisErrored) return onRedisErrored();
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
}

describe("assertRedisFailClosed", () => {
  let limiter: { check: Mock };
  let limiterFactory: Mock;
  let mutationSpy: Mock;

  beforeEach(() => {
    limiterFactory = makeLimiterFactory();
    limiter = limiterFactory({ windowMs: 1000, max: 1, failClosedOnRedisError: true }) as {
      check: Mock;
    };
    mutationSpy = vi.fn();
  });

  it("case 1: passing invocation against a minimal fake route succeeds", async () => {
    await expect(
      assertRedisFailClosed({
        invoke: fakeRoute(limiter),
        limiter,
        expectation: { envelope: "canonical" },
        assertNoMutation: [mutationSpy],
        limiterFactory,
        failure: { allowed: false, redisErrored: true },
      }),
    ).resolves.toBeUndefined();
  });

  it("case 2: handler returns wrong status/body — rejects", async () => {
    await expect(
      assertRedisFailClosed({
        invoke: fakeRoute(
          limiter,
          () =>
            new Response(JSON.stringify({ error: "INTERNAL_ERROR" }), {
              status: 500,
              headers: { "Retry-After": "30" },
            }),
        ),
        limiter,
        expectation: { envelope: "canonical" },
        assertNoMutation: [mutationSpy],
        limiterFactory,
        failure: { allowed: false, redisErrored: true },
      }),
    ).rejects.toThrow();
  });

  it("case 3: a mutation spy was called — rejects", async () => {
    mutationSpy();
    await expect(
      assertRedisFailClosed({
        invoke: fakeRoute(limiter),
        limiter,
        expectation: { envelope: "canonical" },
        assertNoMutation: [mutationSpy],
        limiterFactory,
        failure: { allowed: false, redisErrored: true },
      }),
    ).rejects.toThrow();
  });

  it("case 4: empty assertNoMutation array — rejects", async () => {
    await expect(
      assertRedisFailClosed({
        invoke: async () => canonicalResponse(),
        limiter,
        expectation: { envelope: "canonical" },
        assertNoMutation: [],
        limiterFactory,
        failure: { allowed: false, redisErrored: true },
      }),
    ).rejects.toThrow("assertNoMutation must be non-empty");
  });

  it("case 5: sibling-masking — a DIFFERENT factory call has the flag, attribution still rejects", async () => {
    // The limiter under test is constructed WITHOUT failClosedOnRedisError...
    const limiterUnderTest = limiterFactory({ windowMs: 1000, max: 1 }) as {
      check: Mock;
    };
    // ...but a sibling limiter from the SAME factory mock DOES have the flag.
    // An existential (any-call) check would incorrectly pass here; attribution
    // must key on which call produced `limiterUnderTest` specifically.
    limiterFactory({ windowMs: 1000, max: 1, failClosedOnRedisError: true });

    await expect(
      assertRedisFailClosed({
        invoke: fakeRoute(limiterUnderTest),
        limiter: limiterUnderTest,
        expectation: { envelope: "canonical" },
        assertNoMutation: [mutationSpy],
        limiterFactory,
        failure: { allowed: false, redisErrored: true },
      }),
    ).rejects.toThrow();
  });

  it("case 6: limiter never reached — rejects", async () => {
    // The limiter under test IS registered with the factory (the standard
    // beforeEach pair), but invoke() returns a fully-correct canonical 503
    // (right body + numeric Retry-After) WITHOUT ever calling
    // limiter.check() — as if the route's own short-circuit (e.g. a bug
    // that returns the envelope from a cache or a sibling limiter) produced
    // the right-looking response without consulting the limiter under test.
    // This isolates step 3 (`expect(limiter.check).toHaveBeenCalled()`) as
    // the ONLY failing axis: envelope, mutation, and factory-attribution
    // checks would all pass if reached.
    await expect(
      assertRedisFailClosed({
        invoke: async () => canonicalResponse(),
        limiter,
        expectation: { envelope: "canonical" },
        assertNoMutation: [mutationSpy],
        limiterFactory,
        failure: { allowed: false, redisErrored: true },
      }),
    ).rejects.toThrow();
  });

  it("case 7: correct status/body but Retry-After absent — rejects (Retry-After red-proof)", async () => {
    await expect(
      assertRedisFailClosed({
        invoke: fakeRoute(
          limiter,
          () =>
            new Response(JSON.stringify({ error: "SERVICE_UNAVAILABLE" }), {
              status: 503,
              // No Retry-After header.
            }),
        ),
        limiter,
        expectation: { envelope: "canonical" },
        assertNoMutation: [mutationSpy],
        limiterFactory,
        failure: { allowed: false, redisErrored: true },
      }),
    ).rejects.toThrow();
  });

  // Number() coercion would accept "" (→ 0), negatives, and decimals — the
  // helper must reject every non-delay-seconds shape, not just NaN inputs.
  // "0" is well-formed per RFC 9110 but rejected: a 0-second retry hint
  // during an outage invites a client stampede (production default is 30s).
  it.each([
    ["non-numeric", "not-a-number"],
    ["empty string", ""],
    ["negative", "-1"],
    ["decimal", "1.5"],
    ["zero", "0"],
  ])("case 7b: correct status/body but Retry-After %s — rejects", async (_label, value) => {
    await expect(
      assertRedisFailClosed({
        invoke: fakeRoute(
          limiter,
          () =>
            new Response(JSON.stringify({ error: "SERVICE_UNAVAILABLE" }), {
              status: 503,
              headers: { "Retry-After": value },
            }),
        ),
        limiter,
        expectation: { envelope: "canonical" },
        assertNoMutation: [mutationSpy],
        limiterFactory,
        failure: { allowed: false, redisErrored: true },
      }),
    ).rejects.toThrow();
  });

  // Custom-envelope Retry-After policy is explicit (required/forbidden/ignore)
  // so bespoke consumers cannot silently skip the header contract.
  const CUSTOM_BODY = { authorized: false, reason: "service_unavailable" };

  it("case 8: custom envelope with retryAfter required — passes when header is valid", async () => {
    await assertRedisFailClosed({
      invoke: fakeRoute(
        limiter,
        () =>
          new Response(JSON.stringify(CUSTOM_BODY), {
            status: 503,
            headers: { "Retry-After": "30" },
          }),
      ),
      limiter,
      expectation: { envelope: "custom", status: 503, body: CUSTOM_BODY, retryAfter: "required" },
      assertNoMutation: [mutationSpy],
      limiterFactory,
      failure: { allowed: false, redisErrored: true },
    });
  });

  it("case 8b: custom envelope with retryAfter required — rejects when header is absent", async () => {
    await expect(
      assertRedisFailClosed({
        invoke: fakeRoute(
          limiter,
          () => new Response(JSON.stringify(CUSTOM_BODY), { status: 503 }),
        ),
        limiter,
        expectation: { envelope: "custom", status: 503, body: CUSTOM_BODY, retryAfter: "required" },
        assertNoMutation: [mutationSpy],
        limiterFactory,
        failure: { allowed: false, redisErrored: true },
      }),
    ).rejects.toThrow();
  });

  it("case 8c: custom envelope with retryAfter forbidden — rejects when header is present", async () => {
    await expect(
      assertRedisFailClosed({
        invoke: fakeRoute(
          limiter,
          () =>
            new Response(JSON.stringify(CUSTOM_BODY), {
              status: 503,
              headers: { "Retry-After": "30" },
            }),
        ),
        limiter,
        expectation: { envelope: "custom", status: 503, body: CUSTOM_BODY, retryAfter: "forbidden" },
        assertNoMutation: [mutationSpy],
        limiterFactory,
        failure: { allowed: false, redisErrored: true },
      }),
    ).rejects.toThrow();
  });
});

describe("snapshotFactory", () => {
  // Simulates the module-load-time factory invocation the 6 vault route
  // test files perform, followed by a `beforeEach`-style `vi.clearAllMocks()`
  // that would otherwise wipe `mock.calls`/`mock.results` before the test body
  // runs.
  const moduleFactory = vi.fn((opts: unknown) => ({ check: vi.fn(), opts }));
  const limiterA = moduleFactory({ failClosedOnRedisError: true, tag: "A" });
  const limiterB = moduleFactory({ failClosedOnRedisError: false, tag: "B" });
  const record = snapshotFactory(moduleFactory);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("replay() reconstructs calls/results after clearAllMocks wiped the original mock", () => {
    expect(moduleFactory.mock.calls.length).toBe(0);

    const replayed = record.replay();
    expect(replayed.mock.calls.length).toBe(2);
    expect(replayed.mock.results.map((r) => r.value)).toEqual([limiterA, limiterB]);
    expect(replayed.mock.calls[0]?.[0]).toEqual({ failClosedOnRedisError: true, tag: "A" });
  });

  it("attribution via assertRedisFailClosed works against the replayed factory", async () => {
    const replayed = record.replay();
    const mutationSpy = vi.fn();
    await expect(
      assertRedisFailClosed({
        invoke: fakeRoute(limiterA as { check: Mock }),
        limiter: limiterA as { check: Mock },
        expectation: { envelope: "canonical" },
        assertNoMutation: [mutationSpy],
        limiterFactory: replayed,
        failure: { allowed: false, redisErrored: true },
      }),
    ).resolves.toBeUndefined();
  });
});
