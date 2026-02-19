import { describe, expect, it, vi } from "vitest";
import { DEFAULT_GENERATOR_SETTINGS } from "@/lib/generator-prefs";
import { buildPersonalPasswordSubmitArgs } from "@/hooks/personal-password-submit-args";

describe("buildPersonalPasswordSubmitArgs", () => {
  it("maps controller input into submit args", () => {
    const setSubmitting = vi.fn();
    const onSaved = vi.fn();
    const t = (key: string) => key;
    const router = { push: vi.fn(), refresh: vi.fn() };

    const args = buildPersonalPasswordSubmitArgs({
      mode: "create",
      encryptionKey: {} as CryptoKey,
      userId: "user-1",
      values: {
        title: "title",
        username: "user",
        password: "pass",
        url: "https://example.com",
        notes: "memo",
        selectedTags: [],
        generatorSettings: { ...DEFAULT_GENERATOR_SETTINGS },
        customFields: [],
        totp: null,
        requireReprompt: true,
        folderId: "folder-1",
      },
      setSubmitting,
      translations: {
        t,
        tGen: (key) => key,
        tc: (key) => key,
      },
      router,
      onSaved,
    });

    expect(args.mode).toBe("create");
    expect(args.userId).toBe("user-1");
    expect(args.title).toBe("title");
    expect(args.password).toBe("pass");
    expect(args.folderId).toBe("folder-1");
    expect(args.requireReprompt).toBe(true);
    expect(args.setSubmitting).toBe(setSubmitting);
    expect(args.onSaved).toBe(onSaved);
  });
});
