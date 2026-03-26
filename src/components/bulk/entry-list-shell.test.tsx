// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { EntryListShell, type EntrySelectionState } from "@/components/bulk/entry-list-shell";

const entries = [
  { id: "1", title: "Entry 1" },
  { id: "2", title: "Entry 2" },
];

const baseProps = {
  entries,
  selectionMode: false,
  selectedIds: new Set<string>(),
  atLimit: false,
  onToggleSelectOne: vi.fn(),
  selectEntryLabel: (title: string) => `Select ${title}`,
  renderEntry: (entry: { id: string; title: string }) => <div>{entry.title}</div>,
  floatingActions: <button>Bulk Action</button>,
  confirmDialog: {
    open: false,
    onOpenChange: vi.fn(),
    title: "Confirm",
    description: "Are you sure?",
    cancelLabel: "Cancel",
    confirmLabel: "OK",
    processing: false,
    onConfirm: vi.fn(),
  },
};

describe("EntryListShell", () => {
  describe("external checkbox mode (default)", () => {
    it("renders entries without checkboxes when selectionMode is false", () => {
      render(<EntryListShell {...baseProps} />);
      expect(screen.getByText("Entry 1")).toBeDefined();
      expect(screen.getByText("Entry 2")).toBeDefined();
      expect(screen.queryByRole("checkbox")).toBeNull();
    });

    it("renders checkboxes when selectionMode is true", () => {
      render(
        <EntryListShell
          {...baseProps}
          selectionMode={true}
          selectedIds={new Set(["1"])}
        />,
      );
      const checkboxes = screen.getAllByRole("checkbox");
      expect(checkboxes).toHaveLength(2);
    });

    it("disables unselected checkboxes when atLimit is true", () => {
      render(
        <EntryListShell
          {...baseProps}
          selectionMode={true}
          selectedIds={new Set(["1"])}
          atLimit={true}
        />,
      );
      const checkboxes = screen.getAllByRole("checkbox");
      // Entry 1 is selected — not disabled
      expect(checkboxes[0].getAttribute("data-disabled")).toBeNull();
      // Entry 2 is not selected — disabled due to atLimit
      expect(checkboxes[1].getAttribute("data-disabled")).not.toBeNull();
    });

    it("sets aria-label from selectEntryLabel", () => {
      render(
        <EntryListShell
          {...baseProps}
          selectionMode={true}
        />,
      );
      expect(screen.getByLabelText("Select Entry 1")).toBeDefined();
      expect(screen.getByLabelText("Select Entry 2")).toBeDefined();
    });
  });

  describe("custom checkbox mode", () => {
    it("passes selection state to renderEntry when selectionMode is true", () => {
      const renderEntry = vi.fn(
        (_entry: { id: string; title: string }, selection: EntrySelectionState | null) => (
          <div>
            {selection && <input type="checkbox" checked={selection.checked} readOnly />}
            {_entry.title}
          </div>
        ),
      );

      render(
        <EntryListShell
          {...baseProps}
          checkboxPlacement="custom"
          selectionMode={true}
          selectedIds={new Set(["1"])}
          renderEntry={renderEntry}
        />,
      );

      expect(renderEntry).toHaveBeenCalledTimes(2);
      // First call: entry 1, selection non-null with checked=true
      expect(renderEntry.mock.calls[0][1]).not.toBeNull();
      expect(renderEntry.mock.calls[0][1]!.checked).toBe(true);
      // Second call: entry 2, selection non-null with checked=false
      expect(renderEntry.mock.calls[1][1]).not.toBeNull();
      expect(renderEntry.mock.calls[1][1]!.checked).toBe(false);
    });

    it("passes null selection when selectionMode is false", () => {
      const renderEntry = vi.fn(
        (_entry: { id: string; title: string }, _selection: EntrySelectionState | null) => (
          <div>{_entry.title}</div>
        ),
      );

      render(
        <EntryListShell
          {...baseProps}
          checkboxPlacement="custom"
          selectionMode={false}
          renderEntry={renderEntry}
        />,
      );

      expect(renderEntry.mock.calls[0][1]).toBeNull();
    });
  });

  describe("FloatingActionBar visibility", () => {
    it("hides action bar when selectionMode is false", () => {
      render(
        <EntryListShell
          {...baseProps}
          selectionMode={false}
          selectedIds={new Set(["1"])}
        />,
      );
      expect(screen.queryByText("Bulk Action")).toBeNull();
    });

    it("hides action bar when no items selected", () => {
      render(
        <EntryListShell
          {...baseProps}
          selectionMode={true}
          selectedIds={new Set()}
        />,
      );
      expect(screen.queryByText("Bulk Action")).toBeNull();
    });

    it("shows action bar when selectionMode is true and items are selected", () => {
      render(
        <EntryListShell
          {...baseProps}
          selectionMode={true}
          selectedIds={new Set(["1"])}
        />,
      );
      expect(screen.getByText("Bulk Action")).toBeDefined();
    });
  });

  describe("children", () => {
    it("renders children after confirm dialog", () => {
      render(
        <EntryListShell {...baseProps}>
          <div>Edit Dialog</div>
        </EntryListShell>,
      );
      expect(screen.getByText("Edit Dialog")).toBeDefined();
    });
  });
});
