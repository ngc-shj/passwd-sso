import { describe, expect, it, vi } from "vitest";
import { buildTeamFormSectionsProps } from "@/hooks/team-form-sections-props";
import type { TeamPasswordFormState } from "@/hooks/use-team-password-form-state";

describe("buildTeamFormSectionsProps", () => {
  it("maps tags/folders and action bar props", () => {
    const state = createState();
    const result = buildTeamFormSectionsProps({
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
    });

    expect(result.tagsAndFolderProps.orgId).toBe("org-1");
    expect(result.tagsAndFolderProps.onTagsChange).toBe(state.setters.setSelectedTags);
    expect(result.actionBarProps.hasChanges).toBe(true);
    expect(result.actionBarProps.saveLabel).toBe("save");
    expect(result.customFieldsTotpProps).not.toBeNull();
  });

  it("omits custom fields/totp props when entry is not login", () => {
    const state = createState();
    const result = buildTeamFormSectionsProps({
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
    });

    expect(result.customFieldsTotpProps).toBeNull();
    expect(result.actionBarProps.submitDisabled).toBe(true);
    expect(result.actionBarProps.submitting).toBe(true);
  });
});

function createState(): Pick<TeamPasswordFormState, "values" | "setters"> {
  return {
    values: {
      selectedTags: [],
      teamFolderId: null,
      customFields: [],
      totp: null,
      showTotpInput: false,
    } as TeamPasswordFormState["values"],
    setters: {
      setSelectedTags: vi.fn(),
      setOrgFolderId: vi.fn(),
      setCustomFields: vi.fn(),
      setTotp: vi.fn(),
      setShowTotpInput: vi.fn(),
    } as TeamPasswordFormState["setters"],
  };
}
