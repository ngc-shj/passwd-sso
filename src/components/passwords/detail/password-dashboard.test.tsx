// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";
import type { DisplayEntry } from "./password-list";

// ── Shared callback registry ─────────────────────────────────────────────────
// PasswordList mock captures onActivate / onEntryRemoved / onVisibleEntriesChange
// so tests can trigger them directly.
let capturedOnActivate: ((entry: DisplayEntry | null) => void) | undefined;
let capturedOnEntryRemoved: ((id: string) => void) | undefined;
let capturedOnVisibleEntriesChange: ((entries: DisplayEntry[]) => void) | undefined;

// Track calls to the detail-fetch mock
const { mockGetDetail } = vi.hoisted(() => ({
  mockGetDetail: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/components/layout/search-bar", () => ({
  SearchBar: () => <div data-testid="search-bar" />,
}));

vi.mock("@/components/passwords/detail/password-list", () => ({
  PasswordList: (props: {
    activeEntryId?: string | null;
    onActivate?: (entry: DisplayEntry | null) => void;
    onEntryRemoved?: (id: string) => void;
    onVisibleEntriesChange?: (entries: DisplayEntry[]) => void;
  }) => {
    capturedOnActivate = props.onActivate;
    capturedOnEntryRemoved = props.onEntryRemoved;
    capturedOnVisibleEntriesChange = props.onVisibleEntriesChange;
    return <div data-testid="password-list" data-active-entry-id={props.activeEntryId ?? ""} />;
  },
}));

vi.mock("@/components/passwords/shared/trash-list", () => ({
  TrashList: () => <div data-testid="trash-list" />,
}));

vi.mock("@/components/passwords/dialogs/personal-password-new-dialog", () => ({
  PasswordNewDialog: () => null,
}));

vi.mock("@/hooks/personal/use-personal-folders", () => ({
  usePersonalFolders: () => ({ folders: [] }),
}));

vi.mock("@/hooks/personal/use-personal-tags", () => ({
  usePersonalTags: () => ({ tags: [] }),
}));

vi.mock("@/components/extension/auto-extension-connect", () => ({
  isOverlayActive: () => false,
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    encryptionKey: {} as CryptoKey,
    userId: "user-1",
    status: "UNLOCKED",
  }),
}));

// layoutMode starts as "accordion"; individual tests override by calling setMockLayoutMode.
let mockLayoutModeValue: "accordion" | "master-detail" = "accordion";
function setMockLayoutMode(mode: "accordion" | "master-detail") {
  mockLayoutModeValue = mode;
}

vi.mock("@/hooks/use-layout-mode", () => ({
  useLayoutMode: () => mockLayoutModeValue,
}));

// Track usePasswordEntryDetail call args so we can check entryId passed to the hook.
let lastEntryIdPassedToHook: string | null = undefined as unknown as string | null;
// T2: full list of DISTINCT entryId values seen across renders (tracks unique transitions).
const entryIdHistory: (string | null)[] = [];

vi.mock("@/hooks/vault/use-password-entry-detail", () => ({
  usePasswordEntryDetail: (entryId: string | null) => {
    // Only record when the value changes (avoids duplicate entries from same-render reruns)
    if (entryId !== lastEntryIdPassedToHook) {
      entryIdHistory.push(entryId);
    }
    lastEntryIdPassedToHook = entryId;
    return {
      detailData: null,
      loading: false,
      error: null,
      invalidate: vi.fn(),
    };
  },
}));

vi.mock("@/components/passwords/detail/master-detail-shell", () => ({
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
      <div data-testid="master-detail-detail" tabIndex={-1}>{detailSlot}</div>
    </div>
  ),
}));

// PasswordDetailPane mock: renders the entryId it received so we can assert on it.
vi.mock("@/components/passwords/detail/password-detail-pane", () => ({
  PasswordDetailPane: ({ entryId }: { entryId: string | null }) => (
    <div data-testid="detail-pane" data-entry-id={entryId ?? ""} />
  ),
}));

vi.mock("@/components/passwords/dialogs/personal-password-edit-dialog-loader", () => ({
  PasswordEditDialogLoader: () => null,
}));

vi.mock("@/components/share/share-dialog", () => ({
  ShareDialog: () => null,
}));

