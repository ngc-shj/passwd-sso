import { describe, expect, it, vi } from "vitest";
import { DEFAULT_GENERATOR_SETTINGS } from "@/lib/generator-prefs";
import { buildPersonalSubmitArgs } from "@/hooks/personal-password-form-submit-args";

describe("buildPersonalSubmitArgs", () => {
  it("maps personal form values and normalizes null userId", () => {
    const setSubmitting = vi.fn();
    const onSaved = vi.fn();
    const args = buildPersonalSubmitArgs({
      mode: "create",
      initialData: undefined,
      onSaved,
      encryptionKey: {} as CryptoKey,
      userId: null,
      values: {
        title: "title",
        username: "user",
        password: "pass",
        url: "https://example.com",
        notes: "notes",
        selectedTags: [],
        generatorSettings: { ...DEFAULT_GENERATOR_SETTINGS },
        customFields: [],
        totp: null,
        requireReprompt: false,
        folderId: null,
      },
      setSubmitting,
      translations: {
        t: (key) => `pf.${key}`,
        tGen: (key) => key,
        tc: (key) => key,
      },
      router: { push: vi.fn(), refresh: vi.fn(), back: vi.fn() },
    });

    expect(args.userId).toBeUndefined();
    expect(args.title).toBe("title");
    expect(args.password).toBe("pass");
    expect(args.setSubmitting).toBe(setSubmitting);
    expect(args.onSaved).toBe(onSaved);
    expect(args.t("saved")).toBe("pf.saved");
  });
});
