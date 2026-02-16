import { describe, it, expect } from "vitest";
import {
  generateRecoveryKey,
  formatRecoveryKey,
  parseRecoveryKey,
  base32Encode,
  base32Decode,
  deriveRecoveryWrappingKey,
  wrapSecretKeyWithRecovery,
  unwrapSecretKeyWithRecovery,
  computeRecoveryVerifierHash,
} from "./crypto-recovery";
import { hexEncode } from "./crypto-client";

describe("crypto-recovery", () => {
  // ─── Base32 ─────────────────────────────────────────────────

  describe("base32Encode / base32Decode", () => {
    it("round-trips arbitrary bytes", () => {
      const data = crypto.getRandomValues(new Uint8Array(32));
      const encoded = base32Encode(data);
      const decoded = base32Decode(encoded);
      expect(decoded).toEqual(data);
    });

    it("encodes known vectors (RFC 4648)", () => {
      // "foo" → "MZXW6==="  (no padding in our impl → "MZXW6")
      const foo = new TextEncoder().encode("foo");
      expect(base32Encode(foo)).toBe("MZXW6");
    });

    it("throws on invalid characters", () => {
      expect(() => base32Decode("MZXW!")).toThrow("INVALID_CHARACTER");
    });
  });

  // ─── Recovery Key Generation ──────────────────────────────

  describe("generateRecoveryKey", () => {
    it("generates 32 bytes", () => {
      const key = generateRecoveryKey();
      expect(key.length).toBe(32);
      expect(key).toBeInstanceOf(Uint8Array);
    });

    it("generates unique keys", () => {
      const key1 = generateRecoveryKey();
      const key2 = generateRecoveryKey();
      expect(hexEncode(key1)).not.toBe(hexEncode(key2));
    });
  });

  // ─── Format / Parse ───────────────────────────────────────

  describe("formatRecoveryKey / parseRecoveryKey", () => {
    it("round-trips correctly", async () => {
      const key = generateRecoveryKey();
      const formatted = await formatRecoveryKey(key);
      const parsed = await parseRecoveryKey(formatted);
      expect(parsed).toEqual(key);
    });

    it("formats as hyphen-separated 4-char groups", async () => {
      const key = generateRecoveryKey();
      const formatted = await formatRecoveryKey(key);
      const parts = formatted.split("-");
      // 54 chars / 4 = 13 full groups + 1 group of 2 chars = 14 groups
      expect(parts.length).toBe(14);
      for (let i = 0; i < 13; i++) {
        expect(parts[i].length).toBe(4);
      }
      expect(parts[13].length).toBe(2); // checksum
    });

    it("handles spaces instead of hyphens", async () => {
      const key = generateRecoveryKey();
      const formatted = await formatRecoveryKey(key);
      const withSpaces = formatted.replace(/-/g, " ");
      const parsed = await parseRecoveryKey(withSpaces);
      expect(parsed).toEqual(key);
    });

    it("handles lowercase input", async () => {
      const key = generateRecoveryKey();
      const formatted = await formatRecoveryKey(key);
      const lower = formatted.toLowerCase();
      const parsed = await parseRecoveryKey(lower);
      expect(parsed).toEqual(key);
    });

    it("handles mixed case and no separators", async () => {
      const key = generateRecoveryKey();
      const formatted = await formatRecoveryKey(key);
      const noSep = formatted.replace(/-/g, "");
      const parsed = await parseRecoveryKey(noSep);
      expect(parsed).toEqual(key);
    });

    it("throws INVALID_LENGTH for too short input", async () => {
      await expect(parseRecoveryKey("ABCD-EFGH")).rejects.toThrow("INVALID_LENGTH");
    });

    it("throws INVALID_CHARACTER for invalid chars", async () => {
      // '0', '1', '8', '9' are not in Base32 alphabet
      const bad = "0".repeat(54);
      await expect(parseRecoveryKey(bad)).rejects.toThrow("INVALID_CHARACTER");
    });

    it("throws INVALID_CHECKSUM for wrong checksum", async () => {
      const key = generateRecoveryKey();
      const formatted = await formatRecoveryKey(key);
      const clean = formatted.replace(/-/g, "");
      // Flip last 2 chars (checksum)
      const data = clean.slice(0, 52);
      // Construct wrong checksum
      const wrongCs = clean[52] === "A" ? "B" : "A";
      const tampered = data + wrongCs + clean[53];
      await expect(parseRecoveryKey(tampered)).rejects.toThrow("INVALID_CHECKSUM");
    });
  });

  // ─── Key Derivation ───────────────────────────────────────

  describe("deriveRecoveryWrappingKey", () => {
    it("produces a valid AES-GCM key", async () => {
      const rk = generateRecoveryKey();
      const salt = crypto.getRandomValues(new Uint8Array(32));
      const key = await deriveRecoveryWrappingKey(rk, salt);
      expect(key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    });

    it("different salts produce different keys", async () => {
      const rk = generateRecoveryKey();
      const salt1 = crypto.getRandomValues(new Uint8Array(32));
      const salt2 = crypto.getRandomValues(new Uint8Array(32));
      const key1 = await deriveRecoveryWrappingKey(rk, salt1);
      const key2 = await deriveRecoveryWrappingKey(rk, salt2);

      // Encrypt with key1, try to decrypt with key2 — should fail
      const plaintext = new Uint8Array([1, 2, 3, 4]);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key1,
        plaintext,
      );

      await expect(
        crypto.subtle.decrypt({ name: "AES-GCM", iv }, key2, encrypted),
      ).rejects.toThrow();
    });
  });

  // ─── Wrap / Unwrap SecretKey ──────────────────────────────

  describe("wrapSecretKeyWithRecovery / unwrapSecretKeyWithRecovery", () => {
    it("round-trips the secret key", async () => {
      const secretKey = crypto.getRandomValues(new Uint8Array(32));
      const recoveryKey = generateRecoveryKey();

      const wrapped = await wrapSecretKeyWithRecovery(secretKey, recoveryKey);
      const unwrapped = await unwrapSecretKeyWithRecovery(
        {
          encryptedSecretKey: wrapped.encryptedSecretKey,
          iv: wrapped.iv,
          authTag: wrapped.authTag,
        },
        recoveryKey,
        wrapped.hkdfSalt,
      );

      expect(unwrapped).toEqual(secretKey);
    });

    it("fails with wrong recovery key", async () => {
      const secretKey = crypto.getRandomValues(new Uint8Array(32));
      const recoveryKey = generateRecoveryKey();
      const wrongKey = generateRecoveryKey();

      const wrapped = await wrapSecretKeyWithRecovery(secretKey, recoveryKey);

      await expect(
        unwrapSecretKeyWithRecovery(
          {
            encryptedSecretKey: wrapped.encryptedSecretKey,
            iv: wrapped.iv,
            authTag: wrapped.authTag,
          },
          wrongKey,
          wrapped.hkdfSalt,
        ),
      ).rejects.toThrow();
    });

    it("returns a verifier hash in hex", async () => {
      const secretKey = crypto.getRandomValues(new Uint8Array(32));
      const recoveryKey = generateRecoveryKey();

      const wrapped = await wrapSecretKeyWithRecovery(secretKey, recoveryKey);
      expect(wrapped.verifierHash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // ─── Verifier Hash ───────────────────────────────────────

  describe("computeRecoveryVerifierHash", () => {
    it("produces a 64-char hex string", async () => {
      const rk = generateRecoveryKey();
      const hash = await computeRecoveryVerifierHash(rk);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("is deterministic (same key → same hash)", async () => {
      const rk = generateRecoveryKey();
      const hash1 = await computeRecoveryVerifierHash(rk);
      const hash2 = await computeRecoveryVerifierHash(rk);
      expect(hash1).toBe(hash2);
    });

    it("different keys produce different hashes", async () => {
      const rk1 = generateRecoveryKey();
      const rk2 = generateRecoveryKey();
      const hash1 = await computeRecoveryVerifierHash(rk1);
      const hash2 = await computeRecoveryVerifierHash(rk2);
      expect(hash1).not.toBe(hash2);
    });

    it("matches verifier hash from wrap", async () => {
      const secretKey = crypto.getRandomValues(new Uint8Array(32));
      const recoveryKey = generateRecoveryKey();

      const wrapped = await wrapSecretKeyWithRecovery(secretKey, recoveryKey);
      const directHash = await computeRecoveryVerifierHash(recoveryKey);

      expect(wrapped.verifierHash).toBe(directHash);
    });
  });
});
