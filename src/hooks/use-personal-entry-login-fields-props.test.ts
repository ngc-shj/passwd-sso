// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_GENERATOR_SETTINGS } from "@/lib/generator-prefs";
import { usePersonalEntryLoginFieldsProps } from "@/hooks/use-personal-entry-login-fields-props";
import type { PersonalPasswordFormState } from "@/hooks/use-personal-password-form-state";

describe("usePersonalEntryLoginFieldsProps", () => {
  it("maps values and labels from personal form state", () => {
    const state = createState();
    const { result } = renderHook(() =>
      usePersonalEntryLoginFieldsProps({
        formState: state,
        generatorSummary: "summary",
        translations: { t: (k) => `label.${k}` },
      }),
    );

    expect(result.current.title).toBe(state.values.title);
    expect(result.current.username).toBe(state.values.username);
    expect(result.current.password).toBe(state.values.password);
    expect(result.current.notes).toBe(state.values.notes);
    expect(result.current.titleLabel).toBe("label.title");
    expect(result.current.passwordLabel).toBe("label.password");
    expect(result.current.notesLabel).toBe("label.notes");
  });

  it("toggles visibility and applies generated password", () => {
    const state = createState();
    state.values.showPassword = true;
    state.values.showGenerator = true;

    const { result } = renderHook(() =>
      usePersonalEntryLoginFieldsProps({
        formState: state,
        generatorSummary: "summary",
        translations: { t: (k) => k },
      }),
    );

    result.current.onToggleShowPassword();
    result.current.onToggleGenerator();
    expect(state.setters.setShowPassword).toHaveBeenCalledWith(false);
    expect(state.setters.setShowGenerator).toHaveBeenCalledWith(false);

    const nextSettings = { length: 42 } as typeof DEFAULT_GENERATOR_SETTINGS;
    result.current.onGeneratorUse("generated", nextSettings);
    expect(state.setters.setPassword).toHaveBeenCalledWith("generated");
    expect(state.setters.setShowPassword).toHaveBeenCalledWith(true);
    expect(state.setters.setGeneratorSettings).toHaveBeenCalledWith(nextSettings);
  });
});

function createState(): PersonalPasswordFormState {
  return {
    values: {
      showPassword: false,
      showGenerator: false,
      submitting: false,
      title: "title",
      username: "username",
      password: "password",
      url: "https://example.com",
      notes: "notes",
      selectedTags: [],
      generatorSettings: { ...DEFAULT_GENERATOR_SETTINGS },
      customFields: [],
      totp: null,
      showTotpInput: false,
      requireReprompt: false,
      folderId: null,
    },
    setters: {
      setShowPassword: vi.fn(),
      setShowGenerator: vi.fn(),
      setSubmitting: vi.fn(),
      setTitle: vi.fn(),
      setUsername: vi.fn(),
      setPassword: vi.fn(),
      setUrl: vi.fn(),
      setNotes: vi.fn(),
      setSelectedTags: vi.fn(),
      setGeneratorSettings: vi.fn(),
      setCustomFields: vi.fn(),
      setTotp: vi.fn(),
      setShowTotpInput: vi.fn(),
      setRequireReprompt: vi.fn(),
      setFolderId: vi.fn(),
    },
  };
}
