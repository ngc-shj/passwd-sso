// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePersonalLoginFormModel } from "@/hooks/use-personal-login-form-model";

const useRouterMock = vi.fn();
const useVaultMock = vi.fn();
const usePersonalFoldersMock = vi.fn();
const submitPersonalLoginFormMock = vi.fn();

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

vi.mock("@/components/passwords/personal-login-submit", () => ({
  submitPersonalLoginForm: (...args: unknown[]) => submitPersonalLoginFormMock(...args),
}));

describe("usePersonalLoginFormModel", () => {
  beforeEach(() => {
    useRouterMock.mockReset();
    useVaultMock.mockReset();
    usePersonalFoldersMock.mockReset();
    submitPersonalLoginFormMock.mockReset();

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
    submitPersonalLoginFormMock.mockResolvedValue(undefined);
  });

  it("computes hasChanges from initial snapshot", () => {
    const { result } = renderHook(() =>
      usePersonalLoginFormModel({
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
      result.current.formState.setters.setTitle("new title");
    });

    expect(result.current.hasChanges).toBe(true);
  });

  it("delegates submit to submitPersonalLoginForm", async () => {
    const preventDefault = vi.fn();
    const onSaved = vi.fn();
    const { result } = renderHook(() =>
      usePersonalLoginFormModel({
        mode: "create",
        onSaved,
      }),
    );

    await act(async () => {
      await result.current.handleSubmit({ preventDefault } as unknown as React.FormEvent);
    });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(submitPersonalLoginFormMock).toHaveBeenCalledTimes(1);
    expect(submitPersonalLoginFormMock.mock.calls[0]?.[0]).toMatchObject({
      mode: "create",
      userId: "user-1",
      onSaved,
      setSubmitting: expect.any(Function),
    });
  });
});
