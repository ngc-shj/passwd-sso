import { describe, expect, it, vi } from "vitest";
import { buildEntryActionBarProps } from "@/hooks/entry-action-bar-props";

function buildArgs(overrides: Partial<Parameters<typeof buildEntryActionBarProps>[0]> = {}) {
  return {
    hasChanges: false,
    submitting: false,
    saveLabel: "save",
    cancelLabel: "cancel",
    statusUnsavedLabel: "unsaved",
    statusSavedLabel: "saved",
    onCancel: vi.fn(),
    ...overrides,
  };
}

describe("buildEntryActionBarProps", () => {
  it("returns default submitDisabled=false when omitted", () => {
    const props = buildEntryActionBarProps(buildArgs());
    expect(props.submitDisabled).toBe(false);
  });

  it("passes explicit submitDisabled=true through", () => {
    const props = buildEntryActionBarProps(buildArgs({ submitDisabled: true }));
    expect(props.submitDisabled).toBe(true);
  });

  it("passes hasChanges and submitting through", () => {
    const props = buildEntryActionBarProps(buildArgs({ hasChanges: true, submitting: true }));
    expect(props.hasChanges).toBe(true);
    expect(props.submitting).toBe(true);
  });

  it("passes all label strings through", () => {
    const props = buildEntryActionBarProps(buildArgs({
      saveLabel: "Save",
      cancelLabel: "Cancel",
      statusUnsavedLabel: "Unsaved",
      statusSavedLabel: "Saved",
    }));
    expect(props.saveLabel).toBe("Save");
    expect(props.cancelLabel).toBe("Cancel");
    expect(props.statusUnsavedLabel).toBe("Unsaved");
    expect(props.statusSavedLabel).toBe("Saved");
  });

  it("passes onCancel callback through", () => {
    const onCancel = vi.fn();
    const props = buildEntryActionBarProps(buildArgs({ onCancel }));
    expect(props.onCancel).toBe(onCancel);
  });
});