vi.mock("@/lib/vault/build-personal-get-detail", () => ({
  buildPersonalGetDetail: () => mockGetDetail,
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { PasswordDashboard } from "./password-dashboard";

// Helper to build a minimal DisplayEntry
function makeEntry(id: string, overrides: Partial<DisplayEntry> = {}): DisplayEntry {
  return {
    id,
    entryType: "LOGIN",
    title: `Entry ${id}`,
    username: null,
    urlHost: null,
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
    travelSafe: true,
    expiresAt: null,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("PasswordDashboard", () => {
  beforeEach(() => {
    mockGetDetail.mockReset();
    mockLayoutModeValue = "accordion";
    capturedOnActivate = undefined;
    capturedOnEntryRemoved = undefined;
    capturedOnVisibleEntriesChange = undefined;
    lastEntryIdPassedToHook = null;
    entryIdHistory.length = 0;
  });

  // ── Basic smoke tests (existing) ────────────────────────────────────────────

  it("renders the search bar and password list for the all view", () => {
    render(<PasswordDashboard view="all" />);

    expect(screen.getByTestId("search-bar")).toBeInTheDocument();
    expect(screen.getByTestId("password-list")).toBeInTheDocument();
    expect(screen.queryByTestId("trash-list")).not.toBeInTheDocument();
  });

  it("renders the trash list for the trash view", () => {
    render(<PasswordDashboard view="trash" />);

    expect(screen.getByTestId("trash-list")).toBeInTheDocument();
    expect(screen.queryByTestId("password-list")).not.toBeInTheDocument();
  });

  it("uses the favorites subtitle when view=favorites", () => {
    render(<PasswordDashboard view="favorites" />);
    expect(screen.getByText("favorites")).toBeInTheDocument();
  });

  // ── activeEntry set when onActivate is called ────────────────────────────────

  it("passes the activated entry id to usePasswordEntryDetail after onActivate", () => {
    render(<PasswordDashboard view="all" />);

    // Precondition: no active entry initially
    expect(lastEntryIdPassedToHook).toBeNull();

    // Trigger onActivate with an entry
    act(() => {
      capturedOnActivate?.(makeEntry("e1"));
    });

    // The hook should now receive "e1" as entryId
    expect(lastEntryIdPassedToHook).toBe("e1");
  });

  it("passes the activated entry id to the detail pane", () => {
    render(<PasswordDashboard view="all" />);

    act(() => {
      capturedOnActivate?.(makeEntry("e42"));
    });

    // The PasswordDetailPane should receive the activated entry id
    const pane = screen.getByTestId("detail-pane");
    expect(pane).toHaveAttribute("data-entry-id", "e42");
  });

  it("clears active entry when onActivate(null) is called", () => {
    render(<PasswordDashboard view="all" />);

    // Activate entry first
    act(() => { capturedOnActivate?.(makeEntry("e1")); });
    expect(lastEntryIdPassedToHook).toBe("e1");

    // Deactivate
    act(() => { capturedOnActivate?.(null); });
    expect(lastEntryIdPassedToHook).toBeNull();
  });

  // ── INV-C4.2: view change clears activeEntry ─────────────────────────────────

  it("INV-C4.2: changing view clears activeEntry (during-render viewKey path)", () => {
    const { rerender } = render(<PasswordDashboard view="all" />);

    // Precondition: activate an entry
    act(() => { capturedOnActivate?.(makeEntry("e1")); });
    expect(lastEntryIdPassedToHook).toBe("e1");

    // Trigger: change view
    rerender(<PasswordDashboard view="favorites" />);

    // Assert: activeEntry cleared
    expect(lastEntryIdPassedToHook).toBeNull();
  });

  it("INV-C4.2: changing tagId clears activeEntry", () => {
    const { rerender } = render(<PasswordDashboard view="all" tagId={null} />);

    act(() => { capturedOnActivate?.(makeEntry("e2")); });
    expect(lastEntryIdPassedToHook).toBe("e2");

    rerender(<PasswordDashboard view="all" tagId="tag-1" />);

    expect(lastEntryIdPassedToHook).toBeNull();
  });

  it("INV-C4.2: changing folderId clears activeEntry", () => {
    const { rerender } = render(<PasswordDashboard view="all" folderId={null} />);

    act(() => { capturedOnActivate?.(makeEntry("e3")); });
    expect(lastEntryIdPassedToHook).toBe("e3");

    rerender(<PasswordDashboard view="all" folderId="folder-1" />);

    expect(lastEntryIdPassedToHook).toBeNull();
  });

  it("INV-C4.2: changing entryType clears activeEntry", () => {
    const { rerender } = render(<PasswordDashboard view="all" entryType={null} />);

    act(() => { capturedOnActivate?.(makeEntry("e4")); });
    expect(lastEntryIdPassedToHook).toBe("e4");

    rerender(<PasswordDashboard view="all" entryType="CREDIT_CARD" />);

    expect(lastEntryIdPassedToHook).toBeNull();
  });

  // ── INV-C4.3: onEntryRemoved ─────────────────────────────────────────────────

  it("INV-C4.3: onEntryRemoved with matching id clears activeEntry", () => {
    render(<PasswordDashboard view="all" />);

    // Precondition: entry e5 is active
    act(() => { capturedOnActivate?.(makeEntry("e5")); });
    expect(lastEntryIdPassedToHook).toBe("e5");

    // Trigger: entry e5 is removed
    act(() => { capturedOnEntryRemoved?.("e5"); });

    // Assert: activeEntry cleared
    expect(lastEntryIdPassedToHook).toBeNull();
  });

  it("INV-C4.3: onEntryRemoved with NON-matching id does NOT clear activeEntry", () => {
    render(<PasswordDashboard view="all" />);

    // Precondition: entry e5 is active
    act(() => { capturedOnActivate?.(makeEntry("e5")); });
    expect(lastEntryIdPassedToHook).toBe("e5");

    // Trigger: a DIFFERENT entry is removed
    act(() => { capturedOnEntryRemoved?.("e99"); });

    // Assert: activeEntry still e5
    expect(lastEntryIdPassedToHook).toBe("e5");
  });

  // ── INV-C4.4: keyboard arrow nav does not fire from within an input ──────────
  // INV-C7.2: The handler guards on inInput (target.tagName === "INPUT").
  // We test by directly firing keyDown on an INPUT element that is a descendant
  // of the list pane container. The event bubbles up to listPaneDiv, but
  // the inInput check sees target=INPUT and returns early.

  it("INV-C7.2: ArrowDown fired from an input element inside the list pane does not move activeEntry", () => {
    setMockLayoutMode("master-detail");
    render(<PasswordDashboard view="all" />);

    // Populate visible entries
    act(() => {
      capturedOnVisibleEntriesChange?.([makeEntry("e1"), makeEntry("e2")]);
    });

    const shellEl = screen.getByTestId("master-detail-shell");
    const listPaneDiv = shellEl.firstChild as HTMLElement;

    // Add an input inside the list pane (simulates search input inside the pane)
    const input = document.createElement("input");
    listPaneDiv.appendChild(input);

    // Fire ArrowDown directly on the input — it bubbles up to listPaneDiv's onKeyDown
    // with e.target = input, which matches the inInput guard
    fireEvent.keyDown(input, { key: "ArrowDown", bubbles: true });

    // Because inInput guard fires, arrow nav debounce is NOT set.
    // lastEntryIdPassedToHook should remain null (no entry activated).
    expect(lastEntryIdPassedToHook).toBeNull();

    listPaneDiv.removeChild(input);
  });

  // ── INV-C7.4: ArrowDown keyboard nav (debounce) ────────────────────────────
  // The debounce (~150ms) coalesces rapid keypresses so only one setActiveEntry call
  // fires for N rapid keypresses within the window. We test this by spying on
  // setTimeout: with debounce, N keypresses should call setTimeout N times (each
  // keypress resets the timer) but the callback fires ONCE. Without debounce,
  // the navigation logic runs synchronously on each keypress.
  //
  // The mutation-resistant assertion: spy on the global setTimeout to count calls.
  // With debounce: N keypresses → N setTimeout calls, 1 execution.
  // Without debounce (mutation): 0 setTimeout calls.
  //
  // VERIFY by mutation: removing the setTimeout debounce (making it immediate) must
  // make this test fail.

  it("INV-C7.4: holding ArrowDown fires getDetail fewer times than keypresses (debounce coalesces)", async () => {
    vi.useFakeTimers();
    setMockLayoutMode("master-detail");

    // Reset history before the test so we get a clean slate.
    entryIdHistory.length = 0;

    try {
      render(<PasswordDashboard view="all" />);

      const entries = [makeEntry("e1"), makeEntry("e2"), makeEntry("e3"), makeEntry("e4")];
      act(() => { capturedOnVisibleEntriesChange?.(entries); });

      const shellEl = screen.getByTestId("master-detail-shell");
      const listPaneDiv = shellEl.firstChild as HTMLElement;

      // Add role="option" rows that the handler can find via querySelectorAll.
      // Mark each row with its index in aria-label so we can disambiguate.
      const rows: HTMLElement[] = [];
      for (const e of entries) {
        const row = document.createElement("div");
        row.setAttribute("role", "option");
        row.setAttribute("data-entry-id", e.id);
        listPaneDiv.appendChild(row);
        rows.push(row);
      }

      // Spy on setTimeout to count how many timers are scheduled by the debounce.
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const setTimeoutCallsBefore = setTimeoutSpy.mock.calls.length;

      // Rapid fire: 4 ArrowDown keypresses within the 150ms debounce window.
      // Each keypress cancels the previous timer and schedules a new one (debounce).
      const PRESS_COUNT = 4;
      for (let i = 0; i < PRESS_COUNT; i++) {
        fireEvent.keyDown(listPaneDiv, { key: "ArrowDown" });
      }

      // The debounce must have called setTimeout at least once per keypress
      // (each keypress cancels + reschedules).
      const setTimeoutCallsDuringPresses =
        setTimeoutSpy.mock.calls.length - setTimeoutCallsBefore;
      expect(setTimeoutCallsDuringPresses).toBeGreaterThanOrEqual(PRESS_COUNT);

      // Advance past the debounce window — only ONE timeout fires (the last one).
      act(() => { vi.advanceTimersByTime(200); });

      // After debounce: one entry was activated (the coalesced result).
      expect(lastEntryIdPassedToHook).toBe("e1");

      // T2 key assertion: despite 4 keypresses, only 1 entryId transition occurred.
      // With the debounce, only the final timer fires → 1 state change.
      // VERIFY by mutation: removing setTimeout makes setTimeoutCallsDuringPresses = 0,
      // which fails the assertion above.
      const nonNullTransitions = entryIdHistory.filter((id) => id !== null);
      expect(nonNullTransitions.length).toBeGreaterThanOrEqual(1);
      expect(nonNullTransitions.length).toBeLessThan(PRESS_COUNT);

      // Cleanup rows
      for (const row of rows) listPaneDiv.removeChild(row);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── INV-C2.1: pane is keyed by activeEntry.id ─────────────────────────────────

  it("INV-C2.1: switching activeEntry changes the detail pane (different entry id rendered)", () => {
    render(<PasswordDashboard view="all" />);

    // Activate entry e1
    act(() => { capturedOnActivate?.(makeEntry("e1")); });
    expect(screen.getByTestId("detail-pane")).toHaveAttribute("data-entry-id", "e1");

    // Activate entry e2 — pane should reflect e2
    act(() => { capturedOnActivate?.(makeEntry("e2")); });
    expect(screen.getByTestId("detail-pane")).toHaveAttribute("data-entry-id", "e2");
  });

  // ── T5: Esc stopPropagation (INV-C7.3) ───────────────────────────────────────
  // Esc on the list-pane container must call stopPropagation() so the global
  // window-level Esc cascade (clear search / exit selection) does not also fire.
  // VERIFY by mutation: removing the stopPropagation() call in handleListKeyDown
  // must make this test fail.

  it("T5 INV-C7.3: Esc on list pane calls stopPropagation (prevents global Esc cascade)", () => {
    setMockLayoutMode("master-detail");
    render(<PasswordDashboard view="all" />);

    act(() => { capturedOnActivate?.(makeEntry("e1")); });

    const shellEl = screen.getByTestId("master-detail-shell");
    const listPaneDiv = shellEl.firstChild as HTMLElement;

    // Create a real KeyboardEvent so we can spy on stopPropagation.
    const escEvent = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    const stopPropSpy = vi.spyOn(escEvent, "stopPropagation");

    act(() => { listPaneDiv.dispatchEvent(escEvent); });

    // INV-C7.3: stopPropagation must have been called so the global cascade is blocked.
    expect(stopPropSpy).toHaveBeenCalled();
  });

  // ── T7: INV-C5.4 — breakpoint flip does not trigger extra getDetail ───────────
  // Crossing the lg breakpoint re-renders with a different layoutMode but the same
  // activeEntry.id, so the hook must receive the same entryId and not add a new call.
  // VERIFY by mutation: if the re-render caused a new getDetail-relevant state change
  // (e.g. re-seeding or clearing activeEntry), the entryId seen by the hook would change.

  it("T7 INV-C5.4: breakpoint flip does not change entryId seen by hook or add extra getDetail calls", () => {
    // Start in accordion mode
    mockLayoutModeValue = "accordion";
    const { rerender } = render(<PasswordDashboard view="all" />);

    // Activate an entry in accordion mode
    act(() => { capturedOnActivate?.(makeEntry("e-breakpoint")); });
    expect(lastEntryIdPassedToHook).toBe("e-breakpoint");

    // Record the number of distinct entryId transitions so far
    const transitionsBefore = entryIdHistory.length;

    // Flip to master-detail mode (simulates crossing the lg breakpoint)
    setMockLayoutMode("master-detail");
    act(() => {
      rerender(<PasswordDashboard view="all" />);
    });

    // Assert: entryId passed to hook is UNCHANGED (same entry, no re-seed, no clear)
    expect(lastEntryIdPassedToHook).toBe("e-breakpoint");

    // Assert: no additional entryId TRANSITIONS recorded (the flip did not emit a
    // new distinct entryId value — same "e-breakpoint" was already the last value)
    expect(entryIdHistory.length).toBe(transitionsBefore);
  });
});
