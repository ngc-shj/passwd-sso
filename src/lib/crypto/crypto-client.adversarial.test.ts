// Adversarial: ciphertext-swap across keys (issue #435, plan Contract 8).
//
// Personal vault is fully E2E — server stores ciphertext + IV + authTag and
// never decrypts. The cryptographic boundary that must hold the K1→K2 swap
// invariant is the client-side path here: encryptData/decryptData with a key
// produced by deriveEncryptionKey (HKDF-SHA256 over a 32-byte secret).

import { describe, it, expect } from "vitest";
import {
  encryptData,
  decryptData,
  encryptBinary,
  decryptBinary,
  deriveEncryptionKey,
  generateSecretKey,
} from "./crypto-client";

describe("crypto-client adversarial: ciphertext-swap across personal-vault keys", () => {
  it("decryption fails when ciphertext encrypted under K1 is presented to K2", async () => {
    const k1Bytes = generateSecretKey();
    const k2Bytes = generateSecretKey();
    expect(Buffer.from(k1Bytes).equals(Buffer.from(k2Bytes))).toBe(false);

    const k1 = await deriveEncryptionKey(k1Bytes);
    const k2 = await deriveEncryptionKey(k2Bytes);

    const plaintext = "vault-entry-secret";
    const ciphertext = await encryptData(plaintext, k1);

    // Positive control: the ciphertext IS decryptable under K1 — proves the
    // negative case below fails because of the key swap, not setup error.
    const recovered = await decryptData(ciphertext, k1);
    expect(recovered).toBe(plaintext);

    // Negative: same ciphertext under K2 must reject (GCM auth-tag mismatch).
    let thrownError: unknown = null;
    try {
      await decryptData(ciphertext, k2);
    } catch (err) {
      thrownError = err;
    }
    expect(thrownError).not.toBeNull();

    // Sentinel-grep: the rejection error must NOT leak plaintext bytes.
    const errString = thrownError instanceof Error ? `${thrownError.name}:${thrownError.message}` : String(thrownError);
    expect(errString).not.toContain(plaintext);
  });

  it("binary attachment ciphertext encrypted under K1 cannot be decrypted with K2", async () => {
    const k1 = await deriveEncryptionKey(generateSecretKey());
    const k2 = await deriveEncryptionKey(generateSecretKey());

    const data = new Uint8Array(1024);
    crypto.getRandomValues(data);
    const sentinelBytes = data.slice(0, 16);

    const encrypted = await encryptBinary(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), k1);

    // Positive control
    const recovered = await decryptBinary(encrypted, k1);
    expect(new Uint8Array(recovered)).toEqual(data);

    // Negative: K2 decryption rejects
    let thrownError: unknown = null;
    try {
      await decryptBinary(encrypted, k2);
    } catch (err) {
      thrownError = err;
    }
    expect(thrownError).not.toBeNull();

    // Sentinel-grep: error must not contain any plaintext byte sequence.
    const errString = thrownError instanceof Error ? `${thrownError.name}:${thrownError.message}` : String(thrownError);
    const sentinelHex = Buffer.from(sentinelBytes).toString("hex");
    expect(errString).not.toContain(sentinelHex);
  });

  it("AAD swap (matched key) also fails — orthogonal rejection vector", async () => {
    const k = await deriveEncryptionKey(generateSecretKey());
    const aad1 = new TextEncoder().encode("entry-A");
    const aad2 = new TextEncoder().encode("entry-B");

    const ciphertext = await encryptData("plaintext-x", k, aad1);

    const recovered = await decryptData(ciphertext, k, aad1);
    expect(recovered).toBe("plaintext-x");

    let thrownError: unknown = null;
    try {
      await decryptData(ciphertext, k, aad2);
    } catch (err) {
      thrownError = err;
    }
    expect(thrownError).not.toBeNull();
  });
});
