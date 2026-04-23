import { describe, expect, it, vi } from "vitest";
import { mockTranslator } from "@/__tests__/helpers/mock-translator";
import type { PasswordFormTranslator, PasswordGeneratorTranslator, CommonTranslator } from "@/lib/translation-types";
import { DEFAULT_GENERATOR_SETTINGS } from "@/lib/generator/generator-prefs";
import { buildPersonalLoginSubmitArgs } from "@/hooks/personal-login-form-submit-args";

describe("buildPersonalLoginSubmitArgs", () => {
  it("maps personal form values and passes null userId through", () => {
    const setSubmitting = vi.fn();
    const onSaved = vi.fn();
    const args = buildPersonalLoginSubmitArgs({
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
        travelSafe: true,
        expiresAt: null,
        folderId: null,
      },
      setSubmitting,
      translations: {
        t: mockTranslator<PasswordFormTranslator>((key) => `pf.${key}`),
        tGen: mockTranslator<PasswordGeneratorTranslator>(),
        tc: mockTranslator<CommonTranslator>(),
      },
      router: { push: vi.fn(), refresh: vi.fn(), back: vi.fn() },
    });

    expect(args.userId).toBeNull();
    expect(args.title).toBe("title");
    expect(args.password).toBe("pass");
    expect(args.setSubmitting).toBe(setSubmitting);
    expect(args.onSaved).toBe(onSaved);
    expect(args.t("saved")).toBe("pf.saved");
  });
});
