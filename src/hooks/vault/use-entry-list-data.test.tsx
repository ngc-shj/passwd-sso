// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useEntryListData } from "./use-entry-list-data";
import type { VaultListAdapter } from "@/lib/vault/vault-list-adapter";
import type { PasswordRowEntry } from "@/components/passwords/detail/password-row";
import type { PasswordDetailPaneEntry } from "@/components/passwords/detail/password-detail-pane";

// ── Test entry type ────────────────────────────────────────────────────────────

type TestEntry = PasswordRowEntry &
  PasswordDetailPaneEntry & {
    isFavorite: boolean;
    isArchived: boolean;
    requireReprompt: boolean;
    expiresAt: string | null;
    createdAt: string;
    updatedAt: string;
    deletedAt?: string;
    travelSafe?: boolean;
  };

// ── Factories ──────────────────────────────────────────────────────────────────

function makeEntry(id: string, overrides: Partial<TestEntry> = {}): TestEntry {
  return {
    id,
    entryType: "LOGIN",
    title: `Entry ${id}`,
    username: `user${id}@example.com`,
    urlHost: `example.com`,
    snippet: null,
    brand: null,
    lastFour: null,
    cardholderName: null,
    fullName: null,
    idNumberLast4: null,
    relyingPartyId: null,
    bankName: null,
    accountNumberLast4: null,
    softwareName: null,
    licensee: null,
    keyType: null,
    fingerprint: null,
    tags: [],
    isFavorite: false,
    isArchived: false,
    requireReprompt: false,
    expiresAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    ...overrides,
  };
}

function makeReadyAdapter(
  fetchOverviewEntries: VaultListAdapter<TestEntry>["fetchOverviewEntries"],
): VaultListAdapter<TestEntry> {
  return {
    kind: "personal",
    availability: { ready: true },
    permissions: { canCreate: true, canEdit: true, canDelete: true, canShare: true },
    supportsFavorite: true,
    fetchOverviewEntries,
    buildGetDetail: () => async () => ({ password: "pw" }) as never,
    setFavorite: async () => {},
    setArchived: async () => {},
    softDelete: async () => {},
    restore: async () => {},
    deletePermanently: async () => {},
    emptyTrash: async () => {},
    notifyDataChanged: () => {},
    bulkScope: () => ({ type: "personal" }),
  };
}

