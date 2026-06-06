// @vitest-environment jsdom
/**
 * T2 — EntryListView unit tests covering:
 *   (a) Trash-view empty state (migrated from trash-list.test.tsx)
 *   (b) Trash decrypt + AAD wiring via personal adapter (migrated from trash-list.test.tsx)
 *   (c) Behavioral re-expression of trash-list-bulk-restore.test.ts assertions
 *   (d) NET-NEW: delete-permanently confirm dialog
 *   (e) NET-NEW: empty-trash confirm dialog (R30 — previously untested)
 *   (f) Read-only pane for TRASH_VIEW (INV-C2.2)
 *   (g) Row restore/delete-perm render gated by descriptor.rowActions + canDelete
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, act, fireEvent, within } from "@testing-library/react";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { mockFetchApi, mockDecryptData, mockBuildAAD, STABLE_KEY } = vi.hoisted(() => ({
  mockFetchApi: vi.fn(),
  mockDecryptData: vi.fn(),
  mockBuildAAD: vi.fn(),
  STABLE_KEY: {} as CryptoKey,
}));

// Per-test callbacks. C2: manage actions (restore / delete-permanently / soft-delete)
// moved off the row into the detail pane, so they are captured from the pane mock.
// The row mock only exposes onActivate (select).
let capturedPaneRestore: (() => void) | undefined;
let capturedPaneDeletePermanently: (() => void) | undefined;
let capturedPaneDelete: (() => void) | undefined;
let capturedBulkOnSuccess: (() => void) | undefined;

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetchApi(...args),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    encryptionKey: STABLE_KEY,
    userId: "user-1",
  }),
}));

vi.mock("@/lib/crypto/crypto-client", () => ({
  decryptData: (...args: unknown[]) => mockDecryptData(...args),
}));

vi.mock("@/lib/crypto/crypto-aad", () => ({
  buildPersonalEntryAAD: (...args: unknown[]) => mockBuildAAD(...args),
  VAULT_TYPE: { BLOB: "blob", OVERVIEW: "overview" },
}));

vi.mock("@/hooks/use-travel-mode", () => ({
  useTravelMode: () => ({ active: false }),
}));

vi.mock("@/lib/events", () => ({
  notifyVaultDataChanged: vi.fn(),
}));

// Layout mode is mutable so a test can exercise the accordion (PasswordCard) path.
// Defaults to master-detail so existing PasswordRow tests are unaffected.
let mockLayoutMode: "master-detail" | "accordion" = "master-detail";
vi.mock("@/hooks/use-layout-mode", () => ({
  useLayoutMode: () => mockLayoutMode,
}));

// Mock PasswordRow — captures restore/deletePermanently callbacks.
vi.mock("./password-row", () => ({
  PasswordRow: ({
    entry,
    onActivate,
  }: {
    entry: { id: string; title: string };
    onActivate?: () => void;
  }) => {
    return (
      <div
        data-testid={`row-${entry.id}`}
        role="option"
        aria-selected={false}
        onClick={() => onActivate?.()}
      >
        {entry.title}
      </div>
    );
  },
}));

// Mock PasswordCard (accordion mode) — captures props for the team-accordion test.
let capturedCardProps: Record<string, unknown> | undefined;
vi.mock("./password-card", () => ({
  PasswordCard: (props: { entry: { id: string; title: string } }) => {
    capturedCardProps = props as Record<string, unknown>;
    return <div data-testid={`card-${props.entry.id}`}>{props.entry.title}</div>;
  },
}));

// Mock MasterDetailShell: render both slots so rows and pane are visible.
vi.mock("./master-detail-shell", () => ({
  MasterDetailShell: ({
    listSlot,
    detailSlot,
  }: {
    listSlot: React.ReactNode;
    detailSlot: React.ReactNode;
  }) => (
    <div data-testid="master-detail-shell">
      {listSlot}
      {detailSlot}
    </div>
  ),
}));

// Mock PasswordDetailPane — expose readOnly as data-attr so tests can verify it, and
// capture the manage callbacks (restore / delete-permanently / soft-delete) since they
// moved off the row into the pane (C2). They are only defined once an entry is active,
// so tests select a row first.
vi.mock("./password-detail-pane", () => ({
  PasswordDetailPane: ({
    entryId,
    readOnly,
    onRestore,
    onDeletePermanently,
    onDelete,
  }: {
    entryId: string | null;
    readOnly?: boolean;
    onRestore?: () => void;
    onDeletePermanently?: () => void;
    onDelete?: () => void;
  }) => {
    capturedPaneRestore = onRestore;
    capturedPaneDeletePermanently = onDeletePermanently;
    capturedPaneDelete = onDelete;
    return (
      <div
        data-testid="detail-pane"
        data-entry-id={entryId ?? ""}
        data-readonly={String(readOnly ?? false)}
      />
    );
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

vi.mock("@/hooks/vault/use-entry-actions", () => ({
  useEntryActions: () => () => ({
    fetchPassword: vi.fn(),
    fetchContent: vi.fn(),
    fetchCardField: vi.fn(),
    fetchIdentityField: vi.fn(),
    fetchPasskeyField: vi.fn(),
    fetchBankField: vi.fn(),
    fetchLicenseField: vi.fn(),
    fetchSshField: vi.fn(),
    onCopyUsername: vi.fn(),
    onCopyPassword: vi.fn(),
    onCopyContent: vi.fn(),
    onCopyCardNumber: vi.fn(),
    onCopyCvv: vi.fn(),
    onCopyCredentialId: vi.fn(),
    onCopyAccountNumber: vi.fn(),
    onCopyLicenseKey: vi.fn(),
    onCopyFingerprint: vi.fn(),
    onCopyPublicKey: vi.fn(),
    onCopyIdNumber: vi.fn(),
    onOpenUrl: vi.fn(),
  }),
}));

// Capture bulk onSuccess so tests can invoke it directly.
vi.mock("@/hooks/bulk/use-bulk-action", () => ({
  useBulkAction: ({ onSuccess }: { onSuccess: () => void; scope: unknown }) => {
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

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { PasswordList } from "./password-list";
import { EntryListView } from "./entry-list-view";
import { NORMAL_VIEW } from "./entry-list-view-descriptors";
import type { VaultListAdapter } from "@/lib/vault/vault-list-adapter";
import type { TeamDisplayEntry } from "@/types/team-display-entry";

// ── Factories ──────────────────────────────────────────────────────────────────

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
    deletedAt: "2026-02-01T00:00:00Z",
    ...overrides,
  };
}

function makeDecryptedOverview(title: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ title, tags: [], ...overrides });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("EntryListView — TRASH_VIEW (T2 coverage migration + NET-NEW)", () => {
  beforeEach(() => {
    mockFetchApi.mockReset();
    mockDecryptData.mockReset();
    mockBuildAAD.mockReset().mockReturnValue("aad-bytes");
    capturedPaneRestore = undefined;
    capturedPaneDeletePermanently = undefined;
    capturedPaneDelete = undefined;
    capturedBulkOnSuccess = undefined;
  });

  // ── (a) T2 migration: trash empty-state (trash-list.test.tsx line 56) ───────
  // Precondition: API returns empty list → no entries to decrypt.
  // Trigger: PasswordList trashOnly rendered.
  // Assert: "noTrash" empty-state text appears.
  it("shows the noTrash empty state when no entries are returned (T2-a)", async () => {
    mockFetchApi.mockResolvedValueOnce({ ok: true, json: async () => [] });

    render(<PasswordList searchQuery="" tagId={null} refreshKey={0} trashOnly />);

    await waitFor(() => {
      expect(screen.getByText("noTrash")).toBeInTheDocument();
    });
  });

  // ── (b) T2 migration: decrypt + AAD (trash-list.test.tsx lines 66–97) ──────
  // §Sec-1: assert AAD uses (userId, entryId, OVERVIEW) shape.
  // §Sec-1: encrypted blob argument is shape { ciphertext, iv, authTag }.
  it("decrypts trash entries with personal-entry OVERVIEW-scope AAD (T2-b)", async () => {
    mockFetchApi.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        makeServerEntry("entry-1", {
          encryptedOverview: { ciphertext: "x", iv: "iv1", authTag: "tag1" },
        }),
      ],
    });
    mockDecryptData.mockResolvedValueOnce(
      makeDecryptedOverview("GitHub", { username: "alice" }),
    );

    render(<PasswordList searchQuery="" tagId={null} refreshKey={0} trashOnly />);

    // Entry title rendered after decrypt.
    await waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });

    // §Sec-1: AAD derived with (userId, entryId, "overview") shape.
    expect(mockBuildAAD).toHaveBeenCalledWith("user-1", "entry-1", "overview");

    // §Sec-1: decryptData called with the correct encrypted blob.
    expect(mockDecryptData).toHaveBeenCalled();
    const [blobArg, , aadArg] = mockDecryptData.mock.calls[0];
    expect(blobArg).toMatchObject({ ciphertext: "x", iv: "iv1", authTag: "tag1" });
    expect(aadArg).toBe("aad-bytes");
  });

  // ── (c) T2 re-expression: bulk restore wiring (trash-list-bulk-restore.test.ts) ─
  // Original test was a source-string grep ("imports useBulkSelection", etc.).
  // Re-expressed behaviorally: bulk onSuccess triggers a re-fetch.
  it("bulk restore wiring: onSuccess triggers reload (T2-c)", async () => {
    // Initial fetch: entry-1 in trash.
    mockFetchApi.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeServerEntry("entry-1")],
    });
    mockDecryptData.mockResolvedValueOnce(makeDecryptedOverview("GitHub"));

    render(<PasswordList searchQuery="" tagId={null} refreshKey={0} trashOnly />);

    await waitFor(() => { expect(screen.getByText("GitHub")).toBeInTheDocument(); });

    // After restore bulk action: entry-1 is gone.
    mockFetchApi.mockResolvedValueOnce({ ok: true, json: async () => [] });

    // Precondition: bulkOnSuccess was captured.
    expect(capturedBulkOnSuccess).toBeDefined();

    // Trigger: invoke bulk onSuccess (simulates successful restore).
    await act(async () => {
      capturedBulkOnSuccess?.();
    });

    // Assert: list re-fetched and shows empty trash.
    await waitFor(() => {
      expect(screen.getByText("noTrash")).toBeInTheDocument();
    });
  });

  // ── (d) NET-NEW: delete-permanently confirm dialog (R30) ────────────────────
  // Precondition: trash entry rendered; PasswordRow exposes onDeletePermanently.
  // Trigger: click delete-permanently → dialog appears.
  // Assert: dialog confirmed → adapter.deletePermanently called (via fetchApi).
  it("NET-NEW: delete-permanently shows confirm dialog and calls adapter on confirm (T2-d)", async () => {
    mockFetchApi.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeServerEntry("entry-1")],
    });
    mockDecryptData.mockResolvedValueOnce(makeDecryptedOverview("GitHub"));

    render(<PasswordList searchQuery="" tagId={null} refreshKey={0} trashOnly />);

    await waitFor(() => { expect(screen.getByText("GitHub")).toBeInTheDocument(); });

    // Select the entry so the detail pane (which owns manage actions) is active.
    act(() => { fireEvent.click(screen.getByTestId("row-entry-1")); });

    // Precondition: the detail pane received onDeletePermanently callback.
    expect(capturedPaneDeletePermanently).toBeDefined();

    // Trigger: click delete-permanently (opens confirm dialog).
    act(() => { capturedPaneDeletePermanently?.(); });

    // Assert: confirm dialog visible (description is unique).
    await waitFor(() => {
      expect(screen.getByText("deleteConfirm:{\"title\":\"GitHub\"}")).toBeInTheDocument();
    });

    // Setup: mock the permanent DELETE call + the reload fetch.
    mockFetchApi.mockResolvedValueOnce({ ok: true });
    mockFetchApi.mockResolvedValueOnce({ ok: true, json: async () => [] });

    // Trigger: click the confirm button in the dialog (role=button, name=deletePermanently).
    const confirmBtn = screen.getByRole("button", { name: "deletePermanently" });
    await act(async () => { fireEvent.click(confirmBtn); });

    // Assert: the DELETE ?permanent=true fetch was called.
    await waitFor(() => {
      const calls = mockFetchApi.mock.calls;
      const deleteCall = calls.find(
        (args: unknown[]) => {
          const url = args[0] as string;
          const opts = args[1] as RequestInit | undefined;
          return url.includes("?permanent=true") && opts?.method === "DELETE";
        },
      );
      expect(deleteCall).toBeDefined();
    });
  });

  // ── (d2) NET-NEW: soft-delete (move-to-trash) confirm dialog ────────────────
  // Master-detail row/detail delete must confirm before trashing (parity with the
  // accordion card). Precondition: normal entry rendered; row exposes onDeleteRequest.
  // Trigger: request delete → dialog appears, nothing deleted yet.
  // Assert: confirm → adapter.softDelete (DELETE, no ?permanent).
  it("NET-NEW: move-to-trash shows confirm dialog and calls softDelete on confirm", async () => {
    mockFetchApi.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeServerEntry("entry-1", { deletedAt: null })],
    });
    mockDecryptData.mockResolvedValueOnce(makeDecryptedOverview("GitHub"));

    render(<PasswordList searchQuery="" tagId={null} refreshKey={0} />);

    await waitFor(() => { expect(screen.getByText("GitHub")).toBeInTheDocument(); });

    // Select the entry so the detail pane (which owns the delete action) is active.
    act(() => { fireEvent.click(screen.getByTestId("row-entry-1")); });

    // Precondition: the detail pane received the soft-delete request callback.
    expect(capturedPaneDelete).toBeDefined();

    // Trigger: request delete — opens the confirm dialog, does NOT delete yet.
    act(() => { capturedPaneDelete?.(); });

    await waitFor(() => {
      expect(screen.getByText("deleteConfirm:{\"title\":\"GitHub\"}")).toBeInTheDocument();
    });
    // Deferred: no DELETE issued until the user confirms.
    expect(
      mockFetchApi.mock.calls.some(
        (args: unknown[]) => (args[1] as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toBe(false);

    // Setup: soft-delete DELETE + the reload fetch.
    mockFetchApi.mockResolvedValueOnce({ ok: true });
    mockFetchApi.mockResolvedValueOnce({ ok: true, json: async () => [] });

    // Trigger: confirm in the dialog (button name = Common.delete key).
    const dialog = screen.getByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "delete" }));
    });

    // Assert: a soft-delete DELETE (no ?permanent) was issued.
    await waitFor(() => {
      const softDelete = mockFetchApi.mock.calls.find((args: unknown[]) => {
        const url = args[0] as string;
        const opts = args[1] as RequestInit | undefined;
        return opts?.method === "DELETE" && !url.includes("permanent");
      });
      expect(softDelete).toBeDefined();
    });
  });

  // ── (e) NET-NEW: empty-trash confirm dialog (R30) ────────────────────────────
  // Precondition: showEmptyTrashButton=true (TRASH_VIEW) + canDelete=true (personal).
  //   Trash entry present so the button appears (not in empty state).
  // Trigger: click "Empty Trash" → confirm dialog → confirm.
  // Assert: POST /api/passwords/empty-trash called.
  it("NET-NEW: empty-trash button opens confirm dialog; confirm calls emptyTrash API (T2-e)", async () => {
    // Load one entry so we're past the empty-state (button only shows when entries exist).
    mockFetchApi.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeServerEntry("entry-1")],
    });
    mockDecryptData.mockResolvedValueOnce(makeDecryptedOverview("OldEntry"));

    render(<PasswordList searchQuery="" tagId={null} refreshKey={0} trashOnly />);

    await waitFor(() => { expect(screen.getByText("OldEntry")).toBeInTheDocument(); });

    // Assert: "Empty Trash" button is visible (gated by descriptor + canDelete).
    const emptyTrashBtn = screen.getByRole("button", { name: "emptyTrash" });
    expect(emptyTrashBtn).toBeInTheDocument();

    // Trigger: click "Empty Trash" → dialog opens.
    fireEvent.click(emptyTrashBtn);

    // Assert: confirm dialog visible.
    await waitFor(() => {
      expect(screen.getByText("emptyTrashConfirm")).toBeInTheDocument();
    });

    // Setup: mock empty-trash POST + reload fetch (empty list).
    mockFetchApi.mockResolvedValueOnce({ ok: true });
    mockFetchApi.mockResolvedValueOnce({ ok: true, json: async () => [] });

    // Trigger: click the confirm button in the empty-trash dialog.
    const dialogConfirmBtns = screen.getAllByRole("button", { name: "emptyTrash" });
    // The second "emptyTrash" button is inside the dialog.
    const dialogConfirmBtn = dialogConfirmBtns[dialogConfirmBtns.length - 1];
    await act(async () => { fireEvent.click(dialogConfirmBtn); });

    // Assert: POST to empty-trash endpoint was called.
    await waitFor(() => {
      const postCall = mockFetchApi.mock.calls.find((args: unknown[]) => {
        const url = args[0] as string;
        const opts = args[1] as RequestInit | undefined;
        return url === "/api/passwords/empty-trash" && opts?.method === "POST";
      });
      expect(postCall).toBeDefined();
    });
  });

  // ── (f) Read-only pane for TRASH_VIEW (INV-C2.2 / S6) ──────────────────────
  // Precondition: TRASH_VIEW descriptor.detailReadOnly=true.
  // Trigger: render PasswordList trashOnly.
  // Assert: PasswordDetailPane receives readOnly=true (no edit affordance).
  it("TRASH_VIEW: detail pane is read-only (INV-C2.2, T2-f)", async () => {
    mockFetchApi.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeServerEntry("entry-1")],
    });
    mockDecryptData.mockResolvedValueOnce(makeDecryptedOverview("GitHub"));

    render(<PasswordList searchQuery="" tagId={null} refreshKey={0} trashOnly />);

    await waitFor(() => { expect(screen.getByText("GitHub")).toBeInTheDocument(); });

    // Select the entry so the detail pane (PasswordDetailPane) renders rather than the
    // empty-trash no-selection state.
    act(() => { fireEvent.click(screen.getByTestId("row-entry-1")); });

    // Assert: detail pane rendered with readOnly=true.
    const pane = screen.getByTestId("detail-pane");
    expect(pane).toHaveAttribute("data-readonly", "true");
  });

  // ── (g) Restore + delete-permanently gated by descriptor.rowActions + canDelete ─
  // Precondition: TRASH_VIEW has rowActions.restore=true and rowActions.deletePermanently=true.
  //   Personal adapter has canDelete=true.
  // Trigger: render with one trash entry.
  // Assert: PasswordRow received onRestore and onDeletePermanently callbacks (not undefined).
  //
  // Verify by mutation: setting canDelete=false in the adapter (not tested here — adapter is
  // real; guard is exercised by the descriptor×adapter intersection in EntryListView).
  it("TRASH_VIEW detail pane: restore and delete-perm callbacks provided (T2-g)", async () => {
    mockFetchApi.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeServerEntry("entry-1")],
    });
    mockDecryptData.mockResolvedValueOnce(makeDecryptedOverview("GitHub"));

    render(<PasswordList searchQuery="" tagId={null} refreshKey={0} trashOnly />);

    await waitFor(() => { expect(screen.getByTestId("row-entry-1")).toBeInTheDocument(); });

    // Select the entry so the detail pane (the persistent action home) is active.
    act(() => { fireEvent.click(screen.getByTestId("row-entry-1")); });

    // Assert: both callbacks present (TRASH_VIEW.rowActions.restore=true + canDelete=true).
    expect(capturedPaneRestore).toBeDefined();
    expect(capturedPaneDeletePermanently).toBeDefined();
  });

  // ── Restore callback removes entry from list (C9 — no confirm required) ──────
  // Precondition: entry rendered; onRestore callback present.
  // Trigger: call onRestore → adapter.restore() → POST /api/passwords/{id}/restore.
  // Assert: restore API called.
  it("restore callback calls the restore API and triggers reload (T2-h)", async () => {
    mockFetchApi.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeServerEntry("entry-1")],
    });
    mockDecryptData.mockResolvedValueOnce(makeDecryptedOverview("GitHub"));

    render(<PasswordList searchQuery="" tagId={null} refreshKey={0} trashOnly />);

    await waitFor(() => { expect(screen.getByTestId("row-entry-1")).toBeInTheDocument(); });

    // Select the entry so the detail pane (which owns restore) is active.
    act(() => { fireEvent.click(screen.getByTestId("row-entry-1")); });

    // Setup: mock restore POST + reload fetch.
    mockFetchApi.mockResolvedValueOnce({ ok: true });
    mockFetchApi.mockResolvedValueOnce({ ok: true, json: async () => [] });

    // Trigger: invoke restore.
    await act(async () => { capturedPaneRestore?.(); });

    // Assert: POST to restore endpoint called.
    await waitFor(() => {
      const restoreCall = mockFetchApi.mock.calls.find((args: unknown[]) => {
        const url = args[0] as string;
        const opts = args[1] as RequestInit | undefined;
        return url.includes("/restore") && opts?.method === "POST";
      });
      expect(restoreCall).toBeDefined();
    });
  });
});

// ── Keyboard navigation (master-detail) — migrated from password-dashboard.test.tsx
// when keyboard nav moved out of the dashboard into EntryListView. Asserts INV-C7.2
// (input guard), INV-C7.3 (Esc stopPropagation), INV-C7.4 (ArrowDown debounce). ──
describe("EntryListView — keyboard navigation (INV-C7)", () => {
  beforeEach(() => {
    mockFetchApi.mockReset();
    mockDecryptData.mockReset();
    mockBuildAAD.mockReset().mockReturnValue("aad-bytes");
  });

  // Load a NORMAL_VIEW list with two entries and return the focusable list-pane div.
  async function renderTwoEntries() {
    mockFetchApi.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeServerEntry("e1"), makeServerEntry("e2")],
    });
    mockDecryptData
      .mockResolvedValueOnce(makeDecryptedOverview("Entry 1"))
      .mockResolvedValueOnce(makeDecryptedOverview("Entry 2"));

    render(<PasswordList searchQuery="" tagId={null} refreshKey={0} />);
    await waitFor(() => { expect(screen.getByTestId("row-e1")).toBeInTheDocument(); });

    return screen.getByTestId("master-detail-shell").firstChild as HTMLElement;
  }

  it("ArrowDown with no active entry activates the first entry", async () => {
    const listPane = await renderTwoEntries();

    // Precondition: no active entry yet.
    expect(screen.getByTestId("detail-pane")).toHaveAttribute("data-entry-id", "");

    fireEvent.keyDown(listPane, { key: "ArrowDown" });

    // Debounce (~150ms) → activeEntry becomes e1 → detail pane reflects it.
    await waitFor(() => {
      expect(screen.getByTestId("detail-pane")).toHaveAttribute("data-entry-id", "e1");
    });
  });

  it("INV-C7.2: ArrowDown fired from an input inside the pane does NOT activate an entry", async () => {
    const listPane = await renderTwoEntries();

    const input = document.createElement("input");
    listPane.appendChild(input);

    fireEvent.keyDown(input, { key: "ArrowDown", bubbles: true });

    // The inInput guard returns early — no debounce scheduled. Wait past the window.
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.getByTestId("detail-pane")).toHaveAttribute("data-entry-id", "");

    listPane.removeChild(input);
  });

  it("INV-C7.3: Esc on the list pane calls stopPropagation (blocks the global Esc cascade)", async () => {
    const listPane = await renderTwoEntries();

    const escEvent = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    const stopPropSpy = vi.spyOn(escEvent, "stopPropagation");

    act(() => { listPane.dispatchEvent(escEvent); });

    expect(stopPropSpy).toHaveBeenCalled();
  });

  it("INV-C7.4: rapid ArrowDown reschedules the debounce timer (coalesces to one activation)", async () => {
    const listPane = await renderTwoEntries();

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const before = setTimeoutSpy.mock.calls.length;

    const PRESS_COUNT = 4;
    for (let i = 0; i < PRESS_COUNT; i++) {
      fireEvent.keyDown(listPane, { key: "ArrowDown" });
    }

    // Each keypress cancels + reschedules → at least one setTimeout per press.
    expect(setTimeoutSpy.mock.calls.length - before).toBeGreaterThanOrEqual(PRESS_COUNT);

    // Only the final timer fires → exactly one entry activated.
    await waitFor(() => {
      expect(screen.getByTestId("detail-pane")).toHaveAttribute("data-entry-id", "e1");
    });

    setTimeoutSpy.mockRestore();
  });
});

// ── Accordion + team: PasswordCard must receive the team-aware fetchers so it
// decrypts against the TEAM vault, not the personal one (regression guard for the
// bug the triangulated review caught — INV-C6.1). ──────────────────────────────
describe("EntryListView — accordion team PasswordCard wiring", () => {
  beforeEach(() => {
    mockLayoutMode = "accordion";
    capturedCardProps = undefined;
  });
  afterAll(() => { mockLayoutMode = "master-detail"; });

  function teamEntry(): TeamDisplayEntry {
    return {
      id: "te1", entryType: "LOGIN", title: "Team Entry",
      username: null, urlHost: null, snippet: null, brand: null, lastFour: null,
      cardholderName: null, fullName: null, idNumberLast4: null, relyingPartyId: null,
      bankName: null, accountNumberLast4: null, softwareName: null, licensee: null,
      keyType: null, fingerprint: null, requireReprompt: false, expiresAt: null,
      isFavorite: false, isArchived: false, tags: [],
      createdBy: { id: "u1", name: "Alice", email: "a@x", image: null },
      updatedBy: { id: "u1", name: "Alice", email: "a@x" },
      createdAt: "2026-01-01", updatedAt: "2026-01-02",
    };
  }

  function teamAdapter(): VaultListAdapter<TeamDisplayEntry> {
    return {
      kind: "team",
      teamId: "team-1",
      availability: { ready: true },
      permissions: { canCreate: true, canEdit: true, canDelete: true, canShare: true },
      supportsFavorite: true,
      fetchOverviewEntries: async () => [teamEntry()],
      buildGetDetail: () => async () =>
        ({ password: "pw", content: "", url: "https://x" }) as never,
      setFavorite: async () => {}, setArchived: async () => {}, softDelete: async () => {},
      restore: async () => {}, deletePermanently: async () => {}, emptyTrash: async () => {},
      notifyDataChanged: () => {},
      bulkScope: () => ({ type: "team", teamId: "team-1" }),
      createdByLabel: () => "createdBy:Alice",
    };
  }

  it("passes getPassword/getDetail/getUrl + createdBy to the team accordion card", async () => {
    render(
      <EntryListView<TeamDisplayEntry>
        adapter={teamAdapter()}
        descriptor={NORMAL_VIEW}
        query={{ tagId: null, folderId: null, entryType: null }}
        searchQuery=""
        sortBy="updatedAt"
        refreshKey={0}
      />,
    );

    await waitFor(() => { expect(screen.getByTestId("card-te1")).toBeInTheDocument(); });

    // Team mode is keyed on getPassword presence; without these the card would fall
    // back to the PERSONAL endpoint/key (the bug).
    expect(typeof capturedCardProps?.getPassword).toBe("function");
    expect(typeof capturedCardProps?.getDetail).toBe("function");
    expect(typeof capturedCardProps?.getUrl).toBe("function");
    expect(capturedCardProps?.createdBy).toBe("createdBy:Alice");
    expect(await (capturedCardProps?.getPassword as () => Promise<string>)()).toBe("pw");
  });
});
