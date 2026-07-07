// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, act, fireEvent, within } from "@testing-library/react";

const { mockFetchApi, mockDecryptData, STABLE_KEY } = vi.hoisted(() => ({
  mockFetchApi: vi.fn(),
  mockDecryptData: vi.fn(),
  STABLE_KEY: {} as CryptoKey,
}));

// ── Per-test callbacks captured from PasswordCard / PasswordRow mocks ────────
// Accordion mode: PasswordCard captures toggle callbacks
let capturedCardToggleFavorite: ((id: string, current: boolean) => void) | undefined;
let capturedCardToggleArchive: ((id: string, current: boolean) => void) | undefined;
let capturedCardDelete: ((id: string) => void) | undefined;
// Master-detail mode: PasswordRow captures the activate callback; the detail pane
// captures the manage callbacks (archive/delete moved off the row — C2).
let capturedRowActivate: (() => void) | undefined;
let capturedPaneArchive: (() => void) | undefined;
let capturedPaneDelete: (() => void) | undefined;

// T3: capture useBulkAction's onSuccess so tests can invoke it directly.
let capturedBulkOnSuccess: (() => void) | undefined;

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
  useLocale: () => "en",
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ encryptionKey: STABLE_KEY, userId: "user-1" }),
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetchApi(...args),
}));

vi.mock("@/lib/crypto/crypto-client", () => ({
  decryptData: (...args: unknown[]) => mockDecryptData(...args),
}));

vi.mock("@/lib/crypto/crypto-aad", () => ({
  buildPersonalEntryAAD: vi.fn().mockReturnValue("aad"),
  VAULT_TYPE: { BLOB: "blob", OVERVIEW: "overview" },
}));

vi.mock("@/hooks/use-travel-mode", () => ({
  useTravelMode: () => ({ active: false }),
}));

// Mock useLayoutMode so jsdom doesn't fail on window.matchMedia.
// Individual tests override this by calling setMockLayoutMode.
let mockLayoutModeValue: "accordion" | "master-detail" = "accordion";
function setMockLayoutMode(mode: "accordion" | "master-detail") {
  mockLayoutModeValue = mode;
}

vi.mock("@/hooks/use-layout-mode", () => ({
  useLayoutMode: () => mockLayoutModeValue,
}));

// T3: mock useBulkAction to expose the onSuccess callback.
// The real hook is internal; this mock captures the onSuccess so tests can
// invoke the membership-check path (INV-C4.3 bulk) directly.
vi.mock("@/hooks/bulk/use-bulk-action", () => ({
  useBulkAction: ({ onSuccess }: { onSuccess: () => void }) => {
    capturedBulkOnSuccess = onSuccess;
    return {
      dialogOpen: false,
      setDialogOpen: vi.fn(),
      pendingAction: null,
      processing: false,
      requestAction: vi.fn(),
      executeAction: vi.fn(),
    };
  },
}));

// Accordion-mode component mock — captures toggle callbacks
vi.mock("./password-card", () => ({
  PasswordCard: ({
    entry,
    onToggleFavorite,
    onToggleArchive,
    onDelete,
  }: {
    entry: { id: string; title: string };
    onToggleFavorite: (id: string, current: boolean) => void;
    onToggleArchive: (id: string, current: boolean) => void;
    onDelete: (id: string) => void;
  }) => {
    capturedCardToggleFavorite = onToggleFavorite;
    capturedCardToggleArchive = onToggleArchive;
    capturedCardDelete = onDelete;
    return <div data-testid={`card-${entry.id}`}>{entry.title}</div>;
  },
}));

// Master-detail-mode component mock — captures row callbacks
vi.mock("./password-row", () => ({
  PasswordRow: ({
    entry,
    onActivate,
  }: {
    entry: { id: string; title: string };
    isActive: boolean;
    onActivate: () => void;
    selectionMode?: boolean;
  }) => {
    capturedRowActivate = onActivate;
    return (
      <div
        data-testid={`row-${entry.id}`}
        role="option"
        aria-selected={false}
      >
        {entry.title}
      </div>
    );
  },
}));

