import { describe, expect, it, vi } from "vitest";
import { buildTeamFormSectionsProps } from "@/hooks/team-form-sections-props";
import type { TeamPasswordFormState } from "@/hooks/use-team-password-form-state";

describe("buildTeamFormSectionsProps", () => {
  it("maps tags/folders and action bar props", () => {
    const state = createState();
    const result = buildTeamFormSectionsProps({
      teamId: "team-1",
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
      repromptTitle: "Reprompt",
      repromptDescription: "Reprompt desc",
      expirationTitle: "Expiration",
      expirationDescription: "Expiration desc",
      onCancel: vi.fn(),
      values: state.values,
      setters: state.setters,
    });

    expect(result.tagsAndFolderProps.teamId).toBe("team-1");
    expect(result.tagsAndFolderProps.onTagsChange).toBe(state.setters.setSelectedTags);
    expect(result.actionBarProps.hasChanges).toBe(true);
    expect(result.actionBarProps.saveLabel).toBe("save");
    expect(result.customFieldsTotpProps).not.toBeNull();
  });

  it("omits custom fields/totp props when entry is not login", () => {
    const state = createState();
    const result = buildTeamFormSectionsProps({
      teamId: "team-1",
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
      repromptTitle: "Reprompt",
      repromptDescription: "Reprompt desc",
      expirationTitle: "Expiration",
      expirationDescription: "Expiration desc",
      onCancel: vi.fn(),
      values: state.values,
      setters: state.setters,
    });

    expect(result.customFieldsTotpProps).toBeNull();
    expect(result.actionBarProps.submitDisabled).toBe(true);
    expect(result.actionBarProps.submitting).toBe(true);
  });

  it("returns repromptSectionProps and expirationSectionProps", () => {
    const state = createState();
    const result = buildTeamFormSectionsProps({
      teamId: "team-1",
      tagsTitle: "tags",
      tagsHint: "hint",
      folders: [],
      sectionCardClass: "flat",
      isLoginEntry: true,
      hasChanges: false,
      saving: false,
      submitDisabled: false,
      saveLabel: "save",
      cancelLabel: "cancel",
      statusUnsavedLabel: "unsaved",
      statusSavedLabel: "saved",
      repromptTitle: "Reprompt",
      repromptDescription: "Reprompt desc",
      expirationTitle: "Expiration",
      expirationDescription: "Expiration desc",
      onCancel: vi.fn(),
      values: state.values,
      setters: state.setters,
    });

    expect(result.repromptSectionProps.title).toBe("Reprompt");
    expect(result.repromptSectionProps.description).toBe("Reprompt desc");
    expect(result.repromptSectionProps.checked).toBe(false);
    expect(result.repromptSectionProps.onCheckedChange).toBe(state.setters.setRequireReprompt);
    expect(result.expirationSectionProps.title).toBe("Expiration");
    expect(result.expirationSectionProps.description).toBe("Expiration desc");
    expect(result.expirationSectionProps.value).toBeNull();
    expect(result.expirationSectionProps.onChange).toBe(state.setters.setExpiresAt);
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
      requireReprompt: false,
      expiresAt: null,
    } as TeamPasswordFormState["values"],
    setters: {
      setSelectedTags: vi.fn(),
      setTeamFolderId: vi.fn(),
      setCustomFields: vi.fn(),
      setTotp: vi.fn(),
      setShowTotpInput: vi.fn(),
      setRequireReprompt: vi.fn(),
      setExpiresAt: vi.fn(),
    } as TeamPasswordFormState["setters"],
  };
}
