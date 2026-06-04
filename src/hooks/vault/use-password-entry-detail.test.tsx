// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { usePasswordEntryDetail } from "./use-password-entry-detail";
import type { InlineDetailData } from "@/types/entry";
import { VAULT_STATUS } from "@/lib/constants";
import type { VaultStatus } from "@/lib/constants";

// Minimal valid InlineDetailData for tests
function makeDetail(id: string, overrides: Partial<InlineDetailData> = {}): InlineDetailData {
  return {
    id,
    entryType: "LOGIN",
    password: "secret",
    url: null,
    urlHost: null,
    notes: null,
    customFields: [],
    passwordHistory: [],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

// A deferred promise factory — resolve/reject are callable from outside
function makeDeferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const UNLOCKED: VaultStatus = VAULT_STATUS.UNLOCKED;
const LOCKED: VaultStatus = VAULT_STATUS.LOCKED;

describe("usePasswordEntryDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── basic fetch ─────────────────────────────────────────────────

  it("detailData is null before getDetail resolves", async () => {
    const deferred = makeDeferred<InlineDetailData>();
    const getDetail = vi.fn(() => deferred.promise);

    const { result } = renderHook(() =>
      usePasswordEntryDetail("entry-1", { getDetail, vaultStatus: UNLOCKED }),
    );

    // Precondition: loading started, data not yet here
    expect(result.current.loading).toBe(true);
    expect(result.current.detailData).toBeNull();

    // Resolve the fetch
    act(() => deferred.resolve(makeDetail("entry-1")));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.detailData).toEqual(makeDetail("entry-1"));
    expect(result.current.error).toBeNull();
  });

  it("detailData equals the resolved getDetail output", async () => {
    const expected = makeDetail("entry-1", { password: "hunter2", notes: "test notes" });
    const getDetail = vi.fn().mockResolvedValue(expected);

    const { result } = renderHook(() =>
      usePasswordEntryDetail("entry-1", { getDetail, vaultStatus: UNLOCKED }),
    );

    await waitFor(() => expect(result.current.detailData).not.toBeNull());
    expect(result.current.detailData).toEqual(expected);
  });

  // ─── INV-C1.1: clear on entryId switch ───────────────────────────

  it("INV-C1.1: switching entryId nulls previous detailData before new resolves", async () => {
    const deferredA = makeDeferred<InlineDetailData>();
    const deferredB = makeDeferred<InlineDetailData>();
    let callCount = 0;
    const getDetail = vi.fn((id: string) => {
      callCount++;
      return callCount === 1 ? deferredA.promise : deferredB.promise;
    });

    const { result, rerender } = renderHook(
      ({ id }) => usePasswordEntryDetail(id, { getDetail, vaultStatus: UNLOCKED }),
      { initialProps: { id: "entry-A" as string } },
    );

    // Resolve entry-A fetch
    act(() => deferredA.resolve(makeDetail("entry-A")));
    await waitFor(() => expect(result.current.detailData?.id).toBe("entry-A"));

    // Precondition: A is loaded
    expect(result.current.detailData).not.toBeNull();

    // Switch to entry-B — detailData must be null before B resolves
    rerender({ id: "entry-B" });
    expect(result.current.detailData).toBeNull(); // cleared synchronously

    // B is still pending — still null
    expect(result.current.loading).toBe(true);

    // Now resolve B
    act(() => deferredB.resolve(makeDetail("entry-B")));
    await waitFor(() => expect(result.current.detailData?.id).toBe("entry-B"));
  });

  // ─── INV-C1.4: cancel-flag race ──────────────────────────────────

  it("INV-C1.4: stale A-fetch resolving after B is selected does not overwrite B", async () => {
    const deferredA = makeDeferred<InlineDetailData>();
    const deferredB = makeDeferred<InlineDetailData>();
    let callCount = 0;
    const getDetail = vi.fn((id: string) => {
      callCount++;
      return callCount === 1 ? deferredA.promise : deferredB.promise;
    });

    const { result, rerender } = renderHook(
      ({ id }) => usePasswordEntryDetail(id, { getDetail, vaultStatus: UNLOCKED }),
      { initialProps: { id: "entry-A" as string } },
    );

    // Select B while A's fetch is still pending
    rerender({ id: "entry-B" });

    // Resolve B first
    act(() => deferredB.resolve(makeDetail("entry-B")));
    await waitFor(() => expect(result.current.detailData?.id).toBe("entry-B"));

    // Now resolve the STALE A fetch — must NOT overwrite B
    // This is the key assertion: deleting the cancel guard would flip this red
    act(() => deferredA.resolve(makeDetail("entry-A")));

    // Give React a tick to process any pending state updates
    await new Promise((r) => setTimeout(r, 0));

    // B must still be resident — stale A was discarded
    expect(result.current.detailData?.id).toBe("entry-B");
  });

  // ─── INV-C1.3: clear on vault status leaving UNLOCKED ────────────

  it("INV-C1.3: detailData cleared when vaultStatus transitions from UNLOCKED to LOCKED", async () => {
    const getDetail = vi.fn().mockResolvedValue(makeDetail("entry-1"));

    const { result, rerender } = renderHook(
      ({ status }: { status: VaultStatus }) =>
        usePasswordEntryDetail("entry-1", { getDetail, vaultStatus: status }),
      { initialProps: { status: UNLOCKED as VaultStatus } },
    );

    // Precondition: data is loaded
    await waitFor(() => expect(result.current.detailData).not.toBeNull());

    // Trigger: force vault to LOCKED
    rerender({ status: LOCKED });

    // Assert: detailData is cleared
    expect(result.current.detailData).toBeNull();
  });

  it("INV-C1.3: clear-on-lock uses a state transition, no fake timers needed", async () => {
    const getDetail = vi.fn().mockResolvedValue(makeDetail("entry-1"));
    const { result, rerender } = renderHook(
      ({ status }: { status: VaultStatus }) =>
        usePasswordEntryDetail("entry-1", { getDetail, vaultStatus: status }),
      { initialProps: { status: UNLOCKED as VaultStatus } },
    );

    await waitFor(() => expect(result.current.detailData).not.toBeNull());

    act(() => rerender({ status: VAULT_STATUS.SETUP_REQUIRED }));
    expect(result.current.detailData).toBeNull();
  });

  // ─── invalidate() ────────────────────────────────────────────────

  it("invalidate() triggers a second getDetail call", async () => {
    const detail = makeDetail("entry-1");
    const getDetail = vi.fn().mockResolvedValue(detail);

    const { result } = renderHook(() =>
      usePasswordEntryDetail("entry-1", { getDetail, vaultStatus: UNLOCKED }),
    );

    await waitFor(() => expect(result.current.detailData).not.toBeNull());
    expect(getDetail).toHaveBeenCalledTimes(1);

    // invalidate should trigger a re-fetch
    act(() => result.current.invalidate());
    await waitFor(() => expect(getDetail).toHaveBeenCalledTimes(2));
  });

  it("invalidate() sets detailData to null before the re-fetch resolves", async () => {
    const deferred = makeDeferred<InlineDetailData>();
    let callCount = 0;
    const getDetail = vi.fn((id: string) => {
      callCount++;
      if (callCount === 1) return Promise.resolve(makeDetail(id));
      return deferred.promise; // second call is deferred
    });

    const { result } = renderHook(() =>
      usePasswordEntryDetail("entry-1", { getDetail, vaultStatus: UNLOCKED }),
    );

    await waitFor(() => expect(result.current.detailData).not.toBeNull());

    // Invalidate — detailData should go null before deferred resolves
    act(() => result.current.invalidate());
    expect(result.current.detailData).toBeNull();

    // Resolve the second fetch
    act(() => deferred.resolve(makeDetail("entry-1", { notes: "refreshed" })));
    await waitFor(() => expect(result.current.detailData?.notes).toBe("refreshed"));
  });

  // ─── entryId = null ───────────────────────────────────────────────

  it("does not call getDetail when entryId is null", () => {
    const getDetail = vi.fn();

    renderHook(() =>
      usePasswordEntryDetail(null, { getDetail, vaultStatus: UNLOCKED }),
    );

    expect(getDetail).not.toHaveBeenCalled();
  });

  it("detailData is null and loading is false when entryId is null", () => {
    const getDetail = vi.fn();
    const { result } = renderHook(() =>
      usePasswordEntryDetail(null, { getDetail, vaultStatus: UNLOCKED }),
    );

    expect(result.current.detailData).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  // ─── error handling ───────────────────────────────────────────────

  it("captures rejection into error state", async () => {
    const err = new Error("vault locked");
    const getDetail = vi.fn().mockRejectedValue(err);

    const { result } = renderHook(() =>
      usePasswordEntryDetail("entry-1", { getDetail, vaultStatus: UNLOCKED }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe("vault locked");
    expect(result.current.detailData).toBeNull();
  });

  it("wraps non-Error rejection into an Error", async () => {
    const getDetail = vi.fn().mockRejectedValue("string error");

    const { result } = renderHook(() =>
      usePasswordEntryDetail("entry-1", { getDetail, vaultStatus: UNLOCKED }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeInstanceOf(Error);
  });

  // ─── vault locked before fetch ────────────────────────────────────

  it("does not call getDetail when vault is not UNLOCKED", () => {
    const getDetail = vi.fn();

    renderHook(() =>
      usePasswordEntryDetail("entry-1", { getDetail, vaultStatus: LOCKED }),
    );

    expect(getDetail).not.toHaveBeenCalled();
  });
});
