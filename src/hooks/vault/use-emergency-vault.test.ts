// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { VAULT_STATUS } from "@/lib/constants";
import {
  buildEmergencyVaultFixture,
  type EmergencyVaultFixture,
} from "@/__tests__/helpers/emergency-vault-fixtures";
import { deriveEncryptionKey } from "@/lib/crypto/crypto-client";
import { encryptPrivateKey } from "@/lib/crypto/crypto-emergency";

const { mockFetchApi, mockUseVault } = vi.hoisted(() => ({
  mockFetchApi: vi.fn(),
  mockUseVault: vi.fn(),
}));

// A stable translator, as next-intl's is: the decrypt effect depends on `t`,
// so a fresh function per render would rerun it on every state update.
vi.mock("next-intl", () => {
  const t = (key: string) => key;
  return { useTranslations: () => t };
});
vi.mock("@/lib/vault/vault-context", () => ({ useVault: mockUseVault }));
vi.mock("@/lib/url-helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/url-helpers")>()),
  fetchApi: mockFetchApi,
}));

import { useEmergencyVault } from "./use-emergency-vault";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function serve(fx: EmergencyVaultFixture) {
  mockFetchApi.mockImplementation(async (path: string) =>
    path.endsWith("/vault/entries") ? json(fx.entriesBody) : json(fx.vaultBody),
  );
  mockUseVault.mockReturnValue({ status: VAULT_STATUS.UNLOCKED, encryptionKey: fx.granteeEncryptionKey });
}

