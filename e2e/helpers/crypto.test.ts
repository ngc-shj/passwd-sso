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
import { CRYPTO_CONSTANTS } from "../../src/lib/crypto/crypto-client";
import { AUTH_TAG_LENGTH, AES_KEY_LENGTH } from "../../src/lib/crypto/crypto-params";

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

  describe("crypto-params value pins", () => {
    it("AUTH_TAG_LENGTH must be 16 bytes", () => {
      expect(AUTH_TAG_LENGTH).toBe(16);
    });

    it("AES_KEY_LENGTH must be 256 bits", () => {
      expect(AES_KEY_LENGTH).toBe(256);
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

    // Golden vectors shared with the app (src/lib/crypto/crypto-client.test.ts)
    // and CLI (cli/src/__tests__/unit/crypto.test.ts). All three independent
    // implementations must produce byte-identical output for the same secret
    // key — the e2e helper's auth hash is sent to the real server during test
    // setup, so drift here surfaces as a confusing unlock failure deep in the
    // Playwright suite instead of a clear vector mismatch here.
    it("matches the golden auth-key bytes and hash for a fixed secret key", () => {
      const fixedKey = Buffer.alloc(32, 0xaa);
      const authKey = deriveAuthKey(fixedKey);
      expect(hexEncode(authKey)).toBe(
        "7d06a70d843366f75f7db101639b7caa4509b3cd0ad8a272c6873a9dcfb8b889"
      );
      expect(computeAuthHash(authKey)).toBe(
        "45afd70f6aeb06a70078f5253391eea780b5503a9883a98c141c4a742f45aa21"
      );
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