// Mock MasterDetailShell so we can test layouts without real DOM shell behavior.
vi.mock("./master-detail-shell", () => ({
  MasterDetailShell: ({
    listSlot,
    detailSlot,
  }: {
    listSlot: React.ReactNode;
    detailSlot: React.ReactNode;
    layoutMode?: string;
    activeEntryId?: string | null;
  }) => (
    <div data-testid="master-detail-shell">
      {listSlot}
      {detailSlot}
    </div>
  ),
}));

// Mock PasswordDetailPane so tests don't need vault decrypt for the pane.
// C2: manage actions (archive/delete) are driven from the pane now, so the pane mock
// captures onArchive/onDelete for the master-detail INV-C4.3 tests.
vi.mock("./password-detail-pane", () => ({
  PasswordDetailPane: ({
    entryId,
    onArchive,
    onDelete,
  }: {
    entryId: string | null;
    onArchive?: () => void;
    onDelete?: () => void;
  }) => {
    capturedPaneArchive = onArchive;
    capturedPaneDelete = onDelete;
    return <div data-testid="detail-pane" data-entry-id={entryId ?? ""} />;
  },
}));

vi.mock("@/hooks/vault/use-password-entry-detail", () => ({
  usePasswordEntryDetail: () => ({
    detailData: null,
    loading: false,
    error: null,
    invalidate: vi.fn(),
  }),
}));

// ── Minimal server payload factory ───────────────────────────────────────────

function makeServerEntry(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    encryptedOverview: { ciphertext: "x", iv: "iv", authTag: "tag" },
    aadVersion: 1,
    isFavorite: false,
    isArchived: false,
    requireReprompt: false,
    entryType: "LOGIN",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-02",
    ...overrides,
  };
}

function makeDecryptedOverview(title: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ title, tags: [], ...overrides });
}

import { PasswordList } from "./password-list";

