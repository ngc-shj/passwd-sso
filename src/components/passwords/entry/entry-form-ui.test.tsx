// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  EntryPrimaryCard,
  EntrySectionCard,
  EntryActionBar,
} from "./entry-form-ui";

describe("EntryPrimaryCard", () => {
  it("renders children inside the card", () => {
    render(
      <EntryPrimaryCard>
        <span>inner</span>
      </EntryPrimaryCard>,
    );
    expect(screen.getByText("inner")).toBeInTheDocument();
  });
});

describe("EntrySectionCard", () => {
  it("renders children inside the card", () => {
    render(
      <EntrySectionCard className="custom">
        <span>section</span>
      </EntrySectionCard>,
    );
    expect(screen.getByText("section")).toBeInTheDocument();
  });
});

describe("EntryActionBar", () => {
  const baseProps = {
    hasChanges: true,
    submitting: false,
    saveLabel: "Save",
    cancelLabel: "Cancel",
    statusUnsavedLabel: "Unsaved",
    statusSavedLabel: "Saved",
    onCancel: vi.fn(),
  };

  it("shows the unsaved status label when hasChanges is true", () => {
    render(<EntryActionBar {...baseProps} hasChanges={true} />);
    expect(screen.getByText("Unsaved")).toBeInTheDocument();
  });

  it("shows the saved status label when hasChanges is false", () => {
    render(<EntryActionBar {...baseProps} hasChanges={false} />);
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  // R26 — Save button has a visible disabled cue.
  it("disables Save when no changes (R26 visible cue via Button class)", () => {
    render(<EntryActionBar {...baseProps} hasChanges={false} />);
    const saveBtn = screen.getByRole("button", { name: "Save" });
    expect(saveBtn).toBeDisabled();
    expect(saveBtn.className).toMatch(/disabled:opacity-/);
  });

  it("disables Save while submitting", () => {
    render(<EntryActionBar {...baseProps} submitting={true} />);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("calls onCancel when Cancel is clicked", async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(<EntryActionBar {...baseProps} onCancel={onCancel} />);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("calls onSubmit when Save is clicked and there are changes", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(
      <EntryActionBar
        {...baseProps}
        hasChanges={true}
        submitType="button"
        onSubmit={onSubmit}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
