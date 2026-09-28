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
      // Spied on (never populated) so the "never writes to local" test can
      // assert persistSession never touches it — C11 forbidden pattern.
      local: {
        set: vi.fn(),
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

const VALID_JKT = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"; // 43 chars

describe("session-storage", () => {
  describe("persistSession", () => {
    it("stores the token in plain text (C11: must survive SW restart)", async () => {
      await persistSession({
        token: "tok-1",
        expiresAt: 1700000000000,
        userId: "u-1",
        tokenCnfJkt: VALID_JKT,
      });

      // Token is never handed to the ephemeral-key encryptor.
      expect(mockEncryptField).not.toHaveBeenCalledWith("tok-1");
      expect(chrome.storage.session.set).toHaveBeenCalledWith({
        [SESSION_KEY]: expect.objectContaining({
          token: "tok-1",
          expiresAt: 1700000000000,
          userId: "u-1",
        }),
      });
    });

    it("encrypts vaultSecretKey when provided (must NOT survive SW restart)", async () => {
      await persistSession({
        token: "tok-1",
        expiresAt: 1700000000000,
        vaultSecretKey: "secret-key-hex",
        tokenCnfJkt: VALID_JKT,
      });

      expect(mockEncryptField).toHaveBeenCalledTimes(1);
      expect(mockEncryptField).toHaveBeenCalledWith("secret-key-hex");
      const stored = (chrome.storage.session.set as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(stored[SESSION_KEY].encryptedVaultSecretKey).toEqual(FAKE_ENCRYPTED);
      // Raw stored value must not carry the vault secret key in plain text.
      expect(stored[SESSION_KEY]).not.toHaveProperty("vaultSecretKey");
    });

    it("never writes the token to chrome.storage.local", async () => {
      await persistSession({
        token: "tok-1",
        expiresAt: 1700000000000,
        tokenCnfJkt: VALID_JKT,
      });

      expect(chrome.storage.local.set).not.toHaveBeenCalled();
    });

    it("persists without a vaultSecretKey when none is provided (vault locked, connection kept)", async () => {
      await persistSession({ token: "tok-1", expiresAt: 9999, tokenCnfJkt: VALID_JKT });

      expect(mockEncryptField).not.toHaveBeenCalled();
      const stored = (chrome.storage.session.set as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(stored[SESSION_KEY].encryptedVaultSecretKey).toBeUndefined();
    });
  });

  describe("loadSession", () => {
    it("returns the plain token even when vaultSecretKey is absent", async () => {
      mockStorage[SESSION_KEY] = {
        token: "tok-1",
        expiresAt: 1700000000000,
        userId: "u-1",
        tokenCnfJkt: VALID_JKT,
      };

      const result = await loadSession();
      expect(result).toEqual({
        token: "tok-1",
        expiresAt: 1700000000000,
        userId: "u-1",
        vaultSecretKey: undefined,
        ecdhEncrypted: undefined,
        tenantAutoLockMinutes: null,
        requireVaultTimeoutLogout: null,
        tokenCnfJkt: VALID_JKT,
      });
      // Decrypting the token is no longer part of the contract.
      expect(mockDecryptField).not.toHaveBeenCalled();
    });

    // C11 acceptance: the ephemeral key is lost (new module instance / SW
    // restart) → token restored, vault locked (vaultSecretKey undefined).
    it("restores the token when the ephemeral key is lost, leaving the vault locked", async () => {
      mockDecryptField.mockResolvedValueOnce(null); // ephemeral key lost

      mockStorage[SESSION_KEY] = {
        token: "tok-1",
        expiresAt: 1700000000000,
        encryptedVaultSecretKey: { ciphertext: "vsk-enc", iv: "iv2", authTag: "tag2" },
        tokenCnfJkt: VALID_JKT,
      };

      const result = await loadSession();
      expect(result?.token).toBe("tok-1");
      expect(result?.vaultSecretKey).toBeUndefined();
    });

    it("decrypts vaultSecretKey when the ephemeral key is still available", async () => {
      mockDecryptField.mockResolvedValueOnce("vault-key");

      mockStorage[SESSION_KEY] = {
        token: "tok-1",
        expiresAt: 1700000000000,
        encryptedVaultSecretKey: { ciphertext: "vsk-enc", iv: "iv2", authTag: "tag2" },
        tokenCnfJkt: VALID_JKT,
      };

      const result = await loadSession();
      expect(result?.token).toBe("tok-1");
      expect(result?.vaultSecretKey).toBe("vault-key");
    });

    it("returns null when no data exists", async () => {
      const result = await loadSession();
      expect(result).toBeNull();
    });

    it("returns null for malformed data (missing token)", async () => {
      mockStorage[SESSION_KEY] = { expiresAt: 1700000000000 };
      const result = await loadSession();
      expect(result).toBeNull();
    });

    it("returns null when token is not a string", async () => {
      mockStorage[SESSION_KEY] = { token: 123, expiresAt: 1700000000000 };
      const result = await loadSession();
      expect(result).toBeNull();
    });

    it("returns null when encryptedVaultSecretKey is not a valid EncryptedField", async () => {
      mockStorage[SESSION_KEY] = {
        token: "tok-1",
        expiresAt: 1700000000000,
        encryptedVaultSecretKey: { ciphertext: 123, iv: "iv1", authTag: "tag1" }, // wrong type
        tokenCnfJkt: VALID_JKT,
      };
      const result = await loadSession();
      expect(result).toBeNull();
    });

    it("returns null when tokenCnfJkt is absent (pre-PR upgrade scenario)", async () => {
      mockStorage[SESSION_KEY] = {
        token: "tok-1",
        expiresAt: 1700000000000,
        // tokenCnfJkt intentionally omitted — simulates old session without DPoP binding
      };

      const result = await loadSession();
      expect(result).toBeNull();
    });

    it("returns null when tokenCnfJkt has wrong length (42 chars)", async () => {
      mockStorage[SESSION_KEY] = {
        token: "tok-1",
        expiresAt: 1700000000000,
        tokenCnfJkt: "a".repeat(42), // one char too short
      };

      const result = await loadSession();
      expect(result).toBeNull();
    });

    it("returns null when tokenCnfJkt contains invalid charset", async () => {
      mockStorage[SESSION_KEY] = {
        token: "tok-1",
        expiresAt: 1700000000000,
        tokenCnfJkt: "!".repeat(43), // invalid base64url chars
      };

      const result = await loadSession();
      expect(result).toBeNull();
    });

    it("round-trips requireVaultTimeoutLogout", async () => {
      mockStorage[SESSION_KEY] = {
        token: "tok-1",
        expiresAt: 1700000000000,
        tokenCnfJkt: VALID_JKT,
        requireVaultTimeoutLogout: true,
      };
      const result = await loadSession();
      expect(result?.requireVaultTimeoutLogout).toBe(true);
    });

    it("defaults requireVaultTimeoutLogout to null when absent or non-boolean", async () => {
      for (const bad of [undefined, "true" as unknown as boolean, 1 as unknown as boolean]) {
        mockStorage[SESSION_KEY] = {
          token: "tok-1",
          expiresAt: 1700000000000,
          tokenCnfJkt: VALID_JKT,
          requireVaultTimeoutLogout: bad,
        };
        const result = await loadSession();
        expect(result?.requireVaultTimeoutLogout).toBeNull();
      }
    });
  });

  describe("clearSession", () => {
    it("removes the session key", async () => {
      await clearSession();
      expect(chrome.storage.session.remove).toHaveBeenCalledWith(SESSION_KEY);
    });
  });

  describe("personalKeyVersion persistence", () => {
    it("persists personalKeyVersion so a SW restart restores the current key version", async () => {
      await persistSession({
        token: "tok-1",
        expiresAt: 1700000000000,
        personalKeyVersion: 3,
        tokenCnfJkt: VALID_JKT,
      });
      const stored = (chrome.storage.session.set as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(stored[SESSION_KEY].personalKeyVersion).toBe(3);
    });

    it("loadSession round-trips personalKeyVersion", async () => {
      mockStorage[SESSION_KEY] = {
        token: "tok-1",
        expiresAt: 1700000000000,
        tokenCnfJkt: VALID_JKT,
        personalKeyVersion: 3,
      };
      const result = await loadSession();
      expect(result?.personalKeyVersion).toBe(3);
    });

    it("drops a non-integer / negative personalKeyVersion on load (validator)", async () => {
      for (const bad of [1.5, -1, "3" as unknown as number]) {
        mockStorage[SESSION_KEY] = {
          token: "tok-1",
          expiresAt: 1700000000000,
          tokenCnfJkt: VALID_JKT,
          personalKeyVersion: bad,
        };
        const result = await loadSession();
        // Non-vacuous: loadSession returns a valid session (token present),
        // but the bad personalKeyVersion is dropped by the validator.
        expect(result?.token).toBe("tok-1");
        expect(result?.personalKeyVersion).toBeUndefined();
      }
    });
  });
});
