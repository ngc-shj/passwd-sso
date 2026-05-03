/**
 * Tests for envelope.ts — AAD-agnostic AES-256-GCM envelope encryption.
 *
 * SECURITY OBLIGATIONS (per plan §Batch P5):
 * 1. AAD-substitution rejection: ciphertext encrypted with AAD A MUST FAIL
 *    to decrypt under AAD B / A||B / prefix-of-A / bit-flipped-A.
 * 2. No-secrets-in-error-messages: thrown Error.message MUST NOT contain IV /
 *    auth-tag / ciphertext / key bytes (sentinel-grep enforced).
 *
 * Real `node:crypto` is used. Per plan: `vi.mock("node:crypto", ...)` is
 * FORBIDDEN — only `vi.spyOn(cryptoModule, 'randomBytes')` for fixturing.
 */

import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import {
  encryptWithKey,
  decryptWithKey,
  parseEnvelope,
  isEncryptedEnvelope,
  ALGORITHM,
  IV_LENGTH,
  AUTH_TAG_LENGTH,
  SENTINEL,
  type ParsedEnvelope,
} from "./envelope";

// Sentinel byte sequences used as test inputs. If decryption-failure
// Error.message contains the hex of any of these, the impl is leaking
// secret bytes into errors (FAIL).
const SENTINEL_KEY = Buffer.from(
  "DEADBEEF".repeat(8), // 64 hex chars = 32 bytes — a marker, not a real key
  "hex",
);
const SENTINEL_AAD_A = Buffer.from([0xCA, 0xFE, 0xBA, 0xBE, 0x01, 0x02, 0x03, 0x04]);
const SENTINEL_AAD_B = Buffer.from([0xFE, 0xED, 0xFA, 0xCE, 0x05, 0x06, 0x07, 0x08]);

// Hex strings used for grep-checks against any thrown error.
const SENTINEL_KEY_HEX = SENTINEL_KEY.toString("hex");
const SENTINEL_AAD_A_HEX = SENTINEL_AAD_A.toString("hex");

function assertErrorContainsNoSecretBytes(err: unknown, ciphertext: Buffer, iv: Buffer, tag: Buffer) {
  expect(err).toBeInstanceOf(Error);
  const msg = (err as Error).message;
  // Hex form of every potentially-sensitive value
  expect(msg).not.toContain(SENTINEL_KEY_HEX);
  expect(msg).not.toContain(SENTINEL_AAD_A_HEX);
  expect(msg).not.toContain(ciphertext.toString("hex"));
  expect(msg).not.toContain(iv.toString("hex"));
  expect(msg).not.toContain(tag.toString("hex"));
  // Base64url forms — guard against alternate encodings
  expect(msg).not.toContain(SENTINEL_KEY.toString("base64url"));
  expect(msg).not.toContain(ciphertext.toString("base64url"));
}

