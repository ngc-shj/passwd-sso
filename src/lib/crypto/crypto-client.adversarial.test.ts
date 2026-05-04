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

describe("crypto-client adversarial: nonce uniqueness across repeated encryptions", () => {
  // AES-GCM nonce reuse under the same key is catastrophic (loss of confidentiality
  // AND authenticity). Vault rotation, delegation, and any flow that re-encrypts
  // under a stable key is a candidate failure site. The contract we assert is
  // simply: every encryption under the same key produces a distinct IV. The IV
  // generator is `crypto.getRandomValues` (96 bits of entropy) — a collision
  // across N=64 calls has probability ≈ N²/2^97, statistically zero.
  it("encryptData produces unique IVs across 64 calls under the same key", async () => {
    const k = await deriveEncryptionKey(generateSecretKey());
    const ivs = new Set<string>();
    for (let i = 0; i < 64; i++) {
      const c = await encryptData("same-plaintext", k);
      ivs.add(c.iv);
    }
    expect(ivs.size).toBe(64);
  });

  it("encryptBinary produces unique IVs across 64 calls under the same key", async () => {
    const k = await deriveEncryptionKey(generateSecretKey());
    const data = new Uint8Array(256);
    crypto.getRandomValues(data);
    const ivs = new Set<string>();
    for (let i = 0; i < 64; i++) {
      const c = await encryptBinary(
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        k,
      );
      ivs.add(c.iv);
    }
    expect(ivs.size).toBe(64);
  });
});

describe("crypto-client adversarial: AES-GCM authenticity (ciphertext / tag mutation)", () => {
  // AES-GCM provides authenticated encryption — flipping a single bit of either
  // the ciphertext OR the authTag must reject decryption. Without this property,
  // an attacker who controls server-stored blobs can mutate decrypted plaintext.
  it("flipping one byte of ciphertext rejects decryption", async () => {
    const k = await deriveEncryptionKey(generateSecretKey());
    const original = await encryptData("authentic-plaintext", k);
    // Flip the first byte of ciphertext (hex string — flip the first hex digit).
    const tampered = {
      ...original,
      ciphertext:
        ((parseInt(original.ciphertext[0], 16) ^ 0xf).toString(16)) +
        original.ciphertext.slice(1),
    };
    let thrownError: unknown = null;
    try {
      await decryptData(tampered, k);
    } catch (err) {
      thrownError = err;
    }
    expect(thrownError).not.toBeNull();
  });

  it("flipping one byte of authTag rejects decryption", async () => {
    const k = await deriveEncryptionKey(generateSecretKey());
    const original = await encryptData("authentic-plaintext", k);
    const tampered = {
      ...original,
      authTag:
        ((parseInt(original.authTag[0], 16) ^ 0xf).toString(16)) +
        original.authTag.slice(1),
    };
    let thrownError: unknown = null;
    try {
      await decryptData(tampered, k);
    } catch (err) {
      thrownError = err;
    }
    expect(thrownError).not.toBeNull();
  });

  it("truncating the authTag rejects decryption", async () => {
    const k = await deriveEncryptionKey(generateSecretKey());
    const original = await encryptData("authentic-plaintext", k);
    // Drop the last 2 hex digits (1 byte) from the tag — should be rejected
    // as the GCM 128-bit tag length is enforced.
    const truncated = { ...original, authTag: original.authTag.slice(0, -2) };
    let thrownError: unknown = null;
    try {
      await decryptData(truncated, k);
    } catch (err) {
      thrownError = err;
    }
    expect(thrownError).not.toBeNull();
  });
});

describe("crypto-client adversarial: vault key rotation rollback", () => {
  // Threat: an attacker who retains the OLD vault key (e.g., by capturing a
  // memory snapshot before rotation) must NOT be able to decrypt content that
  // was re-encrypted under the NEW key after rotation. This is the symmetric
  // dual of the existing K1→K2 swap test. The property follows from AES-GCM
  // tag authenticity but warrants an explicit regression test because rotation
  // is the place a future implementation might inadvertently re-use IVs across
  // keys, weaken the key derivation, or skip the re-encrypt step entirely.
  it("ciphertext encrypted under K_new cannot be decrypted by leaked K_old", async () => {
    const kOld = await deriveEncryptionKey(generateSecretKey());
    const kNew = await deriveEncryptionKey(generateSecretKey());

    // Pre-rotation: content was encrypted under kOld
    const preRotation = await encryptData("vault-secret-pre", kOld);
    // Sanity: kOld decrypts its own ciphertext
    expect(await decryptData(preRotation, kOld)).toBe("vault-secret-pre");

    // Rotation: content is re-encrypted under kNew
    const postRotation = await encryptData("vault-secret-post", kNew);

    // Adversary still holds kOld but the new ciphertext was sealed under kNew.
    let thrownError: unknown = null;
    try {
      await decryptData(postRotation, kOld);
    } catch (err) {
      thrownError = err;
    }
    expect(thrownError).not.toBeNull();
  });
});
