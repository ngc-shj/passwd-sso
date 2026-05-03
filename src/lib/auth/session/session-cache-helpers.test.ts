import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockInvalidate } = vi.hoisted(() => ({
  mockInvalidate: vi.fn<(token: string) => Promise<void>>(),
}));

vi.mock("@/lib/auth/session/session-cache", () => ({
  invalidateCachedSession: mockInvalidate,
}));

import { invalidateCachedSessions } from "./session-cache-helpers";

beforeEach(() => {
  mockInvalidate.mockReset();
  mockInvalidate.mockResolvedValue(undefined);
});

describe("invalidateCachedSessions", () => {
  it("returns immediately without calling invalidator on empty input", async () => {
    await invalidateCachedSessions([]);
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it("invokes invalidateCachedSession exactly once per token", async () => {
    await invalidateCachedSessions(["t1", "t2", "t3"]);
    expect(mockInvalidate).toHaveBeenCalledTimes(3);
    expect(mockInvalidate).toHaveBeenNthCalledWith(1, "t1");
    expect(mockInvalidate).toHaveBeenNthCalledWith(2, "t2");
    expect(mockInvalidate).toHaveBeenNthCalledWith(3, "t3");
  });

  it("invokes calls in parallel via Promise.all (does not serialize)", async () => {
    let resolveFirst!: () => void;
    const firstStarted = new Promise<void>((res) => (resolveFirst = res));
    const secondCalled = vi.fn();

    mockInvalidate.mockImplementationOnce(() => {
      // First call hangs until the test resolves it; if Promise.all serialized,
      // the second call would never start before we resolve.
      return new Promise<void>((res) => {
        resolveFirst = () => {
          res();
        };
        // Signal that the first invocation has begun.
        Promise.resolve().then(() => firstStarted);
      });
    });
    mockInvalidate.mockImplementationOnce(async () => {
      secondCalled();
    });

    const promise = invalidateCachedSessions(["t1", "t2"]);
    // Yield once so the parallel dispatch has a chance to fire t2.
    await Promise.resolve();
    await Promise.resolve();
    expect(secondCalled).toHaveBeenCalledTimes(1);

    resolveFirst();
    await promise;
    expect(mockInvalidate).toHaveBeenCalledTimes(2);
  });

  it("handles a single-token list (1-N edge)", async () => {
    await invalidateCachedSessions(["only"]);
    expect(mockInvalidate).toHaveBeenCalledExactlyOnceWith("only");
  });

  it("propagates rejections from the underlying invalidator (caller-aware)", async () => {
    // invalidateCachedSession is documented as best-effort and never throws,
    // but the helper itself uses Promise.all — so if a rejection were ever to
    // surface, callers must see it. This regression-locks that contract.
    mockInvalidate.mockRejectedValueOnce(new Error("redis-down"));
    mockInvalidate.mockResolvedValueOnce(undefined);
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