describe("useEmergencyVault", () => {
  beforeEach(() => {
    mockFetchApi.mockReset();
  });

  it("maps the decrypted overview onto the card, defaulting absent fields to null", async () => {
    const fx = await buildEmergencyVaultFixture([
      { id: "c1", entryType: "CREDIT_CARD", overview: { title: "Visa", brand: "visa", lastFour: "4242" }, blob: {} },
    ]);
    serve(fx);
    const { result } = renderHook(() => useEmergencyVault("grant-1"));

    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    expect(result.current.entries[0].card).toMatchObject({
      id: "c1",
      entryType: "CREDIT_CARD",
      title: "Visa",
      brand: "visa",
      lastFour: "4242",
      username: null,
      tags: [],
    });
    expect(result.current.isLoading).toBe(false);
  });

  it("decrypts a legacy (no-AAD) blob on demand", async () => {
    const fx = await buildEmergencyVaultFixture([
      { id: "l1", aadVersion: 0, overview: { title: "Old" }, blob: { password: "legacy-pw" } },
    ]);
    serve(fx);
    const { result } = renderHook(() => useEmergencyVault("grant-1"));
    await waitFor(() => expect(result.current.entries).toHaveLength(1));

    const cb = result.current.entryCallbackMap.get("l1");
    await expect(cb?.getPassword()).resolves.toBe("legacy-pw");
    await expect(cb?.getUrl()).resolves.toBeNull();
  });

  it("returns an empty password and history when the blob has none", async () => {
    const fx = await buildEmergencyVaultFixture([{ id: "n1", overview: { title: "Note" }, blob: {} }]);
    serve(fx);
    const { result } = renderHook(() => useEmergencyVault("grant-1"));
    await waitFor(() => expect(result.current.entries).toHaveLength(1));

    const cb = result.current.entryCallbackMap.get("n1");
    await expect(cb?.getPassword()).resolves.toBe("");
    await expect(cb?.getDetail()).resolves.toMatchObject({ passwordHistory: [] });
  });

  it("rejects an on-demand decrypt after unmount clears the owner key", async () => {
    const fx = await buildEmergencyVaultFixture([{ id: "u1", overview: { title: "T" }, blob: { password: "p" } }]);
    serve(fx);
    const { result, unmount } = renderHook(() => useEmergencyVault("grant-1"));
    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    const cb = result.current.entryCallbackMap.get("u1");

    unmount();

    await expect(cb?.getPassword()).rejects.toThrow("Owner key not available");
  });

  it("does not fetch until the vault is unlocked", () => {
    mockUseVault.mockReturnValue({ status: VAULT_STATUS.LOCKED, encryptionKey: null });
    const { result } = renderHook(() => useEmergencyVault("grant-1"));

    expect(mockFetchApi).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(true);
    expect(result.current.displayError).toBeNull();
  });

  it("exposes the expanded-card setter", async () => {
    const fx = await buildEmergencyVaultFixture([]);
    serve(fx);
    const { result } = renderHook(() => useEmergencyVault("grant-1"));

    act(() => result.current.setExpandedId("x"));
    expect(result.current.expandedId).toBe("x");
  });
  describe("key-material wiping", () => {
    // The fixture's owner secret key (buildEmergencyVaultFixture) and grantee
    // vault key seed.
    const OWNER_SECRET_FILL = 0x22;
    const GRANTEE_KEY_SEED = new Uint8Array(32).fill(0x11);

    type Capture = { buffer: Uint8Array; atImport: Uint8Array };

    function isOwnerSecret(bytes: Uint8Array): boolean {
      return bytes.length === 32 && bytes.every((b) => b === OWNER_SECRET_FILL);
    }

    /**
     * Records each buffer the hook hands to WebCrypto, with a copy of its
     * contents at import time, while still running the real import.
     * `failOwnerDerivation` rejects the owner-key HKDF import the way a
     * platform OperationError would; nothing else can make that call fail.
     */
    function captureImports(opts: { failOwnerDerivation?: boolean } = {}) {
      const pkcs8: Capture[] = [];
      const ownerSecret: Capture[] = [];
      const realImportKey = crypto.subtle.importKey.bind(crypto.subtle);
      vi.spyOn(crypto.subtle, "importKey").mockImplementation(((...args: Parameters<SubtleCrypto["importKey"]>) => {
        const [format, keyData, algorithm] = args;
        if (keyData instanceof Uint8Array) {
          const capture = { buffer: keyData, atImport: new Uint8Array(keyData) };
          if (format === "pkcs8") pkcs8.push(capture);
          if (format === "raw" && algorithm === "HKDF" && isOwnerSecret(keyData)) {
            ownerSecret.push(capture);
            if (opts.failOwnerDerivation) {
              return Promise.reject(new DOMException("injected", "OperationError"));
            }
          }
        }
        return realImportKey(...args);
      }) as SubtleCrypto["importKey"]);
      return { pkcs8, ownerSecret };
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("wipes the decrypted grantee private key after importing it", async () => {
      const fx = await buildEmergencyVaultFixture([{ id: "w1", overview: { title: "T" }, blob: {} }]);
      serve(fx);
      const { pkcs8 } = captureImports();
      const { result } = renderHook(() => useEmergencyVault("grant-1"));

      await waitFor(() => expect(result.current.entries).toHaveLength(1));
      expect(pkcs8).toHaveLength(1);
      // PKCS#8 DER starts with a SEQUENCE tag: a real key was imported, then wiped.
      expect(pkcs8[0].atImport[0]).toBe(0x30);
      expect(pkcs8[0].buffer.every((b) => b === 0)).toBe(true);
    });

    it("wipes the decrypted grantee private key when importing it fails", async () => {
      const fx = await buildEmergencyVaultFixture([]);
      // A sealed value that decrypts but is not a PKCS#8 key.
      const notAKey = await encryptPrivateKey(
        new Uint8Array(48).fill(0x5a),
        await deriveEncryptionKey(GRANTEE_KEY_SEED),
      );
      serve({
        ...fx,
        vaultBody: {
          ...fx.vaultBody,
          granteeKeyPair: {
            encryptedPrivateKey: notAKey.ciphertext,
            privateKeyIv: notAKey.iv,
            privateKeyAuthTag: notAKey.authTag,
          },
        },
      });
      const { pkcs8 } = captureImports();
      const { result } = renderHook(() => useEmergencyVault("grant-1"));

      await waitFor(() => expect(result.current.displayError).toBe("networkError"));
      expect(pkcs8).toHaveLength(1);
      expect(pkcs8[0].atImport.every((b) => b === 0x5a)).toBe(true);
      expect(pkcs8[0].buffer.every((b) => b === 0)).toBe(true);
    });

    it("wipes the unwrapped owner secret key after deriving from it", async () => {
      const fx = await buildEmergencyVaultFixture([{ id: "w2", overview: { title: "T" }, blob: {} }]);
      serve(fx);
      const { ownerSecret } = captureImports();
      const { result } = renderHook(() => useEmergencyVault("grant-1"));

      await waitFor(() => expect(result.current.entries).toHaveLength(1));
      expect(ownerSecret).toHaveLength(1);
      expect(ownerSecret[0].buffer.every((b) => b === 0)).toBe(true);
    });

    it("wipes the unwrapped owner secret key when deriving from it fails", async () => {
      const fx = await buildEmergencyVaultFixture([]);
      serve(fx);
      const { ownerSecret } = captureImports({ failOwnerDerivation: true });
      const { result } = renderHook(() => useEmergencyVault("grant-1"));

      await waitFor(() => expect(result.current.displayError).toBe("networkError"));
      expect(ownerSecret).toHaveLength(1);
      expect(ownerSecret[0].buffer.every((b) => b === 0)).toBe(true);
    });
  });
});
