import { describe, expect, it, vi } from "vitest";
import { buildPersonalFormSectionsProps } from "@/hooks/personal-form-sections-props";
import type { PersonalPasswordFormState } from "@/hooks/use-personal-password-form-state";

describe("buildPersonalFormSectionsProps", () => {
  it("maps personal section props from state and copy", () => {
    const state = createState();
    const result = buildPersonalFormSectionsProps({
      tagsTitle: "tags",
      tagsHint: "hint",
      folders: [],
      sectionCardClass: "flat",
      repromptTitle: "reprompt",
      repromptDescription: "desc",
      expirationTitle: "expiration",
      expirationDescription: "expDesc",
      hasChanges: true,
      submitting: false,
      saveLabel: "save",
      cancelLabel: "cancel",
      statusUnsavedLabel: "unsaved",
      statusSavedLabel: "saved",
      onCancel: vi.fn(),
      values: state.values,
      setters: state.setters,
    });

    expect(result.tagsAndFolderProps.tagsTitle).toBe("tags");
    expect(result.tagsAndFolderProps.onTagsChange).toBe(state.setters.setSelectedTags);
    expect(result.customFieldsTotpProps.setCustomFields).toBe(state.setters.setCustomFields);
    expect(result.repromptSectionProps.checked).toBe(false);
    expect(result.expirationSectionProps.value).toBeNull();
    expect(result.expirationSectionProps.onChange).toBe(state.setters.setExpiresAt);
    expect(result.expirationSectionProps.title).toBe("expiration");
    expect(result.actionBarProps.hasChanges).toBe(true);
    expect(result.actionBarProps.submitting).toBe(false);
  });
});

function createState(): Pick<PersonalPasswordFormState, "values" | "setters"> {
  return {
    values: {
      selectedTags: [],
      folderId: null,
      customFields: [],
      totp: null,
      showTotpInput: false,
      requireReprompt: false,
      expiresAt: null,
    } as PersonalPasswordFormState["values"],
    setters: {
      setSelectedTags: vi.fn(),
      setFolderId: vi.fn(),
      setCustomFields: vi.fn(),
      setTotp: vi.fn(),
      setShowTotpInput: vi.fn(),
      setRequireReprompt: vi.fn(),
      setExpiresAt: vi.fn(),
    } as PersonalPasswordFormState["setters"],
  };
}
