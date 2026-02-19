"use client";

import type { GeneratorSettings } from "@/lib/generator-prefs";
import type {
  PersonalPasswordFormSetters,
  PersonalPasswordFormValues,
} from "@/hooks/use-personal-password-form-state";

export function buildPersonalEntryLoginFieldCallbacks(
  values: PersonalPasswordFormValues,
  setters: PersonalPasswordFormSetters,
) {
  return {
    onTitleChange: setters.setTitle,
    onUsernameChange: setters.setUsername,
    onPasswordChange: setters.setPassword,
    onToggleShowPassword: () => setters.setShowPassword(!values.showPassword),
    onToggleGenerator: () => setters.setShowGenerator(!values.showGenerator),
    onGeneratorUse: (pw: string, settings: GeneratorSettings) => {
      setters.setPassword(pw);
      setters.setShowPassword(true);
      setters.setGeneratorSettings(settings);
    },
    onUrlChange: setters.setUrl,
    onNotesChange: setters.setNotes,
  };
}
