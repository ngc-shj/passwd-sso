// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { API_PATH, VAULT_STATUS } from "@/lib/constants";
import { deriveEncryptionKey } from "@/lib/crypto/crypto-client";
import { decryptPrivateKey } from "@/lib/crypto/crypto-emergency";

const { mockFetchApi, mockUseVault, mockToast, mockPush } = vi.hoisted(() => ({
  mockFetchApi: vi.fn(),
  mockUseVault: vi.fn(),
  mockToast: { success: vi.fn(), error: vi.fn() },
  mockPush: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("@/i18n/navigation", async () => {
  const { mockI18nNavigation } = await import("@/__tests__/helpers/mock-app-navigation");
  return mockI18nNavigation({ router: { push: mockPush } });
});
vi.mock("@/lib/vault/vault-context", () => ({ useVault: mockUseVault }));
vi.mock("sonner", () => ({ toast: mockToast }));
vi.mock("@/lib/url-helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/url-helpers")>()),
  fetchApi: mockFetchApi,
}));

import { useEmergencyInviteResponse } from "./use-emergency-invite-response";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

let encryptionKey: CryptoKey;

describe("useEmergencyInviteResponse", () => {
  beforeEach(async () => {
    mockFetchApi.mockReset();
    mockToast.error.mockReset();
    mockPush.mockReset();
    encryptionKey = await deriveEncryptionKey(new Uint8Array(32).fill(3));
    mockUseVault.mockReturnValue({ status: VAULT_STATUS.UNLOCKED, encryptionKey });
  });

  it("reports the vault as locked for any status but UNLOCKED", () => {
    mockUseVault.mockReturnValue({ status: VAULT_STATUS.LOCKED, encryptionKey: null });
    const { result } = renderHook(() => useEmergencyInviteResponse("tok"));

    expect(result.current.vaultLocked).toBe(true);
  });

  it("reports the vault as unlocked when UNLOCKED", () => {
    const { result } = renderHook(() => useEmergencyInviteResponse("tok"));

    expect(result.current.vaultLocked).toBe(false);
  });

  it("seals a hex-encoded PKCS#8 private key under the vault key on accept", async () => {
    mockFetchApi.mockImplementation(async () => json({}));
    const { result } = renderHook(() => useEmergencyInviteResponse("tok-1"));

    await act(() => result.current.handleAccept());

    const [path, init] = mockFetchApi.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(API_PATH.EMERGENCY_ACCESS_ACCEPT);
    const body = JSON.parse(String(init.body));
    expect(Object.keys(body.encryptedPrivateKey).sort()).toEqual(["authTag", "ciphertext", "iv"]);
    const pkcs8 = await decryptPrivateKey(body.encryptedPrivateKey, encryptionKey);
    // PKCS#8 DER always starts with a SEQUENCE tag.
    expect(pkcs8[0]).toBe(0x30);
    expect(JSON.parse(body.granteePublicKey)).toMatchObject({ kty: "EC", crv: "P-256" });
  });

  describe("private-key wiping", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    // WebCrypto's ArrayBuffer comes from Node's realm, not jsdom's, so
    // `instanceof ArrayBuffer` is false for it.
    function isArrayBuffer(value: ArrayBuffer | JsonWebKey): value is ArrayBuffer {
      return Object.prototype.toString.call(value) === "[object ArrayBuffer]";
    }

    /** Records each PKCS#8 export's buffer while still running the real export. */
    function capturePkcs8Exports(): ArrayBuffer[] {
      const captured: ArrayBuffer[] = [];
      const realExportKey = crypto.subtle.exportKey.bind(crypto.subtle);
      vi.spyOn(crypto.subtle, "exportKey").mockImplementation((async (format: KeyFormat, key: CryptoKey) => {
        const exported = await realExportKey(format, key);
        if (format === "pkcs8" && isArrayBuffer(exported)) captured.push(exported);
        return exported;
      }) as SubtleCrypto["exportKey"]);
      return captured;
    }

    it("wipes the exported PKCS#8 bytes after sealing them", async () => {
      const captured = capturePkcs8Exports();
      mockFetchApi.mockImplementation(async () => json({}));
      const { result } = renderHook(() => useEmergencyInviteResponse("tok-1"));

      await act(() => result.current.handleAccept());

      expect(captured).toHaveLength(1);
      expect(new Uint8Array(captured[0]).every((b) => b === 0)).toBe(true);
      // The wipe ran after sealing: the sent ciphertext still holds a real key.
      const body = JSON.parse(String((mockFetchApi.mock.calls[0] as [string, RequestInit])[1].body));
      const pkcs8 = await decryptPrivateKey(body.encryptedPrivateKey, encryptionKey);
      expect(pkcs8[0]).toBe(0x30);
    });

    it("wipes the exported PKCS#8 bytes when sealing fails", async () => {
      const captured = capturePkcs8Exports();
      // A key that cannot encrypt makes encryptPrivateKey reject.
      const verifyOnlyKey = await crypto.subtle.importKey(
        "raw",
        new Uint8Array(32).fill(7),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      mockUseVault.mockReturnValue({ status: VAULT_STATUS.UNLOCKED, encryptionKey: verifyOnlyKey });
      const { result } = renderHook(() => useEmergencyInviteResponse("tok-1"));

      await act(() => result.current.handleAccept());

      expect(mockToast.error).toHaveBeenCalledWith("networkError");
      expect(mockFetchApi).not.toHaveBeenCalled();
      expect(captured).toHaveLength(1);
      expect(new Uint8Array(captured[0]).every((b) => b === 0)).toBe(true);
    });
  });

  it("cannot decrypt the sealed private key with a different vault key", async () => {
    mockFetchApi.mockImplementation(async () => json({}));
    const { result } = renderHook(() => useEmergencyInviteResponse("tok-1"));

    await act(() => result.current.handleAccept());

    const body = JSON.parse(String((mockFetchApi.mock.calls[0] as [string, RequestInit])[1].body));
    const otherKey = await deriveEncryptionKey(new Uint8Array(32).fill(4));
    await expect(decryptPrivateKey(body.encryptedPrivateKey, otherKey)).rejects.toThrow();
  });

  it("clears the loading flag after a failed accept", async () => {
    mockFetchApi.mockImplementation(async () => json({ error: "NOT_FOUND" }, 404));
    const { result } = renderHook(() => useEmergencyInviteResponse("tok"));

    await act(() => result.current.handleAccept());

    expect(result.current.loading).toBe(false);
    expect(mockToast.error).toHaveBeenCalledWith("invalidInvitation");
  });

  it("declines and navigates back on success", async () => {
    mockFetchApi.mockImplementation(async () => json({}));
    const { result } = renderHook(() => useEmergencyInviteResponse("tok-2"));

    await act(() => result.current.handleDecline());

    expect(mockFetchApi).toHaveBeenCalledWith(API_PATH.EMERGENCY_ACCESS_REJECT, expect.objectContaining({ method: "POST" }));
    expect(mockPush).toHaveBeenCalledWith("/dashboard/emergency-access");
  });

  it("maps a non-NOT_FOUND accept error through the emergency-access error keys", async () => {
    mockFetchApi.mockImplementation(async () => json({ error: "INVITATION_EXPIRED" }, 410));
    const { result } = renderHook(() => useEmergencyInviteResponse("tok"));

    await act(() => result.current.handleAccept());

    expect(mockToast.error).toHaveBeenCalledWith("invitationExpired");
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("reports an invalid invitation when decline gets NOT_FOUND", async () => {
    mockFetchApi.mockImplementation(async () => json({ error: "NOT_FOUND" }, 404));
    const { result } = renderHook(() => useEmergencyInviteResponse("tok"));

    await act(() => result.current.handleDecline());

    expect(mockToast.error).toHaveBeenCalledWith("invalidInvitation");
  });

  it("maps a non-NOT_FOUND decline error through the emergency-access error keys", async () => {
    mockFetchApi.mockImplementation(async () => json({ error: "INVITATION_ALREADY_USED" }, 409));
    const { result } = renderHook(() => useEmergencyInviteResponse("tok"));

    await act(() => result.current.handleDecline());

    expect(mockToast.error).toHaveBeenCalledWith("invitationAlreadyUsed");
  });
});
