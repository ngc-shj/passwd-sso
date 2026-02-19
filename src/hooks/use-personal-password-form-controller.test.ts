// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GENERATOR_SETTINGS } from "@/lib/generator-prefs";
import { usePersonalPasswordFormController } from "@/hooks/use-personal-password-form-controller";

const submitPersonalPasswordFormMock = vi.fn();

vi.mock("@/components/passwords/personal-password-submit", () => ({
  submitPersonalPasswordForm: (...args: unknown[]) => submitPersonalPasswordFormMock(...args),
}));

describe("usePersonalPasswordFormController", () => {
  beforeEach(() => {
    submitPersonalPasswordFormMock.mockReset();
    submitPersonalPasswordFormMock.mockResolvedValue(undefined);
  });

  it("computes hasChanges from snapshot values", () => {
    const { result, rerender } = renderHook(
      ({ title }) =>
        usePersonalPasswordFormController({
          mode: "edit",
          initialData: {
            id: "entry-1",
            title: "same",
            username: "user",
            password: "pass",
            url: "",
            notes: "",
            tags: [],
          },
          encryptionKey: null,
          values: buildValues({ title }),
          setSubmitting: vi.fn(),
          t: (key) => key,
          tGen: (key) => key,
          router: { push: vi.fn(), refresh: vi.fn(), back: vi.fn() },
        }),
      { initialProps: { title: "same" } },
    );

    expect(result.current.hasChanges).toBe(false);

    rerender({ title: "changed" });
    expect(result.current.hasChanges).toBe(true);
  });

  it("delegates submit and cancel/back actions", async () => {
    const preventDefault = vi.fn();
    const onSaved = vi.fn();
    const back = vi.fn();

    const { result } = renderHook(() =>
      usePersonalPasswordFormController({
        mode: "create",
        onSaved,
        encryptionKey: {} as CryptoKey,
        userId: "user-1",
        values: buildValues(),
        setSubmitting: vi.fn(),
        t: (key) => key,
        tGen: (key) => key,
        router: { push: vi.fn(), refresh: vi.fn(), back },
      }),
    );

    await act(async () => {
      await result.current.handleSubmit({ preventDefault } as unknown as React.FormEvent);
    });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(submitPersonalPasswordFormMock).toHaveBeenCalledTimes(1);
    expect(submitPersonalPasswordFormMock.mock.calls[0]?.[0]).toMatchObject({
      mode: "create",
      userId: "user-1",
      title: "title",
    });

    act(() => {
      result.current.handleCancel();
    });
    expect(onSaved).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.handleBack();
    });
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
    folderId: null,
  };
}
