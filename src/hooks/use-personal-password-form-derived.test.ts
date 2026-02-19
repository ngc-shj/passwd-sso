// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DEFAULT_GENERATOR_SETTINGS } from "@/lib/generator-prefs";
import type { PersonalPasswordFormTranslations } from "@/hooks/personal-password-form-translations";
import { usePersonalPasswordFormDerived } from "@/hooks/use-personal-password-form-derived";

describe("usePersonalPasswordFormDerived", () => {
  it("computes hasChanges from snapshot values", () => {
    const { result, rerender } = renderHook(
      ({ title }) =>
        usePersonalPasswordFormDerived({
          initialData: {
            id: "entry-1",
            title: "same",
            username: "user",
            password: "pass",
            url: "",
            notes: "",
            tags: [],
          },
          values: buildValues({ title }),
          translations: buildTranslations((key: string) => key),
        }),
      { initialProps: { title: "same" } },
    );

    expect(result.current.hasChanges).toBe(false);

    rerender({ title: "changed" });
    expect(result.current.hasChanges).toBe(true);
  });

  it("builds generator summary labels via translation callback", () => {
    const { result } = renderHook(() =>
      usePersonalPasswordFormDerived({
        values: buildValues(),
        translations: buildTranslations((key: string) =>
          key === "modePassword" ? "Password" : "Passphrase"),
      }),
    );

    expect(result.current.generatorSummary).toContain("Password");
  });
});

function buildValues(overrides: Partial<{ title: string }> = {}) {
  return {
    title: overrides.title ?? "title",
    username: "user",
    password: "pass",
    url: "",
    notes: "",
    selectedTags: [],
    generatorSettings: { ...DEFAULT_GENERATOR_SETTINGS },
    customFields: [],
    totp: null,
    requireReprompt: false,
    folderId: null,
  };
}

function buildTranslations(
  tGen: (key: string) => string,
): PersonalPasswordFormTranslations {
  return {
    t: (key) => key,
    tGen,
    tc: (key) => key,
  };
}
