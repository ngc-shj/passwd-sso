// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePersonalPasswordFormModel } from "@/hooks/use-personal-password-form-model";

const useRouterMock = vi.fn();
const useVaultMock = vi.fn();
const usePersonalFoldersMock = vi.fn();
const submitPersonalPasswordFormMock = vi.fn();

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => useRouterMock(),
}));

vi.mock("@/lib/vault-context", () => ({
  useVault: () => useVaultMock(),
}));

vi.mock("@/hooks/use-personal-folders", () => ({
  usePersonalFolders: () => usePersonalFoldersMock(),
}));

vi.mock("@/components/passwords/personal-password-submit", () => ({
  submitPersonalPasswordForm: (...args: unknown[]) => submitPersonalPasswordFormMock(...args),
}));

describe("usePersonalPasswordFormModel", () => {
  beforeEach(() => {
    useRouterMock.mockReset();
    useVaultMock.mockReset();
    usePersonalFoldersMock.mockReset();
    submitPersonalPasswordFormMock.mockReset();

    useRouterMock.mockReturnValue({
      back: vi.fn(),
      push: vi.fn(),
      refresh: vi.fn(),
    });
    useVaultMock.mockReturnValue({
      encryptionKey: {} as CryptoKey,
      userId: "user-1",
    });
    usePersonalFoldersMock.mockReturnValue([]);
    submitPersonalPasswordFormMock.mockResolvedValue(undefined);
  });

  it("computes hasChanges from initial snapshot", () => {
    const { result } = renderHook(() =>
      usePersonalPasswordFormModel({
        mode: "edit",
        initialData: {
          id: "entry-1",
          title: "old title",
          username: "user",
          password: "pass",
          url: "",
          notes: "",
          tags: [],
        },
      }),
    );

    expect(result.current.hasChanges).toBe(false);

    act(() => {
      result.current.setTitle("new title");
    });

    expect(result.current.hasChanges).toBe(true);
  });

  it("delegates submit to submitPersonalPasswordForm", async () => {
    const preventDefault = vi.fn();
    const onSaved = vi.fn();
    const { result } = renderHook(() =>
      usePersonalPasswordFormModel({
        mode: "create",
        onSaved,
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
      onSaved,
      setSubmitting: expect.any(Function),
    });
  });
});
