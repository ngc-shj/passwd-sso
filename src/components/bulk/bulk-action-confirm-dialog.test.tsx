// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { BulkActionConfirmDialog } from "@/components/bulk/bulk-action-confirm-dialog";

describe("BulkActionConfirmDialog", () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    title: "Confirm Action",
    description: "Are you sure?",
    cancelLabel: "Cancel",
    confirmLabel: "Confirm",
    processing: false,
    onConfirm: vi.fn(),
  };

  it("renders title and description when open", () => {
    const { getByText } = render(
      <BulkActionConfirmDialog {...defaultProps} />,
    );
    expect(getByText("Confirm Action")).toBeDefined();
    expect(getByText("Are you sure?")).toBeDefined();
  });

  it("calls onConfirm when confirm button is clicked", () => {
    const onConfirm = vi.fn();
    const { getByText } = render(
      <BulkActionConfirmDialog {...defaultProps} onConfirm={onConfirm} />,
    );
    fireEvent.click(getByText("Confirm"));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("disables buttons when processing", () => {
    const { getByText } = render(
      <BulkActionConfirmDialog {...defaultProps} processing={true} />,
    );
    expect(
      (getByText("Cancel") as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
