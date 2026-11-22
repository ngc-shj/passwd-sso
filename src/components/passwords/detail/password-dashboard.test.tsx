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

import { render, screen, act, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { forwardRef } from "react";
import type { DisplayEntry } from "./password-list";

// PasswordList is a thin wrapper over EntryListView; the dashboard delegates the
// entire list/detail/selection/keyboard-nav surface to it. These tests verify the
// dashboard's REMAINING responsibilities: choosing the descriptor flags, wiring the
// header "Select" button to the imperative handle, and hosting the edit dialog.
// (The moved behaviors — active-entry, detail decrypt, keyboard nav — are tested in
// entry-list-view.test.tsx.)

const {
  enterSelectionModeSpy,
  exitSelectionModeSpy,
  toggleSelectAllSpy,
  listProps,
  newDialogProps,
  sidebar,
} = vi.hoisted(() => ({
  enterSelectionModeSpy: vi.fn(),
  exitSelectionModeSpy: vi.fn(),
  toggleSelectAllSpy: vi.fn(),
  listProps: { current: undefined as Record<string, unknown> | undefined },
  newDialogProps: {
    current: undefined as
      | { open: boolean; entryType: string; defaultFolderId: string | null; defaultTags?: unknown }
      | undefined,
  },
  sidebar: {
    folders: [] as Array<{ id: string; name: string; parentId: string | null; sortOrder: number; entryCount: number }>,
    tags: [] as Array<{ id: string; name: string; color: string | null; parentId: string | null }>,
  },
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

// A plain input stands in for the search bar so the dashboard's ref-driven
// focus/blur and its controlled value are observable.
vi.mock("@/components/layout/search-bar", () => ({
  SearchBar: forwardRef<HTMLInputElement, { value: string; onChange: (v: string) => void }>(
    function SearchBar({ value, onChange }, ref) {
      return (
        <input
          ref={ref}
          data-testid="search-bar"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    },
  ),
}));

vi.mock("@/components/passwords/detail/password-list", () => ({
  PasswordList: (props: {
    trashOnly?: boolean;
    favoritesOnly?: boolean;
    archivedOnly?: boolean;
    onRequestEdit?: (entry: DisplayEntry) => void;
    selectAllRef?: { current: unknown };
  }) => {
    listProps.current = props as unknown as Record<string, unknown>;
    // Populate the imperative handle the dashboard's Select button drives.
    if (props.selectAllRef && typeof props.selectAllRef === "object") {
      props.selectAllRef.current = {
        enterSelectionMode: enterSelectionModeSpy,
        exitSelectionMode: exitSelectionModeSpy,
        toggleSelectAll: toggleSelectAllSpy,
      };
    }
    return (
      <div
        data-testid="password-list"
        data-trash-only={props.trashOnly ? "true" : "false"}
        data-favorites-only={props.favoritesOnly ? "true" : "false"}
        data-archived-only={props.archivedOnly ? "true" : "false"}
      />
    );
  },
}));

vi.mock("@/components/passwords/dialogs/personal-password-new-dialog", () => ({
  PasswordNewDialog: (props: {
    open: boolean;
    entryType: string;
    defaultFolderId: string | null;
    defaultTags?: unknown;
  }) => {
    newDialogProps.current = props;
    return props.open ? <div data-testid="new-dialog" data-entry-type={props.entryType} /> : null;
  },
}));

vi.mock("@/hooks/personal/use-personal-folders", () => ({
  usePersonalFolders: () => ({ folders: sidebar.folders }),
}));

vi.mock("@/hooks/personal/use-personal-tags", () => ({
  usePersonalTags: () => ({ tags: sidebar.tags }),
}));

vi.mock("@/components/extension/auto-extension-connect", () => ({
  isOverlayActive: () => false,
}));

let mockLayoutModeValue: "accordion" | "master-detail" = "accordion";
vi.mock("@/hooks/use-layout-mode", () => ({
  useLayoutMode: () => mockLayoutModeValue,
}));

// Edit dialog loader: render the id it was given so we can assert it opened.
vi.mock("@/components/passwords/dialogs/personal-password-edit-dialog-loader", () => ({
  PasswordEditDialogLoader: ({ id, open }: { id: string; open: boolean }) =>
    open ? <div data-testid="edit-dialog" data-edit-id={id} /> : null,
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { PasswordDashboard } from "./password-dashboard";

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
    mockLayoutModeValue = "accordion";
    enterSelectionModeSpy.mockReset();
    exitSelectionModeSpy.mockReset();
    listProps.current = undefined;
    newDialogProps.current = undefined;
    toggleSelectAllSpy.mockReset();
    sidebar.folders = [];
    sidebar.tags = [];
  });

  // ── Descriptor-flag selection ────────────────────────────────────────────────

  it("renders the search bar and a non-trash list for the all view", () => {
    render(<PasswordDashboard view="all" />);

    expect(screen.getByTestId("search-bar")).toBeInTheDocument();
    const list = screen.getByTestId("password-list");
    expect(list).toHaveAttribute("data-trash-only", "false");
    expect(list).toHaveAttribute("data-favorites-only", "false");
    expect(list).toHaveAttribute("data-archived-only", "false");
  });

  it("selects TRASH_VIEW (trashOnly) for the trash view", () => {
    render(<PasswordDashboard view="trash" />);
    expect(screen.getByTestId("password-list")).toHaveAttribute("data-trash-only", "true");
  });

  it("selects FAVORITES_VIEW (favoritesOnly) and subtitle for the favorites view", () => {
    render(<PasswordDashboard view="favorites" />);
    expect(screen.getByTestId("password-list")).toHaveAttribute("data-favorites-only", "true");
    expect(screen.getByText("favorites")).toBeInTheDocument();
  });

  it("selects ARCHIVE_VIEW (archivedOnly) for the archive view", () => {
    render(<PasswordDashboard view="archive" />);
    expect(screen.getByTestId("password-list")).toHaveAttribute("data-archived-only", "true");
  });

  // ── Select button → imperative handle (F9) ───────────────────────────────────

  it("Select button enters selection mode via the list's imperative handle", () => {
    render(<PasswordDashboard view="all" />);

    fireEvent.click(screen.getByRole("button", { name: "select" }));

    expect(enterSelectionModeSpy).toHaveBeenCalledTimes(1);
  });

  it("Close button exits selection mode via the imperative handle", () => {
    render(<PasswordDashboard view="all" />);

    // Enter selection mode (header switches to show the Close button).
    fireEvent.click(screen.getByRole("button", { name: "select" }));
    // Now the header shows the Close button.
    fireEvent.click(screen.getByRole("button", { name: "close" }));

    expect(exitSelectionModeSpy).toHaveBeenCalledTimes(1);
  });

  // ── Edit dialog hosting (container hosts dialogs, EntryListView raises request) ─

  it("opens the edit dialog for the entry raised via onRequestEdit", () => {
    render(<PasswordDashboard view="all" />);

    expect(screen.queryByTestId("edit-dialog")).not.toBeInTheDocument();

    const onRequestEdit = listProps.current?.onRequestEdit as
      | ((entry: DisplayEntry) => void)
      | undefined;
    act(() => { onRequestEdit?.(makeEntry("e1")); });

    const dialog = screen.getByTestId("edit-dialog");
    expect(dialog).toHaveAttribute("data-edit-id", "e1");
  });

  // ── New-entry creation ───────────────────────────────────────────────────────

  it.each([
    ["newPassword", "LOGIN"],
    ["newSecureNote", "SECURE_NOTE"],
    ["newCreditCard", "CREDIT_CARD"],
    ["newIdentity", "IDENTITY"],
    ["newPasskey", "PASSKEY"],
    ["newBankAccount", "BANK_ACCOUNT"],
    ["newSoftwareLicense", "SOFTWARE_LICENSE"],
    ["newSshKey", "SSH_KEY"],
  ])("the New menu's %s item opens the new dialog for %s", async (item, entryType) => {
    const user = userEvent.setup();
    render(<PasswordDashboard view="all" />);

    await user.click(screen.getByRole("button", { name: "newItem" }));
    await user.click(screen.getByRole("menuitem", { name: item }));

    expect(screen.getByTestId("new-dialog")).toHaveAttribute("data-entry-type", entryType);
  });

  it("opens the new dialog for the category being viewed without a type menu", async () => {
    const user = userEvent.setup();
    render(<PasswordDashboard view="all" entryType="CREDIT_CARD" />);

    await user.click(screen.getByRole("button", { name: "newItem" }));

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByTestId("new-dialog")).toHaveAttribute("data-entry-type", "CREDIT_CARD");
    expect(screen.getByText("catCreditCard")).toBeInTheDocument();
  });

  it.each(["trash", "archive"] as const)("offers no New button in the %s view", (view) => {
    render(<PasswordDashboard view={view} />);

    expect(screen.queryByRole("button", { name: "newItem" })).not.toBeInTheDocument();
  });

  it("titles a folder view with its path and defaults new entries into that folder", () => {
    sidebar.folders = [
      { id: "f1", name: "Work", parentId: null, sortOrder: 0, entryCount: 0 },
      { id: "f2", name: "Infra", parentId: "f1", sortOrder: 0, entryCount: 0 },
    ];
    render(<PasswordDashboard view="all" folderId="f2" />);

    expect(screen.getByText("Work / Infra")).toBeInTheDocument();
    expect(newDialogProps.current?.defaultFolderId).toBe("f2");
  });

  it("titles a tag view with its path and pre-tags new entries with it", () => {
    sidebar.tags = [{ id: "t1", name: "Finance", color: "#ff0000", parentId: null }];
    render(<PasswordDashboard view="all" tagId="t1" />);

    expect(screen.getByText("Finance")).toBeInTheDocument();
    expect(newDialogProps.current?.defaultTags).toEqual([
      { id: "t1", name: "Finance", color: "#ff0000" },
    ]);
  });

  it("passes no folder to the trash list even when a folder is selected", () => {
    render(<PasswordDashboard view="trash" folderId="f1" entryType="LOGIN" />);

    expect(listProps.current?.folderId).toBeNull();
    expect(listProps.current?.entryType).toBeNull();
  });

  // ── Keyboard shortcuts ───────────────────────────────────────────────────────

  it("opens the new dialog on N", () => {
    render(<PasswordDashboard view="all" />);

    fireEvent.keyDown(window, { key: "n" });

    expect(screen.getByTestId("new-dialog")).toHaveAttribute("data-entry-type", "LOGIN");
  });

  it("opens the new dialog for the viewed category on N", () => {
    render(<PasswordDashboard view="all" entryType="PASSKEY" />);

    fireEvent.keyDown(window, { key: "n" });

    expect(screen.getByTestId("new-dialog")).toHaveAttribute("data-entry-type", "PASSKEY");
  });

  it("ignores N in the trash view", () => {
    render(<PasswordDashboard view="trash" />);

    fireEvent.keyDown(window, { key: "n" });

    expect(screen.queryByTestId("new-dialog")).not.toBeInTheDocument();
  });

  it("ignores N typed into an input", () => {
    render(<PasswordDashboard view="all" />);

    fireEvent.keyDown(screen.getByTestId("search-bar"), { key: "n" });

    expect(screen.queryByTestId("new-dialog")).not.toBeInTheDocument();
  });

  it.each([
    ["/", {}],
    ["k", { ctrlKey: true }],
    ["k", { metaKey: true }],
  ])("focuses the search bar on %s %o", (key, modifiers) => {
    render(<PasswordDashboard view="all" />);

    fireEvent.keyDown(window, { key, ...modifiers });

    expect(screen.getByTestId("search-bar")).toHaveFocus();
  });

  it("opens the shortcut help on ?", () => {
    render(<PasswordDashboard view="all" />);

    fireEvent.keyDown(window, { key: "?" });

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("title")).toBeInTheDocument();
    expect(within(dialog).getByText("newPassword")).toBeInTheDocument();
  });

  it("clears the search and blurs it on Escape inside the search bar", () => {
    render(<PasswordDashboard view="all" />);
    const search = screen.getByTestId("search-bar");
    search.focus();
    fireEvent.change(search, { target: { value: "git" } });

    fireEvent.keyDown(search, { key: "Escape" });

    expect(search).toHaveValue("");
    expect(search).not.toHaveFocus();
  });

  it("clears the search on Escape outside the search bar", () => {
    render(<PasswordDashboard view="all" />);
    const search = screen.getByTestId("search-bar");
    fireEvent.change(search, { target: { value: "git" } });

    fireEvent.keyDown(window, { key: "Escape" });

    expect(search).toHaveValue("");
  });

  it("exits selection mode on Escape", () => {
    render(<PasswordDashboard view="all" />);
    fireEvent.click(screen.getByRole("button", { name: "select" }));

    fireEvent.keyDown(window, { key: "Escape" });

    expect(exitSelectionModeSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "select" })).toBeInTheDocument();
  });

  // ── Selection header ─────────────────────────────────────────────────────────

  it("shows the selected count and the selection limit reported by the list", () => {
    render(<PasswordDashboard view="all" />);
    fireEvent.click(screen.getByRole("button", { name: "select" }));
    const report = listProps.current?.onSelectedCountChange as (
      count: number,
      all: boolean,
      atLimit: boolean,
    ) => void;

    act(() => report(3, false, true));

    expect(screen.getByText("selectedCount")).toBeInTheDocument();
    expect(screen.getByText("selectionLimit")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "selectAll" })).not.toBeChecked();
  });

  it("toggles select-all through the list's imperative handle", () => {
    render(<PasswordDashboard view="all" />);
    fireEvent.click(screen.getByRole("button", { name: "select" }));

    fireEvent.click(screen.getByRole("checkbox", { name: "selectAll" }));

    expect(toggleSelectAllSpy).toHaveBeenCalledWith(true);
  });

  it("leaves selection mode when the view changes", () => {
    const { rerender } = render(<PasswordDashboard view="all" />);
    fireEvent.click(screen.getByRole("button", { name: "select" }));
    expect(screen.getByRole("button", { name: "close" })).toBeInTheDocument();

    rerender(<PasswordDashboard view="favorites" />);

    expect(screen.queryByRole("button", { name: "close" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "select" })).toBeInTheDocument();
  });

  // ── Refresh wiring ───────────────────────────────────────────────────────────

  it("refreshes the list when vault data changes elsewhere", () => {
    render(<PasswordDashboard view="all" />);
    const before = listProps.current?.refreshKey as number;

    act(() => {
      window.dispatchEvent(new CustomEvent("vault-data-changed"));
    });

    expect(listProps.current?.refreshKey).toBe(before + 1);
  });

  it("refreshes the list and notifies other views when the list changes data", () => {
    const heard = vi.fn();
    window.addEventListener("vault-data-changed", heard);
    render(<PasswordDashboard view="all" />);
    const before = listProps.current?.refreshKey as number;

    act(() => {
      (listProps.current?.onDataChange as () => void)();
    });

    expect(heard).toHaveBeenCalledTimes(1);
    expect(listProps.current?.refreshKey as number).toBeGreaterThan(before);
    window.removeEventListener("vault-data-changed", heard);
  });

  it("uses the master-detail layout width when the layout mode says so", () => {
    mockLayoutModeValue = "master-detail";
    const { container } = render(<PasswordDashboard view="all" />);

    expect(container.firstElementChild).toHaveClass("min-h-0");
  });
});
