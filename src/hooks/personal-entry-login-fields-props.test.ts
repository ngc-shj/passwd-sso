import { describe, expect, it, vi } from "vitest";
import { DEFAULT_GENERATOR_SETTINGS } from "@/lib/generator-prefs";
import {
  buildPersonalEntryLoginFieldPropsFromState,
  buildPersonalEntryLoginFieldsProps,
} from "@/hooks/personal-entry-login-fields-props";
import { buildPersonalEntryLoginFieldCallbacks } from "@/hooks/personal-entry-login-fields-callbacks";
import { buildPersonalEntryLoginFieldTextProps } from "@/hooks/personal-entry-login-fields-text-props";
import type { PersonalPasswordFormState } from "@/hooks/use-personal-password-form-state";

describe("buildPersonalEntryLoginFieldsProps", () => {
  it("builds complete login field props from state", () => {
    const state = createState();
    const callbacks = buildPersonalEntryLoginFieldCallbacks(state.values, state.setters);
    const textProps = buildPersonalEntryLoginFieldTextProps((k) => `label.${k}`);

    const props = buildPersonalEntryLoginFieldPropsFromState({
      values: state.values,
      callbacks,
      generatorSummary: "summary",
      textProps,
    });

    expect(props.title).toBe(state.values.title);
    expect(props.username).toBe(state.values.username);
    expect(props.password).toBe(state.values.password);
    expect(props.onPasswordChange).toBe(callbacks.onPasswordChange);
    expect(props.titleLabel).toBe("label.title");
    expect(props.notesPlaceholder).toBe("label.notesPlaceholder");
    expect(props.generatorSummary).toBe("summary");
  });

  it("maps values and labels from personal form state", () => {
    const state = createState();
    const props = buildPersonalEntryLoginFieldsProps({
      formState: state,
      generatorSummary: "summary",
      translations: { t: (k) => `label.${k}` },
    });

    expect(props.title).toBe(state.values.title);
    expect(props.username).toBe(state.values.username);
    expect(props.password).toBe(state.values.password);
    expect(props.notes).toBe(state.values.notes);
    expect(props.titleLabel).toBe("label.title");
    expect(props.passwordLabel).toBe("label.password");
    expect(props.notesLabel).toBe("label.notes");
  });

  it("toggles visibility and applies generated password", () => {
    const state = createState();
    state.values.showPassword = true;
    state.values.showGenerator = true;

    const props = buildPersonalEntryLoginFieldsProps({
      formState: state,
      generatorSummary: "summary",
      translations: { t: (k) => k },
    });

    props.onToggleShowPassword();
    props.onToggleGenerator();
    expect(state.setters.setShowPassword).toHaveBeenCalledWith(false);
    expect(state.setters.setShowGenerator).toHaveBeenCalledWith(false);

    const nextSettings = { length: 42 } as typeof DEFAULT_GENERATOR_SETTINGS;
    props.onGeneratorUse("generated", nextSettings);
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
