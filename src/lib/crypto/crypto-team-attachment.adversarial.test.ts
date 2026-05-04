// Adversarial: ciphertext-swap across team attachment encryption keys (issue #435).
//
// Team attachments use the same HKDF-derived AES-256-GCM key as team entries
// (delegates to crypto-client encryptBinary/decryptBinary). Cross-key ciphertext
// must reject; AAD-swap must reject.

import { describe, it, expect } from "vitest";
import {
  encryptTeamAttachment,
  decryptTeamAttachment,
  deriveTeamEncryptionKey,
  generateTeamSymmetricKey,
} from "./crypto-team";

describe("crypto-team attachment adversarial: ciphertext-swap across team keys", () => {
  it("attachment ciphertext encrypted under K1 cannot be decrypted with K2", async () => {
    const k1 = await deriveTeamEncryptionKey(generateTeamSymmetricKey());
    const k2 = await deriveTeamEncryptionKey(generateTeamSymmetricKey());

    const fileBytes = new Uint8Array(2048);
    crypto.getRandomValues(fileBytes);
    const sentinelHex = Buffer.from(fileBytes.slice(0, 16)).toString("hex");

    const encrypted = await encryptTeamAttachment(
      fileBytes.buffer.slice(fileBytes.byteOffset, fileBytes.byteOffset + fileBytes.byteLength),
      k1,
    );

    // Positive control: K1 succeeds.
    const recovered = await decryptTeamAttachment(encrypted, k1);
    expect(new Uint8Array(recovered)).toEqual(fileBytes);

    // Negative: K2 rejects.
    let thrownError: unknown = null;
    try {
      await decryptTeamAttachment(encrypted, k2);
    } catch (err) {
      thrownError = err;
    }
    expect(thrownError).not.toBeNull();

    // Sentinel-grep: error must not contain attachment bytes.
    const errString = thrownError instanceof Error ? `${thrownError.name}:${thrownError.message}` : String(thrownError);
    expect(errString).not.toContain(sentinelHex);
  });

  it("AAD swap with same key rejects — attachment binding holds", async () => {
    const k = await deriveTeamEncryptionKey(generateTeamSymmetricKey());
    const aadAttach1 = new TextEncoder().encode("team-1|attach-A|file-md5-AA");
    const aadAttach2 = new TextEncoder().encode("team-1|attach-B|file-md5-BB");

    const data = new TextEncoder().encode("attachment-content").buffer.slice(
      0,
    ) as ArrayBuffer;
    const encrypted = await encryptTeamAttachment(data, k, aadAttach1);

    const recovered = await decryptTeamAttachment(encrypted, k, aadAttach1);
    expect(new TextDecoder().decode(recovered)).toBe("attachment-content");

    let thrownError: unknown = null;
    try {
      await decryptTeamAttachment(encrypted, k, aadAttach2);
    } catch (err) {
      thrownError = err;
    }
    expect(thrownError).not.toBeNull();
  });

  it("encryptTeamAttachment produces unique IVs across 16 calls under the same key", async () => {
    // Nonce-reuse across re-uploaded / re-encrypted attachments must not happen.
    const k = await deriveTeamEncryptionKey(generateTeamSymmetricKey());
    const data = new Uint8Array(512);
    crypto.getRandomValues(data);
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    const ivs = new Set<string>();
    for (let i = 0; i < 16; i++) {
      const c = await encryptTeamAttachment(buf, k);
      ivs.add(c.iv);
    }
    expect(ivs.size).toBe(16);
  });

  it("flipping one byte of attachment ciphertext rejects decryption", async () => {
    const k = await deriveTeamEncryptionKey(generateTeamSymmetricKey());
    const data = new Uint8Array(256);
    crypto.getRandomValues(data);
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    const original = await encryptTeamAttachment(buf, k);
    const tamperedBytes = new Uint8Array(original.ciphertext);
    tamperedBytes[0] ^= 0xff;
    const tampered = { ...original, ciphertext: tamperedBytes };
    let rejected = false;
    try {
      await decryptTeamAttachment(tampered, k);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });
});
