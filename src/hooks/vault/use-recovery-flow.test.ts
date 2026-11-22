// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

/**
 * Records the raw key buffers handed to WebCrypto as HKDF input while still
 * running the real import. The verifier hash imports the parsed recovery key
 * itself (toArrayBuffer passes the same view), so the first capture is the
 * hook's own buffer. The fixture's RECOVERY_KEY, imported by the test's own
 * wrapSecretKeyWithRecovery, is skipped.
 */
function captureHkdfInputs(): Uint8Array[] {
  const captured: Uint8Array[] = [];
  const realImportKey = crypto.subtle.importKey.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "importKey").mockImplementation(((...args: Parameters<SubtleCrypto["importKey"]>) => {
    const [format, keyData, algorithm] = args;
    if (format === "raw" && algorithm === "HKDF" && keyData instanceof Uint8Array && keyData !== RECOVERY_KEY) {
      captured.push(keyData);
    }
    return realImportKey(...args);
  }) as SubtleCrypto["importKey"]);
  return captured;
}

function isZeroed(bytes: Uint8Array | undefined): boolean {
  if (!bytes) throw new Error("no recovery-key buffer was captured");
  return bytes.every((b) => b === 0);
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
  it("treats SESSION_INVALIDATE_FAILED as a committed reset and holds navigation for the warning", async () => {
    const { result } = await verified();
    act(() => {
      result.current.setNewPassphrase(PASSPHRASE);
      result.current.setConfirmPassphrase(PASSPHRASE);
    });
    mockSetHasRecoveryKey.mockClear();
    mockFetchApi.mockResolvedValueOnce(json({ error: "SESSION_INVALIDATE_FAILED" }, 500));

    await act(() => result.current.handleReset(ev()));

    expect(result.current.step).toBe("reset-invalidation-failed");
    expect(result.current.error).toBe("");
    expect(mockSetHasRecoveryKey).toHaveBeenCalledWith(true);
    expect(mockHardNavigate).not.toHaveBeenCalled();
  }, 15_000);

  it("continues to the dashboard from the invalidation warning", async () => {
    const { result } = await verified();
    act(() => {
      result.current.setNewPassphrase(PASSPHRASE);
      result.current.setConfirmPassphrase(PASSPHRASE);
    });
    mockFetchApi.mockResolvedValueOnce(json({ error: "SESSION_INVALIDATE_FAILED" }, 500));
    await act(() => result.current.handleReset(ev()));

    act(() => result.current.continueToDashboard());

    expect(mockHardNavigate).toHaveBeenCalledWith("/en/dashboard");
  }, 15_000);

  describe("recovery-key buffer wiping", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("wipes the parsed recovery key when the server refuses verification", async () => {
      const captured = captureHkdfInputs();
      mockFetchApi.mockResolvedValueOnce(json({ error: "INVALID_RECOVERY_KEY" }, 400));
      const { result } = renderHook(() => useRecoveryFlow());
      const formatted = await formatRecoveryKey(RECOVERY_KEY);
      act(() => result.current.setRecoveryKeyInput(formatted));

      await act(() => result.current.handleVerify(ev()));

      expect(result.current.error).toBe("invalidRecoveryKey");
      expect(isZeroed(captured[0])).toBe(true);
    });

    it("keeps the verified recovery key intact for the reset step", async () => {
      const captured = captureHkdfInputs();

      const { result } = await verified();

      expect(result.current.step).toBe("new-passphrase");
      expect(captured[0]).toEqual(RECOVERY_KEY);
    });

    it("wipes the recovery key when the reset committed but invalidation failed", async () => {
      const captured = captureHkdfInputs();
      const { result } = await verified();
      act(() => {
        result.current.setNewPassphrase(PASSPHRASE);
        result.current.setConfirmPassphrase(PASSPHRASE);
      });
      mockFetchApi.mockResolvedValueOnce(json({ error: "SESSION_INVALIDATE_FAILED" }, 500));

      await act(() => result.current.handleReset(ev()));

      expect(result.current.step).toBe("reset-invalidation-failed");
      expect(isZeroed(captured[0])).toBe(true);
    }, 15_000);

    it("wipes the verified recovery key when the flow is abandoned by unmounting", async () => {
      const captured = captureHkdfInputs();
      const { unmount } = await verified();

      unmount();

      expect(isZeroed(captured[0])).toBe(true);
    });
  });
});
