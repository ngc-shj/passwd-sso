import { describe, it, expect } from "vitest";
import {
  encryptAccountToken,
  decryptAccountToken,
  encryptAccountTokenTriple,
  decryptAccountTokenTriple,
  isEncryptedAccountToken,
} from "./account-token-crypto";

const aad = { provider: "google", providerAccountId: "alice@example.com" };

describe("account-token-crypto", () => {
  it("round-trips a plaintext through encrypt → decrypt", () => {
    const plaintext = "ya29.A0ARrdaM-..._sample_oauth_refresh_token";
    const ciphertext = encryptAccountToken(plaintext, aad);
    expect(ciphertext.startsWith("psoenc1:")).toBe(true);
    expect(ciphertext).not.toContain(plaintext);
    const recovered = decryptAccountToken(ciphertext, aad);
    expect(recovered).toBe(plaintext);
  });

  it("produces a different ciphertext for the same plaintext on each call (random IV)", () => {
    const plaintext = "stable-plaintext";
    const a = encryptAccountToken(plaintext, aad);
    const b = encryptAccountToken(plaintext, aad);
    expect(a).not.toBe(b);
    expect(decryptAccountToken(a, aad)).toBe(plaintext);
    expect(decryptAccountToken(b, aad)).toBe(plaintext);
  });

  it("isEncryptedAccountToken matches only the encrypted form", () => {
    expect(isEncryptedAccountToken(encryptAccountToken("p", aad))).toBe(true);
    expect(isEncryptedAccountToken("plain-string")).toBe(false);
    expect(isEncryptedAccountToken("")).toBe(false);
  });

  it("returns null for null/undefined inputs (decrypt)", () => {
    expect(decryptAccountToken(null, aad)).toBeNull();
    expect(decryptAccountToken(undefined, aad)).toBeNull();
  });

  it("treats legacy plaintext (no sentinel) as a passthrough", () => {
    // Backward-compat: rows that pre-date encryption are returned verbatim
    // until the data migration script rewrites them.
    expect(decryptAccountToken("legacy-plaintext-token", aad)).toBe(
      "legacy-plaintext-token",
    );
  });

  it("rejects ciphertext when the AAD context does not match", () => {
    const ct = encryptAccountToken("secret", aad);
    expect(() =>
      decryptAccountToken(ct, { provider: "google", providerAccountId: "different@example.com" }),
    ).toThrow();
    expect(() =>
      decryptAccountToken(ct, { provider: "github", providerAccountId: aad.providerAccountId }),
    ).toThrow();
  });

  it("rejects malformed ciphertext", () => {
    expect(() => decryptAccountToken("psoenc1:notaversion:zzzz", aad)).toThrow();
    expect(() => decryptAccountToken("psoenc1:0:", aad)).toThrow();
    expect(() => decryptAccountToken("psoenc1:0:dGVzdA", aad)).toThrow(); // too short to be iv+tag
  });

  it("rejects ciphertext with a tampered tag", () => {
    const ct = encryptAccountToken("secret", aad);
    // Decode, flip a bit in the auth tag region, re-encode, and try to decrypt.
    const [prefix, versionAndBlob] = ct.split(":", 2);
    const colonIdx = ct.indexOf(":", prefix.length + 1);
    const versionStr = ct.slice(prefix.length + 1, colonIdx);
    const blobB64 = ct.slice(colonIdx + 1);
    const blob = Buffer.from(blobB64, "base64url");
    blob[12] ^= 0xff; // flip first byte of auth tag
    const tampered = `${prefix}:${versionStr}:${blob.toString("base64url")}`;
    expect(() => decryptAccountToken(tampered, aad)).toThrow();
    // Use versionAndBlob so unused-var rule does not fire.
    expect(versionAndBlob).toBeDefined();
  });

  describe("triple helpers", () => {
    it("encrypts the present fields and leaves null/undefined fields null", () => {
      const out = encryptAccountTokenTriple(
        { refresh_token: "rt", access_token: null, id_token: undefined },
        aad,
      );
      expect(out.refresh_token).toMatch(/^psoenc1:/);
      expect(out.access_token).toBeNull();
      expect(out.id_token).toBeNull();
    });

    it("decrypts encrypted fields and passes legacy plaintext through", () => {
      const encrypted = encryptAccountToken("rt-plain", aad);
      const out = decryptAccountTokenTriple(
        { refresh_token: encrypted, access_token: "legacy-at", id_token: null },
        aad,
      );
      expect(out.refresh_token).toBe("rt-plain");
      expect(out.access_token).toBe("legacy-at");
      expect(out.id_token).toBeNull();
    });
  });
});
