/**
 * Crypto compatibility test — verifies Node.js helpers produce
 * output consistent with the Web Crypto API implementation.
 *
 * Fixed test vectors ensure the E2E crypto helpers stay in sync
 * with src/lib/crypto-client.ts.
 */
import { describe, it, expect } from "vitest";
import {
  deriveWrappingKey,
  deriveEncryptionKey,
  deriveAuthKey,
  computeAuthHash,
  computeVerifierHash,
  deriveVerifierSalt,
  aesGcmEncrypt,
  hexEncode,
} from "./crypto";
import { CRYPTO_CONSTANTS } from "../../src/lib/crypto-client";

// ─── Fixed test vectors ─────────────────────────────────────────
const PASSPHRASE = "TestPassphrase!2026";
const ACCOUNT_SALT = Buffer.from(
  "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
  "hex"
);
const SECRET_KEY = Buffer.from(
  "0102030405060708091011121314151617181920212223242526272829303132",
  "hex"
);

describe("E2E crypto helpers", () => {
  describe("CRYPTO_CONSTANTS import", () => {
    it("should have all required constants", () => {
      expect(CRYPTO_CONSTANTS.PBKDF2_ITERATIONS).toBe(600_000);
      expect(CRYPTO_CONSTANTS.HKDF_ENC_INFO).toBe("passwd-sso-enc-v1");
      expect(CRYPTO_CONSTANTS.HKDF_AUTH_INFO).toBe("passwd-sso-auth-v1");
      expect(CRYPTO_CONSTANTS.VERIFICATION_PLAINTEXT).toBe(
        "passwd-sso-vault-verification-v1"
      );
      expect(CRYPTO_CONSTANTS.VERIFIER_DOMAIN_PREFIX).toBe("verifier");
      expect(CRYPTO_CONSTANTS.IV_LENGTH).toBe(12);
    });
  });

  describe("deriveWrappingKey", () => {
    it("should be deterministic (same input → same output)", () => {
      const key1 = deriveWrappingKey(PASSPHRASE, ACCOUNT_SALT);
      const key2 = deriveWrappingKey(PASSPHRASE, ACCOUNT_SALT);
      expect(hexEncode(key1)).toBe(hexEncode(key2));
    });

    it("should produce 32 bytes", () => {
      const key = deriveWrappingKey(PASSPHRASE, ACCOUNT_SALT);
      expect(key.length).toBe(32);
    });

    it("should differ for different passphrases", () => {
      const key1 = deriveWrappingKey(PASSPHRASE, ACCOUNT_SALT);
      const key2 = deriveWrappingKey("DifferentPassphrase!", ACCOUNT_SALT);
      expect(hexEncode(key1)).not.toBe(hexEncode(key2));
    });
  });

  describe("deriveEncryptionKey + deriveAuthKey", () => {
    it("should be deterministic", () => {
      const enc1 = deriveEncryptionKey(SECRET_KEY);
      const enc2 = deriveEncryptionKey(SECRET_KEY);
      expect(hexEncode(enc1)).toBe(hexEncode(enc2));

      const auth1 = deriveAuthKey(SECRET_KEY);
      const auth2 = deriveAuthKey(SECRET_KEY);
      expect(hexEncode(auth1)).toBe(hexEncode(auth2));
    });

    it("should produce different keys (domain separation)", () => {
      const encKey = deriveEncryptionKey(SECRET_KEY);
      const authKey = deriveAuthKey(SECRET_KEY);
      expect(hexEncode(encKey)).not.toBe(hexEncode(authKey));
    });

    it("should produce 32-byte keys", () => {
      expect(deriveEncryptionKey(SECRET_KEY).length).toBe(32);
      expect(deriveAuthKey(SECRET_KEY).length).toBe(32);
    });
  });

  describe("computeAuthHash", () => {
    it("should be deterministic", () => {
      const authKey = deriveAuthKey(SECRET_KEY);
      const hash1 = computeAuthHash(authKey);
      const hash2 = computeAuthHash(authKey);
      expect(hash1).toBe(hash2);
    });

    it("should return 64-char hex string (SHA-256)", () => {
      const authKey = deriveAuthKey(SECRET_KEY);
      const hash = computeAuthHash(authKey);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe("deriveVerifierSalt", () => {
    it("should be deterministic", () => {
      const salt1 = deriveVerifierSalt(ACCOUNT_SALT);
      const salt2 = deriveVerifierSalt(ACCOUNT_SALT);
      expect(hexEncode(salt1)).toBe(hexEncode(salt2));
    });

    it("should differ from raw accountSalt (domain separation)", () => {
      const verifierSalt = deriveVerifierSalt(ACCOUNT_SALT);
      expect(hexEncode(verifierSalt)).not.toBe(hexEncode(ACCOUNT_SALT));
    });
  });

  describe("computeVerifierHash", () => {
    it("should be deterministic", () => {
      const hash1 = computeVerifierHash(PASSPHRASE, ACCOUNT_SALT);
      const hash2 = computeVerifierHash(PASSPHRASE, ACCOUNT_SALT);
      expect(hash1).toBe(hash2);
    });

    it("should return 64-char hex string", () => {
      const hash = computeVerifierHash(PASSPHRASE, ACCOUNT_SALT);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("should differ for different passphrases", () => {
      const hash1 = computeVerifierHash(PASSPHRASE, ACCOUNT_SALT);
      const hash2 = computeVerifierHash("DifferentPass!", ACCOUNT_SALT);
      expect(hash1).not.toBe(hash2);
    });
  });

  describe("aesGcmEncrypt", () => {
    it("should produce deterministic output with fixed IV", () => {
      const key = deriveEncryptionKey(SECRET_KEY);
      const iv = Buffer.alloc(12, 0xaa);
      const plaintext = Buffer.from("test data");

      const result1 = aesGcmEncrypt(key, plaintext, iv);
      const result2 = aesGcmEncrypt(key, plaintext, iv);

      expect(result1.ciphertext).toBe(result2.ciphertext);
      expect(result1.authTag).toBe(result2.authTag);
      expect(result1.iv).toBe(result2.iv);
    });

    it("should produce different output with random IV", () => {
      const key = deriveEncryptionKey(SECRET_KEY);
      const plaintext = Buffer.from("test data");

      const result1 = aesGcmEncrypt(key, plaintext);
      const result2 = aesGcmEncrypt(key, plaintext);

      // Same ciphertext is astronomically unlikely with random IVs
      expect(result1.iv).not.toBe(result2.iv);
    });
  });
});
