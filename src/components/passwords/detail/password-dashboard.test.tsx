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

import { render, screen, act, fireEvent } from "@testing-library/react";
import type { DisplayEntry } from "./password-list";

// PasswordList is a thin wrapper over EntryListView; the dashboard delegates the
// entire list/detail/selection/keyboard-nav surface to it. These tests verify the
// dashboard's REMAINING responsibilities: choosing the descriptor flags, wiring the
// header "Select" button to the imperative handle, and hosting the edit dialog.
// (The moved behaviors — active-entry, detail decrypt, keyboard nav — are tested in
// entry-list-view.test.tsx.)

const { enterSelectionModeSpy, exitSelectionModeSpy, listProps } = vi.hoisted(() => ({
  enterSelectionModeSpy: vi.fn(),
  exitSelectionModeSpy: vi.fn(),
  listProps: { current: undefined as Record<string, unknown> | undefined },
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/components/layout/search-bar", () => ({
  SearchBar: () => <div data-testid="search-bar" />,
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
        toggleSelectAll: vi.fn(),
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
});
