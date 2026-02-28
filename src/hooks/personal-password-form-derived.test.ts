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

  it("hasChanges=false when values match defaultFolderId (no initialData)", () => {
    const result = buildPersonalPasswordFormDerived({
      values: buildEmptyValues({ folderId: "f1" }),
      translations: buildTranslations((key: string) => key),
      defaultFolderId: "f1",
    });
    expect(result.hasChanges).toBe(false);
  });

  it("hasChanges=true when folderId differs from defaultFolderId", () => {
    const result = buildPersonalPasswordFormDerived({
      values: buildEmptyValues({ folderId: "f2" }),
      translations: buildTranslations((key: string) => key),
      defaultFolderId: "f1",
    });
    expect(result.hasChanges).toBe(true);
  });

  it("hasChanges=false when values match defaultTags (no initialData)", () => {
    const tag = { id: "t1", name: "work", color: null };
    const result = buildPersonalPasswordFormDerived({
      values: buildEmptyValues({ selectedTags: [tag] }),
      translations: buildTranslations((key: string) => key),
      defaultTags: [tag],
    });
    expect(result.hasChanges).toBe(false);
  });
});

function buildValues(overrides: Partial<{
  title: string;
  folderId: string | null;
  selectedTags: { id: string; name: string; color: string | null }[];
}> = {}) {
  return {
    title: overrides.title ?? "title",
    username: "user",
    password: "pass",
    url: "",
    notes: "",
    selectedTags: overrides.selectedTags ?? [],
    generatorSettings: { ...DEFAULT_GENERATOR_SETTINGS },
    customFields: [],
    totp: null,
    requireReprompt: false,
    expiresAt: null,
    folderId: overrides.folderId ?? null,
  };
}

/** Values matching the baseline snapshot when initialData is undefined */
function buildEmptyValues(overrides: Partial<{
  folderId: string | null;
  selectedTags: { id: string; name: string; color: string | null }[];
}> = {}) {
  return {
    title: "",
    username: "",
    password: "",
    url: "",
    notes: "",
    selectedTags: overrides.selectedTags ?? [],
    generatorSettings: { ...DEFAULT_GENERATOR_SETTINGS },
    customFields: [],
    totp: null,
    requireReprompt: false,
    expiresAt: null,
    folderId: overrides.folderId ?? null,
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
