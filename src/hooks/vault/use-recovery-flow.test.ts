// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { FormEvent } from "react";
import { formatRecoveryKey, wrapSecretKeyWithRecovery } from "@/lib/crypto/crypto-recovery";

const { mockFetchApi, mockHardNavigate, mockSetHasRecoveryKey } = vi.hoisted(() => ({
  mockFetchApi: vi.fn(),
  mockHardNavigate: vi.fn(),
  mockSetHasRecoveryKey: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ setHasRecoveryKey: mockSetHasRecoveryKey }),
}));
vi.mock("@/lib/url-helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/url-helpers")>()),
  fetchApi: mockFetchApi,
  hardNavigate: mockHardNavigate,
}));

import { useRecoveryFlow } from "./use-recovery-flow";

// Test-only key material.
const RECOVERY_KEY = new Uint8Array(32).fill(9);
const SECRET_KEY = new Uint8Array(32).fill(5);
const PASSPHRASE = "a long enough passphrase";

function ev(): FormEvent {
  return { preventDefault: vi.fn() } as unknown as FormEvent;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

async function verified() {
  const wrapped = await wrapSecretKeyWithRecovery(SECRET_KEY, RECOVERY_KEY);
  mockFetchApi.mockResolvedValueOnce(
    json({ ...wrapped, accountSalt: "11".repeat(32), keyVersion: 1 }),
  );
  const hook = renderHook(() => useRecoveryFlow());
  const formatted = await formatRecoveryKey(RECOVERY_KEY);
  act(() => hook.result.current.setRecoveryKeyInput(formatted.toLowerCase()));
  await act(() => hook.result.current.handleVerify(ev()));
  return hook;
}

describe("useRecoveryFlow", () => {
  beforeEach(() => {
    mockFetchApi.mockReset();
  });

  it("starts on the input step", () => {
    const { result } = renderHook(() => useRecoveryFlow());

    expect(result.current.step).toBe("input");
    expect(result.current.isValid).toBe(false);
  });

  it("accepts a lower-case formatted key and moves to the new-passphrase step", async () => {
    const { result } = await verified();

    expect(result.current.step).toBe("new-passphrase");
    expect(result.current.error).toBe("");
    expect(result.current.loading).toBe(false);
  });

  it("reports an invalid key for characters outside the Base32 alphabet", async () => {
    const { result } = renderHook(() => useRecoveryFlow());
    act(() => result.current.setRecoveryKeyInput("1".repeat(54)));

    await act(() => result.current.handleVerify(ev()));

    expect(result.current.error).toBe("invalidRecoveryKey");
    expect(result.current.step).toBe("input");
  });

  it("is valid only with a 10+ character matching confirmation", async () => {
    const { result } = await verified();

    act(() => {
      result.current.setNewPassphrase("123456789");
      result.current.setConfirmPassphrase("123456789");
    });
    expect(result.current.isValid).toBe(false);

    act(() => {
      result.current.setNewPassphrase("1234567890");
      result.current.setConfirmPassphrase("1234567890");
    });
    expect(result.current.isValid).toBe(true);
  });

  it("does not send a reset while the passphrase is invalid", async () => {
    const { result } = await verified();

    await act(() => result.current.handleReset(ev()));

    expect(mockFetchApi).toHaveBeenCalledTimes(1);
  });

  it("navigates to the dashboard after a successful reset", async () => {
    const { result } = await verified();
    act(() => {
      result.current.setNewPassphrase(PASSPHRASE);
      result.current.setConfirmPassphrase(PASSPHRASE);
    });
    mockFetchApi.mockResolvedValueOnce(json({}));

    await act(() => result.current.handleReset(ev()));

    expect(mockSetHasRecoveryKey).toHaveBeenCalledWith(true);
    expect(mockHardNavigate).toHaveBeenCalledWith("/en/dashboard");
  }, 15_000);

  it("shows the unknown error for a reset refusal without a code", async () => {
    const { result } = await verified();
    act(() => {
      result.current.setNewPassphrase(PASSPHRASE);
      result.current.setConfirmPassphrase(PASSPHRASE);
    });
    mockFetchApi.mockResolvedValueOnce(new Response("", { status: 500 }));

    await act(() => result.current.handleReset(ev()));

    expect(result.current.error).toBe("unknownError");
    expect(result.current.loading).toBe(false);
    expect(mockHardNavigate).not.toHaveBeenCalled();
  }, 15_000);
});
