"use client";

import type { GeneratorSettings } from "@/lib/generator-prefs";

export function buildTeamLoginFieldCallbacks(
  values: {
    showPassword: boolean;
    showGenerator: boolean;
  },
  setters: {
    setUsername: (value: string) => void;
    setPassword: (value: string) => void;
    setShowPassword: (value: boolean) => void;
    setShowGenerator: (value: boolean) => void;
    setGeneratorSettings: (value: GeneratorSettings) => void;
    setUrl: (value: string) => void;
  },
) {
  return {
    onUsernameChange: setters.setUsername,
    onPasswordChange: setters.setPassword,
    onToggleShowPassword: () => setters.setShowPassword(!values.showPassword),
    onToggleGenerator: () => setters.setShowGenerator(!values.showGenerator),
    onGeneratorUse: (pw: string, settings: GeneratorSettings) => {
      setters.setPassword(pw);
      setters.setGeneratorSettings(settings);
    },
    onUrlChange: setters.setUrl,
  };
}
