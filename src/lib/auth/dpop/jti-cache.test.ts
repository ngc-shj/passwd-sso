import { describe, it, expect, vi, beforeEach } from "vitest";
import { createJtiCache, DPOP_DEFAULT_JTI_TTL_MS } from "./jti-cache";
import { DPOP_DEFAULT_SKEW_SECONDS } from "./verify";

// Force the in-memory fallback path: getRedis() returns null when
// REDIS_URL is unset. setup.ts does not set it, but make it explicit
// so this file is self-contained.
vi.mock("@/lib/redis", () => ({
  getRedis: () => null,
}));

beforeEach(() => {
  delete process.env.REDIS_URL;
});

describe("createJtiCache (in-memory fallback)", () => {
  it("first sight: returns false and persists", async () => {
    const cache = createJtiCache();
    const seen = await cache.hasOrRecord("jkt-A", "jti-1");
    expect(seen).toBe(false);
  });

  it("second sight within TTL: returns true (replay)", async () => {
    const cache = createJtiCache();
    await cache.hasOrRecord("jkt-A", "jti-1");
    const replay = await cache.hasOrRecord("jkt-A", "jti-1");
    expect(replay).toBe(true);
  });

  it("after TTL expires: returns false (re-persists)", async () => {
    let fakeNow = 1_000_000;
    const cache = createJtiCache({ ttlMs: 1_000, now: () => fakeNow });
    expect(await cache.hasOrRecord("jkt-A", "jti-1")).toBe(false);

    fakeNow += 500; // still within TTL
    expect(await cache.hasOrRecord("jkt-A", "jti-1")).toBe(true);

    fakeNow += 600; // total 1100ms > 1000ms TTL → expired
    const reseen = await cache.hasOrRecord("jkt-A", "jti-1");
    expect(reseen).toBe(false);

    // And the freshly-persisted entry blocks immediate replay again.
    expect(await cache.hasOrRecord("jkt-A", "jti-1")).toBe(true);
  });

  it("different jkts share keyspace cleanly: same jti under different jkt is independent", async () => {
    const cache = createJtiCache();
    expect(await cache.hasOrRecord("jkt-A", "jti-shared")).toBe(false);
    expect(await cache.hasOrRecord("jkt-B", "jti-shared")).toBe(false);
    // And each is independently rejected on replay.
    expect(await cache.hasOrRecord("jkt-A", "jti-shared")).toBe(true);
    expect(await cache.hasOrRecord("jkt-B", "jti-shared")).toBe(true);
  });

  it("different jtis under the same jkt are independent", async () => {
    const cache = createJtiCache();
    expect(await cache.hasOrRecord("jkt-A", "jti-1")).toBe(false);
    expect(await cache.hasOrRecord("jkt-A", "jti-2")).toBe(false);
    expect(await cache.hasOrRecord("jkt-A", "jti-1")).toBe(true);
    expect(await cache.hasOrRecord("jkt-A", "jti-2")).toBe(true);
  });
});

describe("createJtiCache - separate instances do not cross-pollute", () => {
  it("two cache instances each enforce their own state", async () => {
    const a = createJtiCache();
    const b = createJtiCache();
    expect(await a.hasOrRecord("jkt", "jti-x")).toBe(false);
    // b has never seen this pair.
    expect(await b.hasOrRecord("jkt", "jti-x")).toBe(false);
    // Each independently rejects on second sight.
    expect(await a.hasOrRecord("jkt", "jti-x")).toBe(true);
    expect(await b.hasOrRecord("jkt", "jti-x")).toBe(true);
  });
});

// M4 invariant — the jti cache TTL must fully cover the iat skew window.
// The iat check accepts |now - iat| ≤ skew, so a single proof is acceptable
// for 2 × skew seconds; the jti cache must outlive that or a captured proof
// can be replayed after the cache expires but while iat is still in range.
// A runtime check at module load would be dead-code per CodeQL because both
// constants are literals — this test is the guardrail that survives the
// static analyzer.
describe("DPoP jti-cache TTL invariant (M4)", () => {
  it("DPOP_DEFAULT_JTI_TTL_MS >= 2 × DPOP_DEFAULT_SKEW_SECONDS so the cache outlives the iat window", () => {
    expect(DPOP_DEFAULT_JTI_TTL_MS).toBeGreaterThanOrEqual(
      DPOP_DEFAULT_SKEW_SECONDS * 2 * 1000,
    );
  });
});
