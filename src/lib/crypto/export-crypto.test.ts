import { describe, it, expect } from "vitest";
import { encryptExport, decryptExport, isEncryptedExport } from "./export-crypto";

describe("export-crypto", () => {
  describe("encryptExport / decryptExport", () => {
    it("round-trips CSV content", async () => {
      const csv = "name,password\ntest,secret123";
      const password = "myExportPassword";

      const encrypted = await encryptExport(csv, password, "csv");
      const { plaintext, format } = await decryptExport(encrypted, password);

      expect(plaintext).toBe(csv);
      expect(format).toBe("csv");
    });

    it("round-trips JSON content", async () => {
      const json = JSON.stringify({ entries: [{ name: "test" }] });
      const password = "anotherPassword!";

      const encrypted = await encryptExport(json, password, "json");
      const { plaintext, format } = await decryptExport(encrypted, password);

      expect(plaintext).toBe(json);
      expect(format).toBe("json");
    });

    it("fails with wrong password", async () => {
      const data = "sensitive data";
      const encrypted = await encryptExport(data, "correctPassword", "json");

      await expect(
        decryptExport(encrypted, "wrongPassword")
      ).rejects.toThrow();
    });

    it("handles empty string", async () => {
      const encrypted = await encryptExport("", "password12", "csv");
      const { plaintext } = await decryptExport(encrypted, "password12");
      expect(plaintext).toBe("");
    });

    it("handles large data", async () => {
      const large = "x".repeat(100_000);
      const encrypted = await encryptExport(large, "password12", "json");
      const { plaintext } = await decryptExport(encrypted, "password12");
      expect(plaintext).toBe(large);
    });

    it("produces valid encrypted file structure", async () => {
      const encrypted = await encryptExport("test", "password12", "csv");

      expect(encrypted.version).toBe(1);
      expect(encrypted.cipher).toBe("AES-256-GCM");
      expect(encrypted.format).toBe("csv");
      expect(encrypted.kdf.name).toBe("PBKDF2-HMAC-SHA256");
      expect(encrypted.kdf.iterations).toBe(600_000);
      expect(encrypted.kdf.salt).toMatch(/^[0-9a-f]{32}$/); // 16 bytes = 32 hex chars
      expect(encrypted.iv).toMatch(/^[0-9a-f]{24}$/); // 12 bytes = 24 hex chars
      expect(encrypted.authTag).toMatch(/^[0-9a-f]{32}$/); // 16 bytes = 32 hex chars
      expect(typeof encrypted.ciphertext).toBe("string");
      expect(typeof encrypted.createdAt).toBe("string");
    });

    it("generates unique salt and IV per encryption", async () => {
      const a = await encryptExport("test", "password12", "csv");
      const b = await encryptExport("test", "password12", "csv");

      expect(a.kdf.salt).not.toBe(b.kdf.salt);
      expect(a.iv).not.toBe(b.iv);
    });

    it("round-trips Unicode / multibyte content", async () => {
      const unicode = "タイトル,ユーザー名,パスワード\nテスト,admin,秘密のパス🔑";
      const password = "パスワード保護テスト";

      const encrypted = await encryptExport(unicode, password, "csv");
      const { plaintext, format } = await decryptExport(encrypted, password);

      expect(plaintext).toBe(unicode);
      expect(format).toBe("csv");
    });

    it("preserves format field correctly", async () => {
      const csvEnc = await encryptExport("a,b", "password12", "csv");
      const jsonEnc = await encryptExport("{}", "password12", "json");

      expect(csvEnc.format).toBe("csv");
      expect(jsonEnc.format).toBe("json");

      const { format: f1 } = await decryptExport(csvEnc, "password12");
      const { format: f2 } = await decryptExport(jsonEnc, "password12");

      expect(f1).toBe("csv");
      expect(f2).toBe("json");
    });

    it("fails on tampered ciphertext", async () => {
      const encrypted = await encryptExport("secret", "password12", "json");
      const tampered = {
        ...encrypted,
        ciphertext: encrypted.ciphertext.replace(/[0-9a-f]/, (c) =>
          c === "0" ? "1" : "0"
        ),
      };

      await expect(decryptExport(tampered, "password12")).rejects.toThrow();
    });

    it("fails on tampered authTag", async () => {
      const encrypted = await encryptExport("secret", "password12", "json");
      const tampered = {
        ...encrypted,
        authTag: "0".repeat(32),
      };

      await expect(decryptExport(tampered, "password12")).rejects.toThrow();
    });
  });

  describe("isEncryptedExport", () => {
    it("returns true for encrypted export file", async () => {
      const encrypted = await encryptExport("test", "password12", "json");
      expect(isEncryptedExport(encrypted)).toBe(true);
    });

    it("returns true for serialized/deserialized encrypted file", async () => {
      const encrypted = await encryptExport("test", "password12", "json");
      const parsed = JSON.parse(JSON.stringify(encrypted));
      expect(isEncryptedExport(parsed)).toBe(true);
    });

    it("returns false for regular JSON export", () => {
      const regular = {
        exportedAt: "2025-01-01",
        entries: [{ type: "login", name: "test" }],
      };
      expect(isEncryptedExport(regular)).toBe(false);
    });

    it("returns false for null", () => {
      expect(isEncryptedExport(null)).toBe(false);
    });

    it("returns false for string", () => {
      expect(isEncryptedExport("not encrypted")).toBe(false);
    });

    it("returns false for object missing required fields", () => {
      expect(isEncryptedExport({ version: 1 })).toBe(false);
      expect(isEncryptedExport({ version: 1, cipher: "AES-256-GCM" })).toBe(false);
    });

    it("returns false for wrong version", () => {
      expect(
        isEncryptedExport({
          version: 2,
          cipher: "AES-256-GCM",
          ciphertext: "abc",
          iv: "def",
          authTag: "ghi",
          kdf: { name: "PBKDF2-HMAC-SHA256" },
        })
      ).toBe(false);
    });

    it("returns false for wrong cipher", () => {
      expect(
        isEncryptedExport({
          version: 1,
          cipher: "AES-128-CBC",
          ciphertext: "abc",
          iv: "def",
          authTag: "ghi",
          kdf: { name: "PBKDF2-HMAC-SHA256" },
        })
      ).toBe(false);
    });

    it("returns false for array", () => {
      expect(isEncryptedExport([1, 2, 3])).toBe(false);
    });

    it("returns false for number", () => {
      expect(isEncryptedExport(42)).toBe(false);
    });

    it("returns false for undefined", () => {
      expect(isEncryptedExport(undefined)).toBe(false);
    });
  });
});
