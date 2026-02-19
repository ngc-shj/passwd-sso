import { describe, expect, it, vi } from "vitest";
import { buildPersonalEntryLoginFieldCallbacks } from "@/hooks/personal-entry-login-fields-callbacks";
import { DEFAULT_GENERATOR_SETTINGS } from "@/lib/generator-prefs";
import type { PersonalPasswordFormState } from "@/hooks/use-personal-password-form-state";

function createState(): PersonalPasswordFormState {
  return {
    values: {
      showPassword: true,
      showGenerator: true,
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

describe("buildPersonalEntryLoginFieldCallbacks", () => {
  it("toggles flags and applies generated password", () => {
    const state = createState();
    const callbacks = buildPersonalEntryLoginFieldCallbacks(
      state.values,
      state.setters,
    );

    callbacks.onToggleShowPassword();
    callbacks.onToggleGenerator();
    expect(state.setters.setShowPassword).toHaveBeenCalledWith(false);
    expect(state.setters.setShowGenerator).toHaveBeenCalledWith(false);

    const nextSettings = { length: 28 } as typeof DEFAULT_GENERATOR_SETTINGS;
    callbacks.onGeneratorUse("generated", nextSettings);
    expect(state.setters.setPassword).toHaveBeenCalledWith("generated");
    expect(state.setters.setShowPassword).toHaveBeenCalledWith(true);
    expect(state.setters.setGeneratorSettings).toHaveBeenCalledWith(nextSettings);
  });
});
