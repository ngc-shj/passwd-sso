import { describe, it, expect } from "vitest";
import {
  hexEncode,
  hexDecode,
  deriveWrappingKey,
  deriveEncryptionKey,
  unwrapSecretKey,
  encryptData,
  decryptData,
  verifyKey,
  computePassphraseVerifier,
} from "../../lib/crypto.js";

describe("crypto", () => {
  describe("hexEncode / hexDecode", () => {
    it("round-trips correctly", () => {
      const original = new Uint8Array([0, 1, 15, 16, 255]);
      const hex = hexEncode(original);
      expect(hex).toBe("00010f10ff");
      const decoded = hexDecode(hex);
      expect(decoded).toEqual(original);
    });

    it("handles empty input", () => {
      expect(hexEncode(new Uint8Array([]))).toBe("");
      expect(hexDecode("")).toEqual(new Uint8Array([]));
    });
  });

  describe("key derivation and encryption", () => {
    const passphrase = "test-passphrase-123";
    const accountSalt = crypto.getRandomValues(new Uint8Array(32));

    it("deriveWrappingKey returns a CryptoKey", async () => {
      const key = await deriveWrappingKey(passphrase, accountSalt);
      expect(key).toBeDefined();
      expect(key.type).toBe("secret");
    });

    it("encrypt and decrypt round-trip", async () => {
      const secretKey = crypto.getRandomValues(new Uint8Array(32));
      const encKey = await deriveEncryptionKey(secretKey);

      const plaintext = "Hello, World!";
      const encrypted = await encryptData(plaintext, encKey);
      const decrypted = await decryptData(encrypted, encKey);

      expect(decrypted).toBe(plaintext);
    });

    it("encrypt and decrypt with AAD", async () => {
      const secretKey = crypto.getRandomValues(new Uint8Array(32));
      const encKey = await deriveEncryptionKey(secretKey);

      const aad = new TextEncoder().encode("entry:123");
      const plaintext = '{"title":"Test"}';
      const encrypted = await encryptData(plaintext, encKey, aad);
      const decrypted = await decryptData(encrypted, encKey, aad);

      expect(decrypted).toBe(plaintext);
    });

    it("decrypt with wrong AAD fails", async () => {
      const secretKey = crypto.getRandomValues(new Uint8Array(32));
      const encKey = await deriveEncryptionKey(secretKey);

      const aad = new TextEncoder().encode("entry:123");
      const wrongAad = new TextEncoder().encode("entry:456");
      const encrypted = await encryptData("secret", encKey, aad);

      await expect(decryptData(encrypted, encKey, wrongAad)).rejects.toThrow();
    });

    it("wrap and unwrap secret key", async () => {
      const wrappingKey = await deriveWrappingKey(passphrase, accountSalt);
      const secretKey = crypto.getRandomValues(new Uint8Array(32));

      // Manually wrap (encrypt) the secret key
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        wrappingKey,
        secretKey,
      );
      const encryptedBytes = new Uint8Array(encrypted);
      const ciphertext = encryptedBytes.slice(0, encryptedBytes.length - 16);
      const authTag = encryptedBytes.slice(encryptedBytes.length - 16);

      const unwrapped = await unwrapSecretKey(
        {
          ciphertext: hexEncode(ciphertext),
          iv: hexEncode(iv),
          authTag: hexEncode(authTag),
        },
        wrappingKey,
      );

      expect(unwrapped).toEqual(secretKey);
    });
  });

  describe("verifyKey", () => {
    it("returns true for correct key", async () => {
      const secretKey = crypto.getRandomValues(new Uint8Array(32));
      const encKey = await deriveEncryptionKey(secretKey);

      // Create verification artifact
      const plaintext = "passwd-sso-vault-verification-v1";
      const artifact = await encryptData(plaintext, encKey);
      const result = await verifyKey(encKey, artifact);
      expect(result).toBe(true);
    });

    it("returns false for wrong key", async () => {
      const secretKey1 = crypto.getRandomValues(new Uint8Array(32));
      const secretKey2 = crypto.getRandomValues(new Uint8Array(32));
      const encKey1 = await deriveEncryptionKey(secretKey1);
      const encKey2 = await deriveEncryptionKey(secretKey2);

      const artifact = await encryptData("passwd-sso-vault-verification-v1", encKey1);
      const result = await verifyKey(encKey2, artifact);
      expect(result).toBe(false);
    });
  });

  describe("computePassphraseVerifier", () => {
    it("produces consistent results for same input", async () => {
      const salt = new Uint8Array(32).fill(42);
      const v1 = await computePassphraseVerifier("test", salt);
      const v2 = await computePassphraseVerifier("test", salt);
      expect(v1).toBe(v2);
      expect(v1.length).toBe(64); // 256-bit hash as hex
    });

    it("produces different results for different passphrases", async () => {
      const salt = new Uint8Array(32).fill(42);
      const v1 = await computePassphraseVerifier("pass1", salt);
      const v2 = await computePassphraseVerifier("pass2", salt);
      expect(v1).not.toBe(v2);
    });
  });
});
