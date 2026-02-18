// @vitest-environment jsdom
/**
 * FolderDialog — Component behavior tests
 *
 * Covers:
 *   - Create mode: title, empty submit button disabled, successful submit
 *   - Edit mode: form pre-filled with editFolder values, title changes
 *   - Submit failure: dialog stays open (onOpenChange not called with false)
 *   - Cancel: calls onOpenChange(false)
 *   - Self-folder excluded from parent select in edit mode
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// ── Hoisted mocks ──────────────────────────────────────────

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

// Simplified Dialog — render content directly when open
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2 data-testid="dialog-title">{children}</h2>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div data-testid="dialog-footer">{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, disabled, onClick, ...rest }: React.ComponentProps<"button">) => (
    <button disabled={disabled} onClick={onClick} {...rest}>{children}</button>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: ({ id, value, onChange, onKeyDown, ...rest }: React.ComponentProps<"input">) => (
    <input id={id} value={value} onChange={onChange} onKeyDown={onKeyDown} {...rest} />
  ),
}));

vi.mock("@/components/ui/label", () => ({
  Label: ({ children, ...rest }: React.ComponentProps<"label">) => (
    <label {...rest}>{children}</label>
  ),
}));

// Simplified Select — render a native select for testing
vi.mock("@/components/ui/select", () => ({
  Select: ({ children, value, onValueChange }: { children: React.ReactNode; value: string; onValueChange: (v: string) => void }) => (
    <div data-testid="select-root" data-value={value}>
      <select data-testid="parent-select" value={value} onChange={(e) => onValueChange(e.target.value)}>
        {children}
      </select>
    </div>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectValue: () => null,
}));

import { FolderDialog } from "./folder-dialog";
import type { FolderItem } from "./folder-tree";

// ── Helpers ────────────────────────────────────────────────

const folders: FolderItem[] = [
  { id: "f1", name: "Work", parentId: null, sortOrder: 0, entryCount: 3 },
  { id: "f2", name: "Personal", parentId: null, sortOrder: 1, entryCount: 1 },
];

describe("FolderDialog", () => {
  let mockOnOpenChange: ReturnType<typeof vi.fn>;
  let mockOnSubmit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockOnOpenChange = vi.fn();
    mockOnSubmit = vi.fn().mockResolvedValue(undefined);
  });

  // ── Create mode ──────────────────────────────────────────

  describe("create mode", () => {
    it("shows create title and empty form", () => {
      render(
        <FolderDialog
          open={true}
          onOpenChange={mockOnOpenChange}
          folders={folders}
          onSubmit={mockOnSubmit}
        />,
      );

      expect(screen.getByTestId("dialog-title")).toHaveTextContent("createFolder");
      const input = screen.getByRole("textbox");
      expect(input).toHaveValue("");
    });

    it("disables submit button when name is empty", () => {
      render(
        <FolderDialog
          open={true}
          onOpenChange={mockOnOpenChange}
          folders={folders}
          onSubmit={mockOnSubmit}
        />,
      );

      const buttons = screen.getAllByRole("button");
      const submitBtn = buttons.find((b) => b.textContent === "create");
      expect(submitBtn).toBeDisabled();
    });

    it("calls onSubmit and closes dialog on successful submit", async () => {
      render(
        <FolderDialog
          open={true}
          onOpenChange={mockOnOpenChange}
          folders={folders}
          onSubmit={mockOnSubmit}
        />,
      );

      const input = screen.getByRole("textbox");
      fireEvent.change(input, { target: { value: "New Folder" } });

      const submitBtn = screen.getAllByRole("button").find((b) => b.textContent === "create")!;
      fireEvent.click(submitBtn);

      await waitFor(() => {
        expect(mockOnSubmit).toHaveBeenCalledWith({
          name: "New Folder",
          parentId: null,
        });
      });

      expect(mockOnOpenChange).toHaveBeenCalledWith(false);
    });
  });

  // ── Edit mode ──────────────────────────────────────────

  describe("edit mode", () => {
    const editFolder: FolderItem = {
      id: "f1",
      name: "Work",
      parentId: null,
      sortOrder: 0,
      entryCount: 3,
    };

    it("shows edit title and pre-filled name", () => {
      render(
        <FolderDialog
          open={true}
          onOpenChange={mockOnOpenChange}
          folders={folders}
          editFolder={editFolder}
          onSubmit={mockOnSubmit}
        />,
      );

      expect(screen.getByTestId("dialog-title")).toHaveTextContent("editFolder");
      const input = screen.getByRole("textbox");
      expect(input).toHaveValue("Work");
    });

    it("shows save button instead of create", () => {
      render(
        <FolderDialog
          open={true}
          onOpenChange={mockOnOpenChange}
          folders={folders}
          editFolder={editFolder}
          onSubmit={mockOnSubmit}
        />,
      );

      const buttons = screen.getAllByRole("button");
      const submitBtn = buttons.find((b) => b.textContent === "save");
      expect(submitBtn).toBeDefined();
      expect(submitBtn).not.toBeDisabled();
    });

    it("excludes self from parent folder select", () => {
      render(
        <FolderDialog
          open={true}
          onOpenChange={mockOnOpenChange}
          folders={folders}
          editFolder={editFolder}
          onSubmit={mockOnSubmit}
        />,
      );

      const options = screen.getAllByRole("option");
      const optionValues = options.map((o) => o.getAttribute("value"));
      // Should have __root__ and f2 (Personal) but NOT f1 (Work = self)
      expect(optionValues).toContain("__root__");
      expect(optionValues).toContain("f2");
      expect(optionValues).not.toContain("f1");
    });
  });

  // ── Error handling ──────────────────────────────────────

  describe("error handling", () => {
    it("keeps dialog open when onSubmit throws", async () => {
      mockOnSubmit.mockRejectedValue(new Error("API error"));

      render(
        <FolderDialog
          open={true}
          onOpenChange={mockOnOpenChange}
          folders={folders}
          onSubmit={mockOnSubmit}
        />,
      );

      const input = screen.getByRole("textbox");
      fireEvent.change(input, { target: { value: "Duplicate" } });

      const submitBtn = screen.getAllByRole("button").find((b) => b.textContent === "create")!;
      fireEvent.click(submitBtn);

      await waitFor(() => {
        expect(mockOnSubmit).toHaveBeenCalled();
      });

      // onOpenChange(false) should NOT have been called — dialog stays open
      expect(mockOnOpenChange).not.toHaveBeenCalledWith(false);
    });
  });

  // ── Cancel ────────────────────────────────────────────────

  describe("cancel", () => {
    it("calls onOpenChange(false) when cancel is clicked", () => {
      render(
        <FolderDialog
          open={true}
          onOpenChange={mockOnOpenChange}
          folders={folders}
          onSubmit={mockOnSubmit}
        />,
      );

      const cancelBtn = screen.getAllByRole("button").find((b) => b.textContent === "cancel")!;
      fireEvent.click(cancelBtn);

      expect(mockOnOpenChange).toHaveBeenCalledWith(false);
    });
  });

  // ── IME guard ──────────────────────────────────────────────

  describe("IME composition", () => {
    it("does not trigger submit when Enter is pressed during IME composition", async () => {
      render(
        <FolderDialog
          open={true}
          onOpenChange={mockOnOpenChange}
          folders={folders}
          onSubmit={mockOnSubmit}
        />,
      );

      const input = screen.getByRole("textbox");
      fireEvent.change(input, { target: { value: "テスト" } });

      // Simulate Enter during IME composition (isComposing: true)
      const composingEnter = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        isComposing: true,
      });
      input.dispatchEvent(composingEnter);

      // Give time for any async handlers
      await new Promise((r) => setTimeout(r, 50));

      expect(mockOnSubmit).not.toHaveBeenCalled();
    });

    it("triggers submit when Enter is pressed after IME composition is done", async () => {
      render(
        <FolderDialog
          open={true}
          onOpenChange={mockOnOpenChange}
          folders={folders}
          onSubmit={mockOnSubmit}
        />,
      );

      const input = screen.getByRole("textbox");
      fireEvent.change(input, { target: { value: "テスト" } });

      // Normal Enter (isComposing: false)
      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() => {
        expect(mockOnSubmit).toHaveBeenCalledWith({
          name: "テスト",
          parentId: null,
        });
      });
    });
  });

  // ── Not rendered when closed ──────────────────────────────

  it("renders nothing when open is false", () => {
    render(
      <FolderDialog
        open={false}
        onOpenChange={mockOnOpenChange}
        folders={folders}
        onSubmit={mockOnSubmit}
      />,
    );

    expect(screen.queryByTestId("dialog")).toBeNull();
  });
});
