import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockTranslator } from "@/__tests__/helpers/mock-translator";
import type { PasswordFormTranslator, PasswordGeneratorTranslator, CommonTranslator } from "@/lib/translation-types";
import { DEFAULT_GENERATOR_SETTINGS } from "@/lib/generator/generator-prefs";
import type { PersonalLoginFormTranslations } from "@/hooks/entry-form-translations";
import {
  buildPersonalLoginFormController,
} from "@/hooks/personal-login-form-controller";

const submitPersonalLoginFormMock = vi.fn();

vi.mock("@/components/passwords/personal-login-submit", () => ({
  submitPersonalLoginForm: (...args: unknown[]) => submitPersonalLoginFormMock(...args),
}));

describe("buildPersonalLoginFormController", () => {
  beforeEach(() => {
    submitPersonalLoginFormMock.mockReset();
    submitPersonalLoginFormMock.mockResolvedValue(undefined);
  });

  it("delegates submit and cancel/back actions", async () => {
    const preventDefault = vi.fn();
    const onSaved = vi.fn();
    const onCancel = vi.fn();
    const back = vi.fn();

    const controller = buildPersonalLoginFormController({
      mode: "create",
      variant: "dialog",
      onSaved,
      onCancel,
      encryptionKey: {} as CryptoKey,
      userId: "user-1",
      values: buildValues(),
      setSubmitting: vi.fn(),
      translations: buildTranslations(),
      router: { push: vi.fn(), refresh: vi.fn(), back },
    } as unknown as Parameters<typeof buildPersonalLoginFormController>[0]);

    await controller.handleSubmit({ preventDefault } as unknown as React.FormEvent);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(submitPersonalLoginFormMock).toHaveBeenCalledTimes(1);
    expect(submitPersonalLoginFormMock.mock.calls[0]?.[0]).toMatchObject({
      mode: "create",
      userId: "user-1",
      title: "title",
    });

    controller.handleCancel();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();

    controller.handleBack();
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("passes null userId through to submit args", async () => {
    const controller = buildPersonalLoginFormController({
      mode: "create",
      variant: "page",
      onSaved: vi.fn(),
      encryptionKey: {} as CryptoKey,
      userId: null,
      values: buildValues(),
      setSubmitting: vi.fn(),
      translations: buildTranslations(),
      router: { push: vi.fn(), refresh: vi.fn(), back: vi.fn() },
    } as unknown as Parameters<typeof buildPersonalLoginFormController>[0]);

    await controller.handleSubmit({ preventDefault: vi.fn() } as unknown as React.FormEvent);

    expect(submitPersonalLoginFormMock).toHaveBeenCalledTimes(1);
    expect(submitPersonalLoginFormMock.mock.calls[0]?.[0]?.userId).toBeNull();
  });

  it("uses router.back for page cancel even when onSaved exists", () => {
    const onSaved = vi.fn();
    const back = vi.fn();

    const controller = buildPersonalLoginFormController({
      mode: "edit",
      variant: "page",
      onSaved,
      encryptionKey: {} as CryptoKey,
      userId: "user-1",
      values: buildValues(),
      setSubmitting: vi.fn(),
      translations: buildTranslations(),
      router: { push: vi.fn(), refresh: vi.fn(), back },
    } as unknown as Parameters<typeof buildPersonalLoginFormController>[0]);

    controller.handleCancel();

    expect(onSaved).not.toHaveBeenCalled();
    expect(back).toHaveBeenCalledTimes(1);
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
    expiresAt: null,
    folderId: null,
  };
}

function buildTranslations(): PersonalLoginFormTranslations {
  return {
    t: mockTranslator<PasswordFormTranslator>(),
    tGen: mockTranslator<PasswordGeneratorTranslator>(),
    tc: mockTranslator<CommonTranslator>(),
  };
}
