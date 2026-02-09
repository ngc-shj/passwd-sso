import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  generateOrgKey,
  wrapOrgKey,
  unwrapOrgKey,
  encryptServerData,
  decryptServerData,
} from "./crypto-server";

describe("crypto-server", () => {
  const originalMasterKey = process.env.ORG_MASTER_KEY;

  afterAll(() => {
    // Restore original env
    process.env.ORG_MASTER_KEY = originalMasterKey;
  });

  describe("generateOrgKey", () => {
    it("returns a 32-byte buffer", () => {
      const key = generateOrgKey();
      expect(Buffer.isBuffer(key)).toBe(true);
      expect(key.byteLength).toBe(32);
    });

    it("generates unique keys", () => {
      const key1 = generateOrgKey();
      const key2 = generateOrgKey();
      expect(key1.equals(key2)).toBe(false);
    });
  });

  describe("wrapOrgKey / unwrapOrgKey", () => {
    it("roundtrips correctly", () => {
      const orgKey = generateOrgKey();
      const wrapped = wrapOrgKey(orgKey);
      const unwrapped = unwrapOrgKey(wrapped);
      expect(unwrapped.equals(orgKey)).toBe(true);
    });

    it("returns valid encrypted data structure", () => {
      const orgKey = generateOrgKey();
      const wrapped = wrapOrgKey(orgKey);

      expect(typeof wrapped.ciphertext).toBe("string");
      expect(wrapped.iv).toHaveLength(24); // 12 bytes hex
      expect(wrapped.authTag).toHaveLength(32); // 16 bytes hex
    });

    it("fails with tampered ciphertext", () => {
      const orgKey = generateOrgKey();
      const wrapped = wrapOrgKey(orgKey);

      wrapped.ciphertext = "ff" + wrapped.ciphertext.slice(2);
      expect(() => unwrapOrgKey(wrapped)).toThrow();
    });

    it("fails with tampered authTag", () => {
      const orgKey = generateOrgKey();
      const wrapped = wrapOrgKey(orgKey);

      wrapped.authTag = "00".repeat(16);
      expect(() => unwrapOrgKey(wrapped)).toThrow();
    });
  });

  describe("encryptServerData / decryptServerData", () => {
    it("roundtrips correctly", () => {
      const orgKey = generateOrgKey();
      const plaintext = JSON.stringify({
        title: "Test Password",
        username: "admin",
        password: "secret123",
      });

      const encrypted = encryptServerData(plaintext, orgKey);
      const decrypted = decryptServerData(encrypted, orgKey);
      expect(decrypted).toBe(plaintext);
    });

    it("returns valid encrypted data structure", () => {
      const orgKey = generateOrgKey();
      const encrypted = encryptServerData("hello", orgKey);

      expect(typeof encrypted.ciphertext).toBe("string");
      expect(encrypted.iv).toHaveLength(24);
      expect(encrypted.authTag).toHaveLength(32);
    });

    it("handles empty string", () => {
      const orgKey = generateOrgKey();
      const encrypted = encryptServerData("", orgKey);
      const decrypted = decryptServerData(encrypted, orgKey);
      expect(decrypted).toBe("");
    });

    it("handles unicode content", () => {
      const orgKey = generateOrgKey();
      const plaintext = "パスワード管理 🔐";
      const encrypted = encryptServerData(plaintext, orgKey);
      const decrypted = decryptServerData(encrypted, orgKey);
      expect(decrypted).toBe(plaintext);
    });

    it("fails with wrong key", () => {
      const orgKey1 = generateOrgKey();
      const orgKey2 = generateOrgKey();
      const encrypted = encryptServerData("secret", orgKey1);

      expect(() => decryptServerData(encrypted, orgKey2)).toThrow();
    });

    it("fails with tampered ciphertext", () => {
      const orgKey = generateOrgKey();
      const encrypted = encryptServerData("secret", orgKey);

      encrypted.ciphertext = "ff" + encrypted.ciphertext.slice(2);
      expect(() => decryptServerData(encrypted, orgKey)).toThrow();
    });

    it("produces different ciphertexts for same plaintext (random IV)", () => {
      const orgKey = generateOrgKey();
      const e1 = encryptServerData("same input", orgKey);
      const e2 = encryptServerData("same input", orgKey);
      expect(e1.ciphertext).not.toBe(e2.ciphertext);
      expect(e1.iv).not.toBe(e2.iv);
    });
  });

  describe("getMasterKey validation", () => {
    it("throws when ORG_MASTER_KEY is missing", () => {
      const saved = process.env.ORG_MASTER_KEY;
      delete process.env.ORG_MASTER_KEY;

      expect(() => wrapOrgKey(generateOrgKey())).toThrow(
        "ORG_MASTER_KEY must be a 64-char hex string"
      );

      process.env.ORG_MASTER_KEY = saved;
    });

    it("throws when ORG_MASTER_KEY is wrong length", () => {
      const saved = process.env.ORG_MASTER_KEY;
      process.env.ORG_MASTER_KEY = "abcd";

      expect(() => wrapOrgKey(generateOrgKey())).toThrow(
        "ORG_MASTER_KEY must be a 64-char hex string"
      );

      process.env.ORG_MASTER_KEY = saved;
    });
  });
});
