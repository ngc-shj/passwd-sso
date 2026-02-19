// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { usePersonalFormSectionsProps } from "@/hooks/use-personal-form-sections-props";
import type { PersonalPasswordFormState } from "@/hooks/use-personal-password-form-state";

describe("usePersonalFormSectionsProps", () => {
  it("maps personal section props from state and copy", () => {
    const state = createState();
    const { result } = renderHook(() =>
      usePersonalFormSectionsProps({
        tagsTitle: "tags",
        tagsHint: "hint",
        folders: [],
        sectionCardClass: "flat",
        repromptTitle: "reprompt",
        repromptDescription: "desc",
        hasChanges: true,
        submitting: false,
        saveLabel: "save",
        cancelLabel: "cancel",
        statusUnsavedLabel: "unsaved",
        statusSavedLabel: "saved",
        onCancel: vi.fn(),
        values: state.values,
        setters: state.setters,
      }),
    );

    expect(result.current.tagsAndFolderProps.tagsTitle).toBe("tags");
    expect(result.current.tagsAndFolderProps.onTagsChange).toBe(state.setters.setSelectedTags);
    expect(result.current.customFieldsTotpProps.setCustomFields).toBe(state.setters.setCustomFields);
    expect(result.current.repromptSectionProps.checked).toBe(false);
    expect(result.current.actionBarProps.hasChanges).toBe(true);
    expect(result.current.actionBarProps.submitting).toBe(false);
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
    } as PersonalPasswordFormState["values"],
    setters: {
      setSelectedTags: vi.fn(),
      setFolderId: vi.fn(),
      setCustomFields: vi.fn(),
      setTotp: vi.fn(),
      setShowTotpInput: vi.fn(),
      setRequireReprompt: vi.fn(),
    } as PersonalPasswordFormState["setters"],
  };
}