describe("envelope", () => {
  describe("constants", () => {
    it("uses AES-256-GCM", () => {
      expect(ALGORITHM).toBe("aes-256-gcm");
    });

    it("uses 12-byte IV (GCM standard)", () => {
      expect(IV_LENGTH).toBe(12);
    });

    it("uses 16-byte auth tag (GCM full-length)", () => {
      expect(AUTH_TAG_LENGTH).toBe(16);
    });

    it("uses 'psoenc1:' sentinel", () => {
      expect(SENTINEL).toBe("psoenc1:");
    });
  });

  describe("isEncryptedEnvelope", () => {
    it("matches strings starting with the sentinel", () => {
      expect(isEncryptedEnvelope("psoenc1:1:abc")).toBe(true);
    });

    it("rejects plaintext", () => {
      expect(isEncryptedEnvelope("plaintext-value")).toBe(false);
    });

    it("rejects empty string", () => {
      expect(isEncryptedEnvelope("")).toBe(false);
    });

    it("is prefix-strict (rejects sentinel anywhere but the start)", () => {
      expect(isEncryptedEnvelope("xpsoenc1:1:abc")).toBe(false);
    });
  });

  describe("encryptWithKey + decryptWithKey round-trip", () => {
    it("round-trips a UTF-8 plaintext under matching AAD", () => {
      const ct = encryptWithKey("hello world", 1, SENTINEL_KEY, SENTINEL_AAD_A);
      const env = parseEnvelope(ct);
      expect(decryptWithKey(env, SENTINEL_KEY, SENTINEL_AAD_A)).toBe("hello world");
    });

    it("round-trips multi-byte UTF-8", () => {
      const plaintext = "ユーザー名@日本語";
      const ct = encryptWithKey(plaintext, 2, SENTINEL_KEY, SENTINEL_AAD_A);
      const env = parseEnvelope(ct);
      expect(decryptWithKey(env, SENTINEL_KEY, SENTINEL_AAD_A)).toBe(plaintext);
    });

    it("ciphertext starts with the sentinel and version", () => {
      const ct = encryptWithKey("p", 7, SENTINEL_KEY, SENTINEL_AAD_A);
      expect(ct.startsWith("psoenc1:7:")).toBe(true);
    });

    it("two encryptions of identical plaintext produce different ciphertexts (random IV)", () => {
      const a = encryptWithKey("same", 1, SENTINEL_KEY, SENTINEL_AAD_A);
      const b = encryptWithKey("same", 1, SENTINEL_KEY, SENTINEL_AAD_A);
      expect(a).not.toBe(b);
    });

    it("ciphertext does NOT contain the plaintext as a substring", () => {
      const plaintext = "this-is-a-very-distinctive-marker";
      const ct = encryptWithKey(plaintext, 1, SENTINEL_KEY, SENTINEL_AAD_A);
      expect(ct).not.toContain(plaintext);
    });
  });

  describe("parseEnvelope", () => {
    it("decodes a well-formed envelope", () => {
      const ct = encryptWithKey("plain", 3, SENTINEL_KEY, SENTINEL_AAD_A);
      const env = parseEnvelope(ct);
      expect(env.version).toBe(3);
      expect(env.iv.length).toBe(IV_LENGTH);
      expect(env.tag.length).toBe(AUTH_TAG_LENGTH);
      expect(env.ciphertext.length).toBeGreaterThan(0);
    });

    it("throws on missing version delimiter", () => {
      expect(() => parseEnvelope("psoenc1:abcdef")).toThrow(
        /missing version delimiter/,
      );
    });

    it("throws on negative version", () => {
      expect(() => parseEnvelope("psoenc1:-1:aaaa")).toThrow(/invalid version/);
    });

    it("throws on non-numeric version", () => {
      expect(() => parseEnvelope("psoenc1:abc:zzzz")).toThrow(/invalid version/);
    });

    it("throws on blob shorter than IV+TAG+1", () => {
      // Empty base64url payload
      expect(() => parseEnvelope("psoenc1:1:")).toThrow(/blob too short/);
    });

    it("accepts version 0", () => {
      const ct = encryptWithKey("p", 0, SENTINEL_KEY, SENTINEL_AAD_A);
      expect(parseEnvelope(ct).version).toBe(0);
    });
  });

  // ─── AAD-substitution rejection (security obligation 2) ────────

  describe("AAD-substitution rejection", () => {
    it("rejects decryption under a different AAD (B)", () => {
      const ct = encryptWithKey("secret-plaintext", 1, SENTINEL_KEY, SENTINEL_AAD_A);
      const env = parseEnvelope(ct);
      let thrown: unknown;
      try {
        decryptWithKey(env, SENTINEL_KEY, SENTINEL_AAD_B);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(Error);
      assertErrorContainsNoSecretBytes(thrown, env.ciphertext, env.iv, env.tag);
    });

    it("rejects decryption under concatenated AAD (A || B)", () => {
      const ct = encryptWithKey("secret-plaintext", 1, SENTINEL_KEY, SENTINEL_AAD_A);
      const env = parseEnvelope(ct);
      const concat = Buffer.concat([SENTINEL_AAD_A, SENTINEL_AAD_B]);
      let thrown: unknown;
      try {
        decryptWithKey(env, SENTINEL_KEY, concat);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(Error);
      assertErrorContainsNoSecretBytes(thrown, env.ciphertext, env.iv, env.tag);
    });

    it("rejects decryption under truncated AAD (prefix of A)", () => {
      const ct = encryptWithKey("secret-plaintext", 1, SENTINEL_KEY, SENTINEL_AAD_A);
      const env = parseEnvelope(ct);
      const truncated = SENTINEL_AAD_A.subarray(0, SENTINEL_AAD_A.length - 1);
      let thrown: unknown;
      try {
        decryptWithKey(env, SENTINEL_KEY, truncated);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(Error);
      assertErrorContainsNoSecretBytes(thrown, env.ciphertext, env.iv, env.tag);
    });

    it("rejects decryption under bit-flipped AAD", () => {
      const ct = encryptWithKey("secret-plaintext", 1, SENTINEL_KEY, SENTINEL_AAD_A);
      const env = parseEnvelope(ct);
      const flipped = Buffer.from(SENTINEL_AAD_A);
      flipped[0] ^= 0x01;
      let thrown: unknown;
      try {
        decryptWithKey(env, SENTINEL_KEY, flipped);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(Error);
      assertErrorContainsNoSecretBytes(thrown, env.ciphertext, env.iv, env.tag);
    });

    it("rejects decryption under empty AAD when encrypted with non-empty AAD", () => {
      const ct = encryptWithKey("secret-plaintext", 1, SENTINEL_KEY, SENTINEL_AAD_A);
      const env = parseEnvelope(ct);
      let thrown: unknown;
      try {
        decryptWithKey(env, SENTINEL_KEY, Buffer.alloc(0));
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(Error);
      assertErrorContainsNoSecretBytes(thrown, env.ciphertext, env.iv, env.tag);
    });
  });

  // ─── No-secrets-in-error-messages (security obligation 2 / S13) ─

  describe("no-secrets-in-error-messages", () => {
    it("error message does not contain the sentinel key bytes", () => {
      const ct = encryptWithKey("p", 1, SENTINEL_KEY, SENTINEL_AAD_A);
      const env = parseEnvelope(ct);
      let thrown: unknown;
      try {
        decryptWithKey(env, SENTINEL_KEY, SENTINEL_AAD_B);
      } catch (e) {
        thrown = e;
      }
      expect((thrown as Error).message).not.toContain(SENTINEL_KEY_HEX);
    });

    it("error message does not contain the AAD bytes", () => {
      const ct = encryptWithKey("p", 1, SENTINEL_KEY, SENTINEL_AAD_A);
      const env = parseEnvelope(ct);
      let thrown: unknown;
      try {
        decryptWithKey(env, SENTINEL_KEY, SENTINEL_AAD_B);
      } catch (e) {
        thrown = e;
      }
      expect((thrown as Error).message).not.toContain(SENTINEL_AAD_A_HEX);
    });

    it("error message does not contain ciphertext bytes when key is wrong", () => {
      const ct = encryptWithKey("p", 1, SENTINEL_KEY, SENTINEL_AAD_A);
      const env = parseEnvelope(ct);
      const wrongKey = Buffer.alloc(32, 0x42);
      let thrown: unknown;
      try {
        decryptWithKey(env, wrongKey, SENTINEL_AAD_A);
      } catch (e) {
        thrown = e;
      }
      assertErrorContainsNoSecretBytes(thrown, env.ciphertext, env.iv, env.tag);
    });

    it("error message does not contain auth-tag when ciphertext is tampered", () => {
      const ct = encryptWithKey("p", 1, SENTINEL_KEY, SENTINEL_AAD_A);
      const env = parseEnvelope(ct);
      // Flip one bit of ciphertext to force GCM auth failure
      const tampered: ParsedEnvelope = {
        ...env,
        ciphertext: Buffer.from(env.ciphertext),
      };
      tampered.ciphertext[0] ^= 0x01;
      let thrown: unknown;
      try {
        decryptWithKey(tampered, SENTINEL_KEY, SENTINEL_AAD_A);
      } catch (e) {
        thrown = e;
      }
      assertErrorContainsNoSecretBytes(thrown, tampered.ciphertext, tampered.iv, tampered.tag);
    });
  });

  // ─── Wrong-version protection ────────────────────────────────

  describe("version handling", () => {
    it("decrypt does NOT validate version (caller is responsible for picking the key)", () => {
      // The envelope module is key-agnostic at decrypt time — it just uses
      // the key the caller passes. This documents that contract: passing the
      // SAME key under a DIFFERENT version still works (because the version
      // string is metadata, not part of AAD). Callers that want
      // version-binding must put the version in their AAD (account-token-crypto
      // and admin-reset-token-crypto do this).
      const ct = encryptWithKey("p", 1, SENTINEL_KEY, SENTINEL_AAD_A);
      const env = parseEnvelope(ct);
      // Forge a different-version envelope but same iv/tag/ciphertext + same key
      const forged: ParsedEnvelope = { ...env, version: 99 };
      // Same key + same AAD still decrypts (key version is NOT in GCM AAD here)
      expect(decryptWithKey(forged, SENTINEL_KEY, SENTINEL_AAD_A)).toBe("p");
    });
  });

  // ─── Random keys + plaintext shapes ──────────────────────────

  describe("random fixtures", () => {
    it("round-trips a random 32-byte key and 1 KiB plaintext", () => {
      const key = randomBytes(32);
      const aad = randomBytes(16);
      const plaintext = randomBytes(1024).toString("base64");
      const ct = encryptWithKey(plaintext, 1, key, aad);
      const env = parseEnvelope(ct);
      expect(decryptWithKey(env, key, aad)).toBe(plaintext);
    });

    it("round-trips a 1-byte plaintext (smallest accepted by parseEnvelope)", () => {
      // parseEnvelope rejects blobs shorter than IV+TAG+1, so the smallest
      // round-trippable plaintext is 1 byte.
      const key = randomBytes(32);
      const aad = randomBytes(8);
      const ct = encryptWithKey("x", 1, key, aad);
      const env = parseEnvelope(ct);
      expect(decryptWithKey(env, key, aad)).toBe("x");
    });
  });
});
