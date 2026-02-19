import { describe, expect, it } from "vitest";
import { DEFAULT_GENERATOR_SETTINGS } from "@/lib/generator-prefs";
import type { PersonalPasswordFormTranslations } from "@/hooks/entry-form-translations";
import { buildPersonalPasswordFormDerived } from "@/hooks/personal-password-form-derived";

describe("buildPersonalPasswordFormDerived", () => {
  it("computes hasChanges=false when values match initial data", () => {
    const result = buildPersonalPasswordFormDerived({
      initialData: {
        id: "entry-1",
        title: "same",
        username: "user",
        password: "pass",
        url: "",
        notes: "",
        tags: [],
      },
      values: buildValues({ title: "same" }),
      translations: buildTranslations((key: string) => key),
    });

    expect(result.hasChanges).toBe(false);
  });

  it("computes hasChanges=true when title differs", () => {
    const result = buildPersonalPasswordFormDerived({
      initialData: {
        id: "entry-1",
        title: "same",
        username: "user",
        password: "pass",
        url: "",
        notes: "",
        tags: [],
      },
      values: buildValues({ title: "changed" }),
      translations: buildTranslations((key: string) => key),
    });

    expect(result.hasChanges).toBe(true);
  });

  it("builds generator summary labels via translation callback", () => {
    const result = buildPersonalPasswordFormDerived({
      values: buildValues(),
      translations: buildTranslations((key: string) =>
        key === "modePassword" ? "Password" : "Passphrase"),
    });

    expect(result.generatorSummary).toContain("Password");
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
