import { describe, it, expect } from "vitest";
import {
  encryptResetToken,
  decryptResetToken,
} from "@/lib/vault/admin-reset-token-crypto";

const aad = {
  tenantId: "tenant_abc",
  resetId: "reset_xyz",
  targetEmailAtInitiate: "alice@example.com",
};

describe("admin-reset-token-crypto", () => {
  it("round-trips a plaintext through encrypt → decrypt", () => {
    const plaintext = "rk_dual_approval_email_link_token_sample";
    const ciphertext = encryptResetToken(plaintext, aad);
    expect(ciphertext.startsWith("psoenc1:")).toBe(true);
    expect(ciphertext).not.toContain(plaintext);
    const recovered = decryptResetToken(ciphertext, aad);
    expect(recovered).toBe(plaintext);
  });

  it("produces a different ciphertext for the same plaintext on each call (random IV)", () => {
    const plaintext = "stable-plaintext";
    const a = encryptResetToken(plaintext, aad);
    const b = encryptResetToken(plaintext, aad);
    expect(a).not.toBe(b);
    expect(decryptResetToken(a, aad)).toBe(plaintext);
    expect(decryptResetToken(b, aad)).toBe(plaintext);
  });

  it("emits the psoenc1: sentinel prefix", () => {
    const ct = encryptResetToken("p", aad);
    expect(ct.startsWith("psoenc1:")).toBe(true);
  });

  it("returns null for null/undefined inputs (decrypt)", () => {
    expect(decryptResetToken(null, aad)).toBeNull();
    expect(decryptResetToken(undefined, aad)).toBeNull();
  });

  it("rejects ciphertext when the AAD context does not match", () => {
    const ct = encryptResetToken("secret", aad);
    expect(() =>
      decryptResetToken(ct, { ...aad, tenantId: "tenant_other" }),
    ).toThrow();
    expect(() =>
      decryptResetToken(ct, { ...aad, resetId: "reset_other" }),
    ).toThrow();
    expect(() =>
      decryptResetToken(ct, { ...aad, targetEmailAtInitiate: "bob@example.com" }),
    ).toThrow();
  });

  it("rejects malformed ciphertext", () => {
    // Missing sentinel.
    expect(() => decryptResetToken("plain-string", aad)).toThrow();
    // Bad version number.
    expect(() => decryptResetToken("psoenc1:notaversion:zzzz", aad)).toThrow();
    // Empty blob.
    expect(() => decryptResetToken("psoenc1:0:", aad)).toThrow();
    // Blob too short to be iv+tag.
    expect(() => decryptResetToken("psoenc1:0:dGVzdA", aad)).toThrow();
  });

  it("rejects ciphertext with a tampered tag", () => {
    const ct = encryptResetToken("secret", aad);
    const prefix = "psoenc1:";
    const colonIdx = ct.indexOf(":", prefix.length);
    const versionStr = ct.slice(prefix.length, colonIdx);
    const blobB64 = ct.slice(colonIdx + 1);
    const blob = Buffer.from(blobB64, "base64url");
    blob[12] ^= 0xff; // flip first byte of auth tag (after the 12-byte IV)
    const tampered = `${prefix}${versionStr}:${blob.toString("base64url")}`;
    expect(() => decryptResetToken(tampered, aad)).toThrow();
  });
});
