import { describe, expect, it } from "vitest";
import { DEFAULT_GENERATOR_SETTINGS } from "@/lib/generator-prefs";
import { buildPersonalPasswordDerivedArgs } from "@/hooks/personal-password-form-derived-args";
import type { PersonalPasswordFormTranslations } from "@/hooks/personal-password-form-translations";

describe("buildPersonalPasswordDerivedArgs", () => {
  it("maps model state into derived args payload", () => {
    const translations: PersonalPasswordFormTranslations = {
      t: (key) => key,
      tGen: (key) => key,
      tc: (key) => key,
    };
    const args = buildPersonalPasswordDerivedArgs({
      initialData: {
        id: "entry-1",
        title: "title",
        username: "user",
        password: "pass",
        url: "",
        notes: "",
        tags: [],
      },
      values: {
        title: "title",
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
      },
      translations,
    });

    expect(args.initialData?.id).toBe("entry-1");
    expect(args.values.title).toBe("title");
    expect(args.translations).toBe(translations);
  });
});
