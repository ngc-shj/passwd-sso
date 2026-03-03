import { describe, expect, it, vi } from "vitest";
import { buildTeamLoginFieldCallbacks } from "@/hooks/team-login-fields-callbacks";
import { DEFAULT_GENERATOR_SETTINGS } from "@/lib/generator-prefs";
import type { GeneratorSettings } from "@/lib/generator-prefs";

function createValuesAndSetters() {
  return {
    values: {
      showPassword: true,
      showGenerator: true,
    },
    setters: {
      setUsername: vi.fn(),
      setPassword: vi.fn(),
      setShowPassword: vi.fn(),
      setShowGenerator: vi.fn(),
      setGeneratorSettings: vi.fn(),
      setUrl: vi.fn(),
    },
  };
}

describe("buildTeamLoginFieldCallbacks", () => {
  it("onToggleShowPassword toggles the current value", () => {
    const { values, setters } = createValuesAndSetters();
    const callbacks = buildTeamLoginFieldCallbacks(values, setters);

    callbacks.onToggleShowPassword();
    expect(setters.setShowPassword).toHaveBeenCalledWith(false);
  });

  it("onGeneratorUse updates both password and settings", () => {
    const { values, setters } = createValuesAndSetters();
    const callbacks = buildTeamLoginFieldCallbacks(values, setters);

    const nextSettings = { ...DEFAULT_GENERATOR_SETTINGS, length: 28 } as GeneratorSettings;
    callbacks.onGeneratorUse("generated-pw", nextSettings);

    expect(setters.setPassword).toHaveBeenCalledWith("generated-pw");
    expect(setters.setGeneratorSettings).toHaveBeenCalledWith(nextSettings);
    // Team version does NOT auto-show password (unlike personal)
    expect(setters.setShowPassword).not.toHaveBeenCalled();
  });
});
