// Adversarial: ciphertext-swap across master key versions for account tokens
// (issue #435).
//
// account-token-crypto delegates to envelope.ts with a versioned master key
// looked up via getMasterKeyByVersion. The K1→K2 swap is implemented by
// stubbing getMasterKeyByVersion to return a different 32-byte key on the
// decrypt path, mirroring the spy pattern at account-token-crypto.test.ts:218-243.

import { describe, it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";
import * as cryptoServer from "@/lib/crypto/crypto-server";
import { parseEnvelope, SENTINEL } from "./envelope";
import {
  encryptAccountToken,
  decryptAccountToken,
} from "./account-token-crypto";

describe("account-token-crypto adversarial: ciphertext-swap across master keys", () => {
  it("decryption fails when ciphertext encrypted under K1 is presented to K2", () => {
    const k1 = randomBytes(32);
    const k2 = randomBytes(32);
    expect(k1.equals(k2)).toBe(false);

    const aad = {
      userId: "00000000-0000-0000-0000-000000000001",
      provider: "google",
      providerAccountId: "google-account-1",
    };
    const plaintext = "ya29.refresh-token-secret";

    // Phase 1: encrypt with K1 (stub returns K1 for current version)
    const encryptVersion = cryptoServer.getCurrentMasterKeyVersion();
    const encryptSpy = vi
      .spyOn(cryptoServer, "getMasterKeyByVersion")
      .mockImplementation((v: number) => {
        if (v !== encryptVersion) throw new Error(`unexpected version ${v}`);
        return k1;
      });

    let ciphertext: string;
    try {
      ciphertext = encryptAccountToken(plaintext, aad);
    } finally {
      encryptSpy.mockRestore();
    }

    // Positive control: decrypt under K1 succeeds (proves setup is correct).
    const recoverSpy = vi
      .spyOn(cryptoServer, "getMasterKeyByVersion")
      .mockImplementation(() => k1);
    try {
      expect(decryptAccountToken(ciphertext, aad)).toBe(plaintext);
    } finally {
      recoverSpy.mockRestore();
    }

    // Negative: stub returns K2 — decryption MUST reject.
    const swapSpy = vi
      .spyOn(cryptoServer, "getMasterKeyByVersion")
      .mockImplementation(() => k2);
    let thrownError: unknown = null;
    try {
      decryptAccountToken(ciphertext, aad);
    } catch (err) {
      thrownError = err;
    } finally {
      swapSpy.mockRestore();
    }
    expect(thrownError).not.toBeNull();

    // Sentinel-grep: error must not leak plaintext.
    const errString = thrownError instanceof Error ? `${thrownError.name}:${thrownError.message}` : String(thrownError);
    expect(errString).not.toContain(plaintext);
    expect(errString).not.toContain("refresh-token-secret");
  });

  it("AAD-swap with same key also rejects — independent rejection vector", () => {
    const k = randomBytes(32);
    const aadA = {
      userId: "00000000-0000-0000-0000-0000000000aa",
      provider: "google",
      providerAccountId: "google-A",
    };
    const aadB = { ...aadA, providerAccountId: "google-B" };

    const spy = vi
      .spyOn(cryptoServer, "getMasterKeyByVersion")
      .mockImplementation(() => k);
    try {
      const ct = encryptAccountToken("plaintext-aad-swap", aadA);
      expect(decryptAccountToken(ct, aadA)).toBe("plaintext-aad-swap");
      expect(() => decryptAccountToken(ct, aadB)).toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  it("encryptAccountToken produces unique IVs across 16 calls under the same master key", () => {
    // Token re-encryption (e.g., after master-key rotation) must not collapse
    // to a single IV under AES-GCM.
    const k = randomBytes(32);
    const aad = {
      userId: "00000000-0000-0000-0000-0000000000aa",
      provider: "google",
      providerAccountId: "google-A",
    };
    const spy = vi
      .spyOn(cryptoServer, "getMasterKeyByVersion")
      .mockImplementation(() => k);
    try {
      const ivs = new Set<string>();
      for (let i = 0; i < 16; i++) {
        const ct = encryptAccountToken("same-token-plaintext", aad);
        const env = parseEnvelope(ct);
        ivs.add(env.iv.toString("hex"));
      }
      expect(ivs.size).toBe(16);
    } finally {
      spy.mockRestore();
    }
  });

  it("flipping one byte of envelope ciphertext rejects decryption (authenticity)", () => {
    // Envelope shape: SENTINEL + <version> + ":" + base64url(iv || tag || ct).
    // Tamper by parsing, mutating the first ciphertext byte, and re-packing.
    const k = randomBytes(32);
    const aad = {
      userId: "00000000-0000-0000-0000-0000000000aa",
      provider: "google",
      providerAccountId: "google-A",
    };
    const spy = vi
      .spyOn(cryptoServer, "getMasterKeyByVersion")
      .mockImplementation(() => k);
    try {
      const ct = encryptAccountToken("authentic-token", aad);
      const env = parseEnvelope(ct);
      const tamperedCipher = Buffer.from(env.ciphertext);
      tamperedCipher[0] ^= 0xff;
      const blob = Buffer.concat([env.iv, env.tag, tamperedCipher]).toString("base64url");
      const tampered = `${SENTINEL}${env.version}:${blob}`;
      expect(() => decryptAccountToken(tampered, aad)).toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});
