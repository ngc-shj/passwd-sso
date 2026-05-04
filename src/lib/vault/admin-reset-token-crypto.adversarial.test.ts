// Adversarial: ciphertext-swap across master keys for admin-vault-reset
// email-link tokens (issue #435).
//
// admin-reset-token-crypto delegates to envelope.ts via getMasterKeyByVersion.
// Pattern mirrors account-token-crypto.adversarial.test.ts.

import { describe, it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";
import * as cryptoServer from "@/lib/crypto/crypto-server";
import { parseEnvelope, SENTINEL } from "@/lib/crypto/envelope";
import {
  encryptResetToken,
  decryptResetToken,
} from "./admin-reset-token-crypto";

describe("admin-reset-token-crypto adversarial: ciphertext-swap across master keys", () => {
  it("decryption fails when ciphertext encrypted under K1 is presented to K2", () => {
    const k1 = randomBytes(32);
    const k2 = randomBytes(32);
    expect(k1.equals(k2)).toBe(false);

    const aad = {
      tenantId: "00000000-0000-0000-0000-000000000010",
      resetId: "00000000-0000-0000-0000-000000000020",
      targetEmailAtInitiate: "<test-target>@example.com",
    };
    const plaintext = "reset-token-link-secret-A1B2C3";

    const encryptVersion = cryptoServer.getCurrentMasterKeyVersion();
    const encryptSpy = vi
      .spyOn(cryptoServer, "getMasterKeyByVersion")
      .mockImplementation((v: number) => {
        if (v !== encryptVersion) throw new Error(`unexpected version ${v}`);
        return k1;
      });

    let ciphertext: string;
    try {
      ciphertext = encryptResetToken(plaintext, aad);
    } finally {
      encryptSpy.mockRestore();
    }

    // Positive control: K1 decrypts successfully.
    const recoverSpy = vi
      .spyOn(cryptoServer, "getMasterKeyByVersion")
      .mockImplementation(() => k1);
    try {
      expect(decryptResetToken(ciphertext, aad)).toBe(plaintext);
    } finally {
      recoverSpy.mockRestore();
    }

    // Negative: K2 rejects.
    const swapSpy = vi
      .spyOn(cryptoServer, "getMasterKeyByVersion")
      .mockImplementation(() => k2);
    let thrownError: unknown = null;
    try {
      decryptResetToken(ciphertext, aad);
    } catch (err) {
      thrownError = err;
    } finally {
      swapSpy.mockRestore();
    }
    expect(thrownError).not.toBeNull();

    const errString = thrownError instanceof Error ? `${thrownError.name}:${thrownError.message}` : String(thrownError);
    expect(errString).not.toContain(plaintext);
    expect(errString).not.toContain("link-secret");
  });

  it("AAD email-change vector — ciphertext bound to initiate-time email rejects under changed email", () => {
    const k = randomBytes(32);
    const aadInitial = {
      tenantId: "00000000-0000-0000-0000-000000000030",
      resetId: "00000000-0000-0000-0000-000000000040",
      targetEmailAtInitiate: "<original>@example.com",
    };
    const aadChanged = { ...aadInitial, targetEmailAtInitiate: "<changed>@example.com" };

    const spy = vi
      .spyOn(cryptoServer, "getMasterKeyByVersion")
      .mockImplementation(() => k);
    try {
      const ct = encryptResetToken("reset-token-X", aadInitial);
      expect(decryptResetToken(ct, aadInitial)).toBe("reset-token-X");
      // FR12: target user changed email between initiate and approve → reject.
      expect(() => decryptResetToken(ct, aadChanged)).toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  it("encryptResetToken produces unique IVs across 16 calls under the same master key", () => {
    const k = randomBytes(32);
    const aad = {
      tenantId: "00000000-0000-0000-0000-000000000050",
      resetId: "00000000-0000-0000-0000-000000000060",
      targetEmailAtInitiate: "<iv-uniqueness-target>@example.com",
    };
    const spy = vi
      .spyOn(cryptoServer, "getMasterKeyByVersion")
      .mockImplementation(() => k);
    try {
      const ivs = new Set<string>();
      for (let i = 0; i < 16; i++) {
        const ct = encryptResetToken("same-reset-token", aad);
        const env = parseEnvelope(ct);
        ivs.add(env.iv.toString("hex"));
      }
      expect(ivs.size).toBe(16);
    } finally {
      spy.mockRestore();
    }
  });

  it("flipping one byte of envelope ciphertext rejects decryption (authenticity)", () => {
    const k = randomBytes(32);
    const aad = {
      tenantId: "00000000-0000-0000-0000-000000000070",
      resetId: "00000000-0000-0000-0000-000000000080",
      targetEmailAtInitiate: "<authenticity-target>@example.com",
    };
    const spy = vi
      .spyOn(cryptoServer, "getMasterKeyByVersion")
      .mockImplementation(() => k);
    try {
      const ct = encryptResetToken("authentic-reset-token", aad);
      const env = parseEnvelope(ct);
      const tamperedCipher = Buffer.from(env.ciphertext);
      tamperedCipher[0] ^= 0xff;
      const blob = Buffer.concat([env.iv, env.tag, tamperedCipher]).toString("base64url");
      const tampered = `${SENTINEL}${env.version}:${blob}`;
      expect(() => decryptResetToken(tampered, aad)).toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});
