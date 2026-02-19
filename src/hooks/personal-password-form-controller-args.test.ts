import { describe, expect, it, vi } from "vitest";
import { DEFAULT_GENERATOR_SETTINGS } from "@/lib/generator-prefs";
import { buildPersonalPasswordControllerArgs } from "@/hooks/personal-password-form-controller-args";
import type { PersonalPasswordFormTranslations } from "@/hooks/personal-password-form-translations";

describe("buildPersonalPasswordControllerArgs", () => {
  it("maps model state into controller args payload", () => {
    const onSaved = vi.fn();
    const setSubmitting = vi.fn();
    const router = { push: vi.fn(), refresh: vi.fn(), back: vi.fn() };
    const translations: PersonalPasswordFormTranslations = {
      t: (key) => key,
      tGen: (key) => key,
      tc: (key) => key,
    };

    const args = buildPersonalPasswordControllerArgs({
      mode: "create",
      initialData: {
        id: "entry-1",
        title: "title",
        username: "user",
        password: "pass",
        url: "",
        notes: "",
        tags: [],
      },
      onSaved,
      encryptionKey: {} as CryptoKey,
      userId: "user-1",
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
      setSubmitting,
      translations,
      router,
    });

    expect(args.mode).toBe("create");
    expect(args.initialData?.id).toBe("entry-1");
    expect(args.userId).toBe("user-1");
    expect(args.setSubmitting).toBe(setSubmitting);
    expect(args.translations).toBe(translations);
    expect(args.router).toBe(router);
    expect(args.onSaved).toBe(onSaved);
  });
});