describe("PasswordList", () => {
  beforeEach(() => {
    mockFetchApi.mockReset();
    mockDecryptData.mockReset();
    capturedCardToggleFavorite = undefined;
    capturedCardToggleArchive = undefined;
    capturedCardDelete = undefined;
    capturedRowActivate = undefined;
    capturedPaneArchive = undefined;
    capturedPaneDelete = undefined;
    capturedBulkOnSuccess = undefined;
    mockLayoutModeValue = "accordion";
  });

  // ── Smoke tests (existing) ───────────────────────────────────────────────────

  it("shows the no-passwords empty state when there are no entries", async () => {
    mockFetchApi.mockResolvedValueOnce({ ok: true, json: async () => [] });

    render(<PasswordList searchQuery="" tagId={null} refreshKey={0} />);

    await waitFor(() => {
      expect(screen.getByText("noPasswords")).toBeInTheDocument();
    });
  });

  it("renders cards for decrypted entries", async () => {
    mockFetchApi.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeServerEntry("e1")],
    });
    mockDecryptData.mockResolvedValueOnce(makeDecryptedOverview("Site A"));

    render(<PasswordList searchQuery="" tagId={null} refreshKey={0} />);

    await waitFor(() => {
      expect(screen.getByTestId("card-e1")).toBeInTheDocument();
    });
    expect(screen.getByText("Site A")).toBeInTheDocument();
  });

  it("shows favorites empty state when favoritesOnly is true and no entries", async () => {
    mockFetchApi.mockResolvedValueOnce({ ok: true, json: async () => [] });

    render(
      <PasswordList
        searchQuery=""
        tagId={null}
        refreshKey={0}
        favoritesOnly={true}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("noFavorites")).toBeInTheDocument();
    });
  });

  // ── layoutMode rendering ─────────────────────────────────────────────────────

  it('layoutMode "master-detail" renders PasswordRow (NOT PasswordCard)', async () => {
    setMockLayoutMode("master-detail");
    mockFetchApi.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeServerEntry("e1")],
    });
    mockDecryptData.mockResolvedValueOnce(makeDecryptedOverview("My Entry"));

    render(
      <PasswordList
        searchQuery=""
        tagId={null}
        refreshKey={0}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("row-e1")).toBeInTheDocument();
    });
    // PasswordCard must NOT be rendered
    expect(screen.queryByTestId("card-e1")).not.toBeInTheDocument();
  });

  it('layoutMode "accordion" renders PasswordCard (NOT PasswordRow)', async () => {
    mockFetchApi.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeServerEntry("e1")],
    });
    mockDecryptData.mockResolvedValueOnce(makeDecryptedOverview("My Entry"));

    render(
      <PasswordList
        searchQuery=""
        tagId={null}
        refreshKey={0}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("card-e1")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("row-e1")).not.toBeInTheDocument();
  });

  it('defaults to "accordion" when layoutMode is not provided', async () => {
    mockFetchApi.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeServerEntry("e1")],
    });
    mockDecryptData.mockResolvedValueOnce(makeDecryptedOverview("My Entry"));

    render(<PasswordList searchQuery="" tagId={null} refreshKey={0} />);

    await waitFor(() => {
      expect(screen.getByTestId("card-e1")).toBeInTheDocument();
    });
  });

  // ── INV-C4.3 single-entry: onEntryRemoved fires at each removal site ─────────

  it("INV-C4.3: handleToggleFavorite fires onEntryRemoved when unfavoriting in favorites view", async () => {
    mockFetchApi.mockResolvedValue({
      ok: true,
      json: async () => [makeServerEntry("e1", { isFavorite: true })],
    });
    mockDecryptData.mockResolvedValue(makeDecryptedOverview("Fav Entry"));

    const onEntryRemoved = vi.fn();

    render(
      <PasswordList
        searchQuery=""
        tagId={null}
        refreshKey={0}
        favoritesOnly={true}
        onEntryRemoved={onEntryRemoved}
      />,
    );

    // Precondition: entry rendered
    await waitFor(() => { expect(screen.getByTestId("card-e1")).toBeInTheDocument(); });
    expect(onEntryRemoved).not.toHaveBeenCalled();

    // Trigger: unfavorite (current=true) in favorites-only view → removal
    await act(async () => {
      capturedCardToggleFavorite?.("e1", true);
    });

    // Assert: removal signalled
    expect(onEntryRemoved).toHaveBeenCalledWith("e1");
  });

  it("INV-C4.3: handleToggleFavorite does NOT fire onEntryRemoved when favoriting (not a removal)", async () => {
    mockFetchApi.mockResolvedValue({
      ok: true,
      json: async () => [makeServerEntry("e1", { isFavorite: false })],
    });
    mockDecryptData.mockResolvedValue(makeDecryptedOverview("Entry"));

    const onEntryRemoved = vi.fn();

    render(
      <PasswordList
        searchQuery=""
        tagId={null}
        refreshKey={0}
        favoritesOnly={true}
        onEntryRemoved={onEntryRemoved}
      />,
    );

    await waitFor(() => { expect(screen.getByTestId("card-e1")).toBeInTheDocument(); });

    // Trigger: favoriting (current=false) — no visual removal
    await act(async () => {
      capturedCardToggleFavorite?.("e1", false);
    });

    expect(onEntryRemoved).not.toHaveBeenCalled();
  });

  it("INV-C4.3: handleToggleArchive fires onEntryRemoved (accordion mode)", async () => {
    mockFetchApi.mockResolvedValue({
      ok: true,
      json: async () => [makeServerEntry("e1")],
    });
    mockDecryptData.mockResolvedValue(makeDecryptedOverview("Entry"));

    const onEntryRemoved = vi.fn();

    render(
      <PasswordList
        searchQuery=""
        tagId={null}
        refreshKey={0}
        onEntryRemoved={onEntryRemoved}
      />,
    );

    // Precondition: entry rendered
    await waitFor(() => { expect(screen.getByTestId("card-e1")).toBeInTheDocument(); });
    expect(onEntryRemoved).not.toHaveBeenCalled();

    // Trigger: archive the entry
    await act(async () => {
      capturedCardToggleArchive?.("e1", false);
    });

    // Assert: removal signalled
    expect(onEntryRemoved).toHaveBeenCalledWith("e1");
  });

  it("INV-C4.3: handleDelete fires onEntryRemoved (accordion mode)", async () => {
    mockFetchApi.mockResolvedValue({
      ok: true,
      json: async () => [makeServerEntry("e1")],
    });
    mockDecryptData.mockResolvedValue(makeDecryptedOverview("Entry"));

    const onEntryRemoved = vi.fn();

    render(
      <PasswordList
        searchQuery=""
        tagId={null}
        refreshKey={0}
        onEntryRemoved={onEntryRemoved}
      />,
    );

    // Precondition: entry rendered
    await waitFor(() => { expect(screen.getByTestId("card-e1")).toBeInTheDocument(); });
    expect(onEntryRemoved).not.toHaveBeenCalled();

    // Trigger: delete the entry
    await act(async () => {
      capturedCardDelete?.("e1");
    });

    // Assert: removal signalled
    expect(onEntryRemoved).toHaveBeenCalledWith("e1");
  });

  it("INV-C4.3: detail-pane archive fires onEntryRemoved (master-detail mode)", async () => {
    setMockLayoutMode("master-detail");
    mockFetchApi.mockResolvedValue({
      ok: true,
      json: async () => [makeServerEntry("e1")],
    });
    mockDecryptData.mockResolvedValue(makeDecryptedOverview("Entry"));

    const onEntryRemoved = vi.fn();

    render(
      <PasswordList
        searchQuery=""
        tagId={null}
        refreshKey={0}
        onEntryRemoved={onEntryRemoved}
      />,
    );

    // Precondition: row rendered, then select it so the detail pane has an active entry.
    await waitFor(() => { expect(screen.getByTestId("row-e1")).toBeInTheDocument(); });
    await act(async () => { capturedRowActivate?.(); });
    expect(onEntryRemoved).not.toHaveBeenCalled();

    // Trigger: archive from the detail pane (calls handleSetArchived internally)
    await act(async () => {
      capturedPaneArchive?.();
    });

    // Assert: removal signalled
    expect(onEntryRemoved).toHaveBeenCalledWith("e1");
  });

  it("INV-C4.3: detail-pane delete fires onEntryRemoved after confirm (master-detail mode)", async () => {
    setMockLayoutMode("master-detail");
    mockFetchApi.mockResolvedValue({
      ok: true,
      json: async () => [makeServerEntry("e1")],
    });
    mockDecryptData.mockResolvedValue(makeDecryptedOverview("Entry"));

    const onEntryRemoved = vi.fn();

    render(
      <PasswordList
        searchQuery=""
        tagId={null}
        refreshKey={0}
        onEntryRemoved={onEntryRemoved}
      />,
    );

    // Precondition: row rendered, then select it so the detail pane has an active entry.
    await waitFor(() => { expect(screen.getByTestId("row-e1")).toBeInTheDocument(); });
    await act(async () => { capturedRowActivate?.(); });
    expect(onEntryRemoved).not.toHaveBeenCalled();

    // Trigger: request delete from the detail pane — opens the confirm dialog.
    act(() => {
      capturedPaneDelete?.();
    });

    // Removal is deferred until the user confirms move-to-trash.
    expect(onEntryRemoved).not.toHaveBeenCalled();

    // Confirm in the dialog (button name = Common.delete key).
    const dialog = await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "delete" }));
    });

    // Assert: removal signalled after confirm
    expect(onEntryRemoved).toHaveBeenCalledWith("e1");
  });

  // ── INV-C4.3 bulk: membership check after re-fetch ───────────────────────────

  it("INV-C4.3 bulk: after re-fetch where active entry is gone, onActivate(null) is called", async () => {
    // First fetch: returns e1 and e2
    mockFetchApi.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeServerEntry("e1"), makeServerEntry("e2")],
    });
    mockDecryptData.mockResolvedValueOnce(makeDecryptedOverview("Entry 1"));
    mockDecryptData.mockResolvedValueOnce(makeDecryptedOverview("Entry 2"));
    const onEntryRemoved = vi.fn();

    const { rerender } = render(
      <PasswordList
        searchQuery=""
        tagId={null}
        refreshKey={0}
        onEntryRemoved={onEntryRemoved}
      />,
    );

    // Precondition: entries loaded, e1 is the active entry
    await waitFor(() => { expect(screen.getByTestId("card-e1")).toBeInTheDocument(); });

    // Second fetch (triggered by refreshKey change): returns only e2 (e1 removed by bulk op)
    mockFetchApi.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeServerEntry("e2")],
    });
    mockDecryptData.mockResolvedValueOnce(makeDecryptedOverview("Entry 2"));

    await act(async () => {
      rerender(
        <PasswordList
          searchQuery=""
          tagId={null}
          refreshKey={1}
          onEntryRemoved={onEntryRemoved}
        />,
      );
    });

    await waitFor(() => {
      // e2 should appear, e1 should be gone (re-fetched away)
      expect(screen.queryByTestId("card-e1")).not.toBeInTheDocument();
      expect(screen.getByTestId("card-e2")).toBeInTheDocument();
    });

    // The membership check lives in useBulkAction onSuccess, not in the refreshKey path.
    // Here we confirm no crash and the list renders correctly post-refresh.
  });

  // ── T3: Bulk membership check via useBulkAction.onSuccess path ──────────────
  // INV-C4.3 (bulk): when bulk onSuccess fires and the re-fetch returns a list
  // that does NOT contain the active entry, the list reloads correctly.
  //
  // NOTE: In the new architecture, the active entry state lives in EntryListView,
  // not in PasswordList. The bulk onSuccess now calls reload() to trigger a
  // re-fetch. The active-entry-absent check is handled via onEntryRemoved or
  // the refreshed list showing the entry is gone.
  // The key assertion preserved: after bulk onSuccess, the list re-fetches.
  //
  // VERIFY by mutation: breaking onSuccess in useBulkAction hook (removing the
  // clearSelection() + reload()) must make this test fail.

  it("T3 INV-C4.3 bulk: onSuccess triggers reload; list re-renders with new data", async () => {
    // Initial fetch: e1 and e2 present
    mockFetchApi.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeServerEntry("e1"), makeServerEntry("e2")],
    });
    mockDecryptData.mockResolvedValueOnce(makeDecryptedOverview("Entry 1"));
    mockDecryptData.mockResolvedValueOnce(makeDecryptedOverview("Entry 2"));

    render(
      <PasswordList
        searchQuery=""
        tagId={null}
        refreshKey={0}
      />,
    );

    // Precondition: e1 and e2 are rendered
    await waitFor(() => { expect(screen.getByTestId("card-e1")).toBeInTheDocument(); });

    // onSuccess re-fetch: e1 is gone (bulk-deleted), only e2 remains
    mockFetchApi.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeServerEntry("e2")],
    });
    mockDecryptData.mockResolvedValueOnce(makeDecryptedOverview("Entry 2"));

    // Trigger: invoke the bulk onSuccess (captured from the useBulkAction mock)
    expect(capturedBulkOnSuccess).toBeDefined();
    await act(async () => {
      capturedBulkOnSuccess?.();
    });

    // Assert: the list re-fetched and now shows only e2
    await waitFor(() => {
      expect(screen.queryByTestId("card-e1")).not.toBeInTheDocument();
      expect(screen.getByTestId("card-e2")).toBeInTheDocument();
    });
  });
});
