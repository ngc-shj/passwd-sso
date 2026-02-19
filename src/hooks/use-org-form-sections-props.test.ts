// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useOrgFormSectionsProps } from "@/hooks/use-org-form-sections-props";
import type { OrgPasswordFormState } from "@/hooks/use-org-password-form-state";

describe("useOrgFormSectionsProps", () => {
  it("maps tags/folders and action bar props", () => {
    const state = createState();
    const { result } = renderHook(() =>
      useOrgFormSectionsProps({
        orgId: "org-1",
        tagsTitle: "tags",
        tagsHint: "hint",
        folders: [],
        sectionCardClass: "flat",
        isLoginEntry: true,
        hasChanges: true,
        saving: false,
        submitDisabled: false,
        saveLabel: "save",
        cancelLabel: "cancel",
        statusUnsavedLabel: "unsaved",
        statusSavedLabel: "saved",
        onCancel: vi.fn(),
        values: state.values,
        setters: state.setters,
      }),
    );

    expect(result.current.tagsAndFolderProps.orgId).toBe("org-1");
    expect(result.current.tagsAndFolderProps.onTagsChange).toBe(state.setters.setSelectedTags);
    expect(result.current.actionBarProps.hasChanges).toBe(true);
    expect(result.current.actionBarProps.saveLabel).toBe("save");
    expect(result.current.customFieldsTotpProps).not.toBeNull();
  });

  it("omits custom fields/totp props when entry is not login", () => {
    const state = createState();
    const { result } = renderHook(() =>
      useOrgFormSectionsProps({
        orgId: "org-1",
        tagsTitle: "tags",
        tagsHint: "hint",
        folders: [],
        sectionCardClass: "flat",
        isLoginEntry: false,
        hasChanges: false,
        saving: true,
        submitDisabled: true,
        saveLabel: "save",
        cancelLabel: "cancel",
        statusUnsavedLabel: "unsaved",
        statusSavedLabel: "saved",
        onCancel: vi.fn(),
        values: state.values,
        setters: state.setters,
      }),
    );

    expect(result.current.customFieldsTotpProps).toBeNull();
    expect(result.current.actionBarProps.submitDisabled).toBe(true);
    expect(result.current.actionBarProps.submitting).toBe(true);
  });
});

function createState(): Pick<OrgPasswordFormState, "values" | "setters"> {
  return {
    values: {
      selectedTags: [],
      orgFolderId: null,
      customFields: [],
      totp: null,
      showTotpInput: false,
    } as OrgPasswordFormState["values"],
    setters: {
      setSelectedTags: vi.fn(),
      setOrgFolderId: vi.fn(),
      setCustomFields: vi.fn(),
      setTotp: vi.fn(),
      setShowTotpInput: vi.fn(),
    } as OrgPasswordFormState["setters"],
  };
}
