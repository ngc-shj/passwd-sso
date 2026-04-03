import { describe, it, expect, vi, beforeEach } from "vitest";
import { SESSION_KEY } from "../../lib/constants";
import type { EncryptedField } from "../../lib/session-crypto";

// Fake encrypted field returned by the encryptField mock
const FAKE_ENCRYPTED: EncryptedField = { ciphertext: "enc", iv: "iv1", authTag: "tag1" };

// Hoisted mock definitions so they are available before module import
const { mockEncryptField, mockDecryptField } = vi.hoisted(() => {
  const mockEncryptField = vi.fn(async (_plaintext: string) => FAKE_ENCRYPTED);
  const mockDecryptField = vi.fn(async (_blob: EncryptedField) => "decrypted-value");
  return { mockEncryptField, mockDecryptField };
});

vi.mock("../../lib/session-crypto", () => ({
  encryptField: mockEncryptField,
  decryptField: mockDecryptField,
}));

let mockStorage: Record<string, unknown>;

beforeEach(() => {
  mockStorage = {};
  vi.clearAllMocks();
  vi.stubGlobal("chrome", {
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({
          [key]: mockStorage[key] ?? undefined,
        })),
        set: vi.fn(async (obj: Record<string, unknown>) => {
          Object.assign(mockStorage, obj);
        }),
        remove: vi.fn(async (key: string) => {
          delete mockStorage[key];
        }),
      },
    },
  });

  // Reset mocks to their default behaviour before each test
  mockEncryptField.mockImplementation(async (_plaintext: string) => FAKE_ENCRYPTED);
  mockDecryptField.mockImplementation(async (_blob: EncryptedField) => "decrypted-value");
});

// Import after chrome is stubbed and mocks are registered
const { persistSession, loadSession, clearSession } = await import(
  "../../lib/session-storage"
);

describe("session-storage", () => {
  describe("persistSession", () => {
    it("stores encrypted format (encryptedToken, not token)", async () => {
      await persistSession({
        token: "tok-1",
        expiresAt: 1700000000000,
        userId: "u-1",
      });

      expect(mockEncryptField).toHaveBeenCalledWith("tok-1");
      expect(chrome.storage.session.set).toHaveBeenCalledWith({
        [SESSION_KEY]: expect.objectContaining({
          encryptedToken: FAKE_ENCRYPTED,
          expiresAt: 1700000000000,
          userId: "u-1",
        }),
      });

      // Raw stored value must not have a plain 'token' field
      const stored = (chrome.storage.session.set as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(stored[SESSION_KEY]).not.toHaveProperty("token");
    });

    it("encrypts vaultSecretKey when provided", async () => {
      mockEncryptField
        .mockResolvedValueOnce(FAKE_ENCRYPTED) // for token
        .mockResolvedValueOnce({ ciphertext: "vsk-enc", iv: "iv2", authTag: "tag2" }); // for vaultSecretKey

      await persistSession({
        token: "tok-1",
        expiresAt: 1700000000000,
        vaultSecretKey: "secret-key-hex",
      });

      expect(mockEncryptField).toHaveBeenCalledTimes(2);
      expect(mockEncryptField).toHaveBeenNthCalledWith(1, "tok-1");
      expect(mockEncryptField).toHaveBeenNthCalledWith(2, "secret-key-hex");
    });

    it("does not persist when encryptField returns null", async () => {
      mockEncryptField.mockResolvedValueOnce(null);

      await persistSession({ token: "tok-1", expiresAt: 9999 });

      expect(chrome.storage.session.set).not.toHaveBeenCalled();
    });
  });

  describe("loadSession", () => {
    it("returns decrypted values for a valid encrypted session", async () => {
      mockDecryptField.mockResolvedValueOnce("tok-1");

      mockStorage[SESSION_KEY] = {
        encryptedToken: FAKE_ENCRYPTED,
        expiresAt: 1700000000000,
        userId: "u-1",
      };

      const result = await loadSession();
      expect(result).toEqual({
        token: "tok-1",
        expiresAt: 1700000000000,
        userId: "u-1",
        vaultSecretKey: undefined,
        ecdhEncrypted: undefined,
      });
    });

    it("returns null for old plaintext format (token as string)", async () => {
      mockStorage[SESSION_KEY] = {
        token: "tok-1",
        expiresAt: 1700000000000,
        userId: "u-1",
      };

      const result = await loadSession();
      expect(result).toBeNull();
    });

    it("returns null when decryptField returns null (ephemeral key lost)", async () => {
      mockDecryptField.mockResolvedValueOnce(null);

      mockStorage[SESSION_KEY] = {
        encryptedToken: FAKE_ENCRYPTED,
        expiresAt: 1700000000000,
      };

      const result = await loadSession();
      expect(result).toBeNull();
    });

    it("returns null when no data exists", async () => {
      const result = await loadSession();
      expect(result).toBeNull();
    });

    it("returns null for malformed data (missing encryptedToken)", async () => {
      mockStorage[SESSION_KEY] = { expiresAt: 1700000000000 };
      const result = await loadSession();
      expect(result).toBeNull();
    });

    it("returns null when encryptedToken is not a valid EncryptedField", async () => {
      mockStorage[SESSION_KEY] = {
        encryptedToken: { ciphertext: 123, iv: "iv1", authTag: "tag1" }, // ciphertext wrong type
        expiresAt: 1700000000000,
      };
      const result = await loadSession();
      expect(result).toBeNull();
    });

    it("decrypts vaultSecretKey when present", async () => {
      mockDecryptField
        .mockResolvedValueOnce("tok-1")      // for encryptedToken
        .mockResolvedValueOnce("vault-key"); // for encryptedVaultSecretKey

      mockStorage[SESSION_KEY] = {
        encryptedToken: FAKE_ENCRYPTED,
        expiresAt: 1700000000000,
        encryptedVaultSecretKey: { ciphertext: "vsk-enc", iv: "iv2", authTag: "tag2" },
      };

      const result = await loadSession();
      expect(result?.vaultSecretKey).toBe("vault-key");
    });
  });

  describe("clearSession", () => {
    it("removes the session key", async () => {
      await clearSession();
      expect(chrome.storage.session.remove).toHaveBeenCalledWith(SESSION_KEY);
    });
  });
});