// Default args for the hook — callers override only what they need.
const DEFAULT_ARGS = {
  view: "normal" as const,
  query: { tagId: null, folderId: null, entryType: null },
  searchQuery: "",
  sortBy: "updatedAt" as const,
  refreshKey: 0,
  sort: "favoriteThenUpdated" as const,
};

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("useEntryListData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Loading state ────────────────────────────────────────────────────────────

  it("starts with loading=true when adapter is ready", () => {
    // fetchOverviewEntries never resolves in this test — we just check initial state.
    const fetch = vi.fn(() => new Promise<TestEntry[]>(() => {}));
    const adapter = makeReadyAdapter(fetch);

    const { result } = renderHook(() =>
      useEntryListData({ ...DEFAULT_ARGS, adapter }),
    );

    expect(result.current.loading).toBe(true);
    expect(result.current.entries).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it("transitions loading false→true→false across a fetch cycle", async () => {
    let resolve!: (entries: TestEntry[]) => void;
    const deferred = new Promise<TestEntry[]>((r) => { resolve = r; });
    const fetch = vi.fn(() => deferred);
    const adapter = makeReadyAdapter(fetch);

    const { result } = renderHook(() =>
      useEntryListData({ ...DEFAULT_ARGS, adapter }),
    );

    // Initial: loading is true while fetch is in flight.
    expect(result.current.loading).toBe(true);

    // Settle the deferred promise.
    await act(async () => { resolve([makeEntry("e1")]); });

    expect(result.current.loading).toBe(false);
    expect(result.current.entries).toHaveLength(1);
  });

  // ── Happy path ───────────────────────────────────────────────────────────────

  it("exposes fetched entries after adapter resolves", async () => {
    const entries = [makeEntry("e1"), makeEntry("e2")];
    const fetch = vi.fn().mockResolvedValueOnce(entries);
    const adapter = makeReadyAdapter(fetch);

    const { result } = renderHook(() =>
      useEntryListData({ ...DEFAULT_ARGS, adapter }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.entries).toHaveLength(2);
    expect(result.current.entries[0].id).toBe("e1");
    expect(result.current.entries[1].id).toBe("e2");
    expect(result.current.error).toBeNull();
  });

  it("passes view, query, and an AbortSignal to fetchOverviewEntries", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce([]);
    const adapter = makeReadyAdapter(fetchFn);
    const query = { tagId: "tag-1", folderId: null, entryType: null };

    const { result } = renderHook(() =>
      useEntryListData({ ...DEFAULT_ARGS, adapter, view: "tag", query }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(fetchFn).toHaveBeenCalledOnce();
    const [viewArg, queryArg, signalArg] = fetchFn.mock.calls[0];
    expect(viewArg).toBe("tag");
    expect(queryArg).toMatchObject({ tagId: "tag-1" });
    expect(signalArg).toBeInstanceOf(AbortSignal);
  });

  // ── Empty result ─────────────────────────────────────────────────────────────

  it("returns empty entries array when adapter resolves with empty list", async () => {
    const fetch = vi.fn().mockResolvedValueOnce([]);
    const adapter = makeReadyAdapter(fetch);

    const { result } = renderHook(() =>
      useEntryListData({ ...DEFAULT_ARGS, adapter }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.entries).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  // ── Adapter not ready (INV-C4.3) ────────────────────────────────────────────

  it("skips fetch and sets loading=false when adapter is not ready", async () => {
    const fetchFn = vi.fn();
    const adapter: VaultListAdapter<TestEntry> = {
      ...makeReadyAdapter(fetchFn),
      availability: { ready: false, reason: "locked" },
    };

    const { result } = renderHook(() =>
      useEntryListData({ ...DEFAULT_ARGS, adapter }),
    );

    // No async wait needed: the effect synchronously sets loading=false.
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.current.entries).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  // ── Error path ───────────────────────────────────────────────────────────────

  it("sets error when fetchOverviewEntries rejects (Error instance)", async () => {
    const err = new Error("Network failure");
    const fetch = vi.fn().mockRejectedValueOnce(err);
    const adapter = makeReadyAdapter(fetch);

    const { result } = renderHook(() =>
      useEntryListData({ ...DEFAULT_ARGS, adapter }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe(err);
    expect(result.current.entries).toEqual([]);
  });

  it("wraps non-Error rejection in an Error", async () => {
    const fetch = vi.fn().mockRejectedValueOnce("plain string error");
    const adapter = makeReadyAdapter(fetch);

    const { result } = renderHook(() =>
      useEntryListData({ ...DEFAULT_ARGS, adapter }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe("plain string error");
  });

  // ── Search filter (INV-C4.2) ─────────────────────────────────────────────────

  it("filters entries by title without re-fetching", async () => {
    const entries = [
      makeEntry("e1", { title: "GitHub" }),
      makeEntry("e2", { title: "Google" }),
    ];
    const fetchFn = vi.fn().mockResolvedValueOnce(entries);
    const adapter = makeReadyAdapter(fetchFn);

    const { result, rerender } = renderHook(
      ({ searchQuery }) =>
        useEntryListData({ ...DEFAULT_ARGS, adapter, searchQuery }),
      { initialProps: { searchQuery: "" } },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.entries).toHaveLength(2);

    // Change searchQuery without re-fetching.
    rerender({ searchQuery: "git" });

    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0].title).toBe("GitHub");
    // fetchFn called only once — no re-fetch on searchQuery change (INV-C4.2).
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("filters entries by username", async () => {
    const entries = [
      makeEntry("e1", { title: "Site A", username: "alice@example.com" }),
      makeEntry("e2", { title: "Site B", username: "bob@example.com" }),
    ];
    const fetch = vi.fn().mockResolvedValueOnce(entries);
    const adapter = makeReadyAdapter(fetch);

    const { result, rerender } = renderHook(
      ({ searchQuery }) =>
        useEntryListData({ ...DEFAULT_ARGS, adapter, searchQuery }),
      { initialProps: { searchQuery: "" } },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    rerender({ searchQuery: "alice" });

    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0].username).toBe("alice@example.com");
  });

  // ── Sort: favoriteThenUpdated ─────────────────────────────────────────────────

  it("sorts favorites before non-favorites when sort=favoriteThenUpdated", async () => {
    const entries = [
      makeEntry("e1", { title: "B", isFavorite: false, updatedAt: "2026-01-02T00:00:00Z" }),
      makeEntry("e2", { title: "A", isFavorite: true, updatedAt: "2026-01-01T00:00:00Z" }),
    ];
    const fetch = vi.fn().mockResolvedValueOnce(entries);
    const adapter = makeReadyAdapter(fetch);

    const { result } = renderHook(() =>
      useEntryListData({ ...DEFAULT_ARGS, adapter, sort: "favoriteThenUpdated" }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.entries[0].id).toBe("e2"); // favorite first
    expect(result.current.entries[1].id).toBe("e1");
  });

  // ── Sort: deletedAt ──────────────────────────────────────────────────────────

  it("sorts entries by deletedAt when sort=deletedAt", async () => {
    const entries = [
      makeEntry("e1", { title: "Old", deletedAt: "2026-01-01T00:00:00Z" }),
      makeEntry("e2", { title: "New", deletedAt: "2026-03-01T00:00:00Z" }),
    ];
    const fetch = vi.fn().mockResolvedValueOnce(entries);
    const adapter = makeReadyAdapter(fetch);

    const { result } = renderHook(() =>
      useEntryListData({ ...DEFAULT_ARGS, adapter, sort: "deletedAt" }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    // compareEntriesByDeletedAt sorts descending by deletedAt — most recently
    // deleted first.
    expect(result.current.entries[0].id).toBe("e2");
    expect(result.current.entries[1].id).toBe("e1");
  });

  // ── Reload ───────────────────────────────────────────────────────────────────

  it("reload() triggers a re-fetch without changing other args", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce([makeEntry("e1")])
      .mockResolvedValueOnce([makeEntry("e1"), makeEntry("e2")]);
    const adapter = makeReadyAdapter(fetchFn);

    const { result } = renderHook(() =>
      useEntryListData({ ...DEFAULT_ARGS, adapter }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.entries).toHaveLength(1);

    act(() => { result.current.reload(); });

    await waitFor(() => expect(result.current.entries).toHaveLength(2));
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  // ── refreshKey change ────────────────────────────────────────────────────────

  it("re-fetches when refreshKey changes", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce([makeEntry("e1")])
      .mockResolvedValueOnce([makeEntry("e1"), makeEntry("e3")]);
    const adapter = makeReadyAdapter(fetchFn);

    const { result, rerender } = renderHook(
      ({ refreshKey }) =>
        useEntryListData({ ...DEFAULT_ARGS, adapter, refreshKey }),
      { initialProps: { refreshKey: 0 } },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchFn).toHaveBeenCalledTimes(1);

    rerender({ refreshKey: 1 });

    await waitFor(() => expect(result.current.entries).toHaveLength(2));
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  // ── Abort on arg change (INV-C4.1) ───────────────────────────────────────────

  it("aborts in-flight fetch when view changes (INV-C4.1)", async () => {
    let capturedSignal: AbortSignal | undefined;
    let resolveFirst!: (entries: TestEntry[]) => void;
    const firstDeferred = new Promise<TestEntry[]>((r) => { resolveFirst = r; });

    const fetchFn = vi.fn((
      _view: string,
      _query: unknown,
      signal: AbortSignal,
    ) => {
      capturedSignal = signal;
      return firstDeferred;
    });
    const adapter = makeReadyAdapter(fetchFn as VaultListAdapter<TestEntry>["fetchOverviewEntries"]);

    const { rerender } = renderHook(
      ({ view }) =>
        useEntryListData({ ...DEFAULT_ARGS, adapter, view }),
      { initialProps: { view: "normal" as const } },
    );

    // Wait for the first effect to fire and capture the signal.
    await waitFor(() => expect(capturedSignal).toBeDefined());
    const firstSignal = capturedSignal!;

    // The first fetch is in flight; change the view to trigger the cleanup/abort.
    act(() => { rerender({ view: "favorites" as const }); });

    // The first request's signal must be aborted after effect cleanup.
    await waitFor(() => expect(firstSignal.aborted).toBe(true));

    // Clean up: resolve the deferred to avoid unhandled rejection.
    await act(async () => { resolveFirst([]); });
  });

  // ── Stale response ignored after abort ───────────────────────────────────────

  it("ignores stale resolve arriving after signal aborted (INV-C4.1)", async () => {
    let resolveFirst!: (entries: TestEntry[]) => void;
    const firstDeferred = new Promise<TestEntry[]>((r) => { resolveFirst = r; });

    let callCount = 0;
    const fetchFn = vi.fn((
      _view: string,
      _query: unknown,
      _signal: AbortSignal,
    ) => {
      callCount += 1;
      if (callCount === 1) return firstDeferred;
      return Promise.resolve([makeEntry("new")]);
    });
    const adapter = makeReadyAdapter(fetchFn as VaultListAdapter<TestEntry>["fetchOverviewEntries"]);

    const { result, rerender } = renderHook(
      ({ view }) =>
        useEntryListData({ ...DEFAULT_ARGS, adapter, view }),
      { initialProps: { view: "normal" as const } },
    );

    // Trigger the second fetch (cancels the first).
    rerender({ view: "favorites" as const });

    // Second fetch completes first.
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0].id).toBe("new");

    // Now let the stale first response arrive — it must not overwrite "new".
    await act(async () => { resolveFirst([makeEntry("stale")]); });

    expect(result.current.entries[0].id).toBe("new");
  });
});
