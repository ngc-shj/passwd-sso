import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockInvalidate } = vi.hoisted(() => ({
  mockInvalidate: vi.fn<(token: string) => Promise<boolean>>(),
}));

vi.mock("@/lib/auth/session/session-cache", () => ({
  invalidateCachedSession: mockInvalidate,
}));

import { invalidateCachedSessions } from "./session-cache-helpers";

beforeEach(() => {
  mockInvalidate.mockReset();
  mockInvalidate.mockResolvedValue(true);
});

describe("invalidateCachedSessions", () => {
  it("returns {total:0,failed:0} immediately without calling invalidator on empty input", async () => {
    await expect(invalidateCachedSessions([])).resolves.toEqual({
      total: 0,
      failed: 0,
    });
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it("invokes invalidateCachedSession exactly once per token and returns {total:N,failed:0} on all success", async () => {
    await expect(invalidateCachedSessions(["t1", "t2", "t3"])).resolves.toEqual(
      { total: 3, failed: 0 },
    );
    expect(mockInvalidate).toHaveBeenCalledTimes(3);
    expect(mockInvalidate).toHaveBeenNthCalledWith(1, "t1");
    expect(mockInvalidate).toHaveBeenNthCalledWith(2, "t2");
    expect(mockInvalidate).toHaveBeenNthCalledWith(3, "t3");
  });

  it("invokes calls in parallel via Promise.all (does not serialize)", async () => {
    let resolveFirst!: (v: boolean) => void;
    const firstStarted = new Promise<void>((res) => {
      void res;
    });
    const secondCalled = vi.fn();

    mockInvalidate.mockImplementationOnce(() => {
      // First call hangs until the test resolves it; if Promise.all serialized,
      // the second call would never start before we resolve.
      return new Promise<boolean>((res) => {
        resolveFirst = res;
        Promise.resolve().then(() => firstStarted);
      });
    });
    mockInvalidate.mockImplementationOnce(async () => {
      secondCalled();
      return true;
    });

    const promise = invalidateCachedSessions(["t1", "t2"]);
    // Yield once so the parallel dispatch has a chance to fire t2.
    await Promise.resolve();
    await Promise.resolve();
    expect(secondCalled).toHaveBeenCalledTimes(1);

    resolveFirst(true);
    await promise;
    expect(mockInvalidate).toHaveBeenCalledTimes(2);
  });

  it("handles a single-token list (1-N edge)", async () => {
    await expect(invalidateCachedSessions(["only"])).resolves.toEqual({
      total: 1,
      failed: 0,
    });
    expect(mockInvalidate).toHaveBeenCalledExactlyOnceWith("only");
  });

  it(
    "counts per-token false returns as failures so callers can audit a " +
      "partial Redis outage",
    async () => {
      mockInvalidate.mockResolvedValueOnce(true);
      mockInvalidate.mockResolvedValueOnce(false);
      mockInvalidate.mockResolvedValueOnce(true);
      mockInvalidate.mockResolvedValueOnce(false);

      await expect(
        invalidateCachedSessions(["t1", "t2", "t3", "t4"]),
      ).resolves.toEqual({ total: 4, failed: 2 });
    },
  );

  it("propagates rejections from the underlying invalidator (caller-aware)", async () => {
    // invalidateCachedSession is documented as best-effort and never throws,
    // but the helper itself uses Promise.all — so if a rejection were ever to
    // surface, callers must see it. This regression-locks that contract.
    mockInvalidate.mockRejectedValueOnce(new Error("redis-down"));
    mockInvalidate.mockResolvedValueOnce(true);
    await expect(invalidateCachedSessions(["t1", "t2"])).rejects.toThrow("redis-down");
  });

  it("preserves token order in invocation when caller passes a frozen array", async () => {
    const tokens = Object.freeze(["a", "b", "c"]);
    await invalidateCachedSessions(tokens);
    expect(mockInvalidate.mock.calls.map((c) => c[0])).toEqual(["a", "b", "c"]);
  });

  it("does not leak cross-tenant tokens — each token is passed verbatim with no rewriting", async () => {
    // Cross-tenant safety: the helper must not rewrite/normalize tokens that
    // belong to different tenants. Tenant boundary is enforced upstream;
    // the helper's contract is "invalidate exactly the tokens given".
    const tokens = ["tenant-a-session-1", "tenant-b-session-1"];
    await invalidateCachedSessions(tokens);
    expect(mockInvalidate).toHaveBeenCalledWith("tenant-a-session-1");
    expect(mockInvalidate).toHaveBeenCalledWith("tenant-b-session-1");
    expect(mockInvalidate).toHaveBeenCalledTimes(2);
  });
});
