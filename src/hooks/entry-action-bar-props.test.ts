import { describe, expect, it, vi } from "vitest";
import { buildEntryActionBarProps } from "@/hooks/entry-action-bar-props";

describe("buildEntryActionBarProps", () => {
  it("returns default submitDisabled=false when omitted", () => {
    const onCancel = vi.fn();
    const props = buildEntryActionBarProps({
      hasChanges: true,
      submitting: false,
      saveLabel: "save",
      cancelLabel: "cancel",
      statusUnsavedLabel: "unsaved",
      statusSavedLabel: "saved",
      onCancel,
    });

    expect(props.submitDisabled).toBe(false);
    expect(props.onCancel).toBe(onCancel);
  });
});
