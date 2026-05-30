import { describe, it, expect, vi } from "vitest";

// S5: when Redis IS configured but the SET errors, the cache must fail CLOSED
// (treat as a replay → reject) rather than degrade to the per-process memory
// map, which would allow one replay per instance during a Redis outage.
const setMock = vi.fn(async () => {
  throw new Error("ECONNREFUSED");
});

vi.mock("@/lib/redis", () => ({
  getRedis: () => ({ set: setMock }),
}));

describe("createJtiCache — Redis configured but erroring (fail closed)", () => {
  it("returns true (reject) when redis.set throws", async () => {
    const { createJtiCache } = await import("./jti-cache");
    const cache = createJtiCache();
    const result = await cache.hasOrRecord("jkt-A", "jti-1");
    expect(setMock).toHaveBeenCalled();
    expect(result).toBe(true);
  });
});
