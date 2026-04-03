import { describe, it, expect, afterEach } from "vitest";
import {
  encryptField,
  decryptField,
  hasEphemeralKey,
  clearEphemeralKey,
  type EncryptedField,
} from "../../lib/session-crypto";

afterEach(() => {
  // Reset ephemeral key state between tests
  clearEphemeralKey();
});

describe("session-crypto", () => {
  describe("encryptField / decryptField round-trip", () => {
    it("decrypts to the original plaintext", async () => {
      const plaintext = "super-secret-token-abc123";
      const encrypted = await encryptField(plaintext);
      expect(encrypted).not.toBeNull();

      const decrypted = await decryptField(encrypted!);
      expect(decrypted).toBe(plaintext);
    });

    it("round-trips an empty string", async () => {
      const encrypted = await encryptField("");
      expect(encrypted).not.toBeNull();
      expect(await decryptField(encrypted!)).toBe("");
    });

    it("round-trips a unicode string", async () => {
      const plaintext = "パスワード🔐";
      const encrypted = await encryptField(plaintext);
      expect(encrypted).not.toBeNull();
      expect(await decryptField(encrypted!)).toBe(plaintext);
    });
  });

  describe("encryptField return shape", () => {
    it("returns an EncryptedField with ciphertext, iv, and authTag as hex strings", async () => {
      const result = await encryptField("test-value");
      expect(result).not.toBeNull();

      const field = result as EncryptedField;
      expect(typeof field.ciphertext).toBe("string");
      expect(typeof field.iv).toBe("string");
      expect(typeof field.authTag).toBe("string");

      // Hex strings must be non-empty and only contain hex chars
      expect(field.ciphertext).toMatch(/^[0-9a-f]+$/);
      expect(field.iv).toMatch(/^[0-9a-f]+$/);
      expect(field.authTag).toMatch(/^[0-9a-f]+$/);

      // IV is 12 bytes → 24 hex chars; authTag is 16 bytes → 32 hex chars
      expect(field.iv).toHaveLength(24);
      expect(field.authTag).toHaveLength(32);
    });

    it("produces a different IV on each call", async () => {
      const a = await encryptField("same");
      const b = await encryptField("same");
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(a!.iv).not.toBe(b!.iv);
    });
  });

  describe("hasEphemeralKey", () => {
    it("returns false before any encryption", () => {
      expect(hasEphemeralKey()).toBe(false);
    });

    it("returns true after encryptField is called", async () => {
      expect(hasEphemeralKey()).toBe(false);
      await encryptField("anything");
      expect(hasEphemeralKey()).toBe(true);
    });
  });

  describe("decryptField after clearEphemeralKey", () => {
    it("returns null when the ephemeral key has been cleared", async () => {
      const encrypted = await encryptField("some-token");
      expect(encrypted).not.toBeNull();

      clearEphemeralKey();
      expect(hasEphemeralKey()).toBe(false);

      const result = await decryptField(encrypted!);
      expect(result).toBeNull();
    });
  });
});
