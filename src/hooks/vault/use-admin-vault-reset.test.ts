// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { FormEvent } from "react";
import { API_PATH } from "@/lib/constants";
import { VAULT_CONFIRMATION_PHRASE } from "@/lib/constants/vault";

const { mockFetchApi, mockHardNavigate } = vi.hoisted(() => ({
  mockFetchApi: vi.fn(),
  mockHardNavigate: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));
vi.mock("@/lib/url-helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/url-helpers")>()),
  fetchApi: mockFetchApi,
  hardNavigate: mockHardNavigate,
}));

import { useAdminVaultReset } from "./use-admin-vault-reset";

const TOKEN = "0f".repeat(32);
const PHRASE = VAULT_CONFIRMATION_PHRASE.DELETE_VAULT;

function submitEvent(): FormEvent {
  return { preventDefault: vi.fn() } as unknown as FormEvent;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("useAdminVaultReset", () => {
  beforeEach(() => {
    mockFetchApi.mockReset();
    mockHardNavigate.mockReset();
  });

  it("reads the 64-hex token from the URL fragment", () => {
    window.history.replaceState(null, "", `/en/vault-reset/admin#token=${TOKEN}&x=1`);
    const { result } = renderHook(() => useAdminVaultReset());

    expect(result.current.token).toBe(TOKEN);
  });

  it("returns a null token when the fragment holds none", () => {
    window.history.replaceState(null, "", "/en/vault-reset/admin#other=1");
    const { result } = renderHook(() => useAdminVaultReset());

    expect(result.current.token).toBeNull();
  });

  it("is valid only for the exact confirmation phrase", () => {
    window.history.replaceState(null, "", `/en/vault-reset/admin#token=${TOKEN}`);
    const { result } = renderHook(() => useAdminVaultReset());
    expect(result.current.isValid).toBe(false);

    act(() => result.current.setConfirmation(`${PHRASE} `));
    expect(result.current.isValid).toBe(false);

    act(() => result.current.setConfirmation(PHRASE));
    expect(result.current.isValid).toBe(true);
  });

  it("does not submit while the confirmation phrase is wrong", async () => {
    window.history.replaceState(null, "", `/en/vault-reset/admin#token=${TOKEN}`);
    const { result } = renderHook(() => useAdminVaultReset());
    const e = submitEvent();

    await act(() => result.current.handleSubmit(e));

    expect(e.preventDefault).toHaveBeenCalled();
    expect(mockFetchApi).not.toHaveBeenCalled();
  });

  it("does not submit without a token", async () => {
    window.history.replaceState(null, "", "/en/vault-reset/admin");
    const { result } = renderHook(() => useAdminVaultReset());
    act(() => result.current.setConfirmation(PHRASE));

    await act(() => result.current.handleSubmit(submitEvent()));

    expect(mockFetchApi).not.toHaveBeenCalled();
  });

  it("posts and navigates to the locale dashboard on success", async () => {
    window.history.replaceState(null, "", `/en/vault-reset/admin#token=${TOKEN}`);
    mockFetchApi.mockImplementation(async () => json({}));
    const { result } = renderHook(() => useAdminVaultReset());
    act(() => result.current.setConfirmation(PHRASE));

    await act(() => result.current.handleSubmit(submitEvent()));

    expect(mockFetchApi).toHaveBeenCalledWith(API_PATH.VAULT_ADMIN_RESET, expect.objectContaining({ method: "POST" }));
    expect(mockHardNavigate).toHaveBeenCalledWith("/en/dashboard");
    expect(result.current.loading).toBe(false);
  });

  it("sets the mapped error for a coded error response", async () => {
    window.history.replaceState(null, "", `/en/vault-reset/admin#token=${TOKEN}`);
    mockFetchApi.mockImplementation(async () => json({ error: "UNAUTHORIZED" }, 401));
    const { result } = renderHook(() => useAdminVaultReset());
    act(() => result.current.setConfirmation(PHRASE));

    await act(() => result.current.handleSubmit(submitEvent()));

    expect(result.current.error).toBe("unauthorized");
    expect(mockHardNavigate).not.toHaveBeenCalled();
  });
});
