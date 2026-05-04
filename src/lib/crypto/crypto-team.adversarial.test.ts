// Adversarial: ciphertext-swap across team encryption keys (issue #435).
//
// Team vault uses HKDF-derived AES-256-GCM keys via deriveTeamEncryptionKey().
// Ciphertext encrypted under team A's key must not be decryptable under team
// B's key, even with matching AAD shape.

import { describe, it, expect } from "vitest";
import {
  encryptTeamEntry,
  decryptTeamEntry,
  deriveTeamEncryptionKey,
  generateTeamSymmetricKey,
} from "./crypto-team";

describe("crypto-team adversarial: ciphertext-swap across team keys", () => {
  it("decryption fails when team-vault ciphertext encrypted under K1 is presented to K2", async () => {
    const k1Bytes = generateTeamSymmetricKey();
    const k2Bytes = generateTeamSymmetricKey();
    expect(Buffer.from(k1Bytes).equals(Buffer.from(k2Bytes))).toBe(false);

    const k1 = await deriveTeamEncryptionKey(k1Bytes);
    const k2 = await deriveTeamEncryptionKey(k2Bytes);

    const plaintext = "team-entry-secret";
    const ciphertext = await encryptTeamEntry(plaintext, k1);

    // Positive control: decryption succeeds under K1.
    const recovered = await decryptTeamEntry(ciphertext, k1);
    expect(recovered).toBe(plaintext);

    // Negative: K2 rejects.
    let thrownError: unknown = null;
    try {
      await decryptTeamEntry(ciphertext, k2);
    } catch (err) {
      thrownError = err;
    }
    expect(thrownError).not.toBeNull();

    // Sentinel-grep: error must not leak plaintext.
    const errString = thrownError instanceof Error ? `${thrownError.name}:${thrownError.message}` : String(thrownError);
    expect(errString).not.toContain(plaintext);
  });

  it("AAD swap (matched team key) also fails — orthogonal rejection vector", async () => {
    const k = await deriveTeamEncryptionKey(generateTeamSymmetricKey());
    const aadA = new TextEncoder().encode("team-1|entry-A|kv-1|wv-1");
    const aadB = new TextEncoder().encode("team-1|entry-B|kv-1|wv-1");

    const ciphertext = await encryptTeamEntry("team-plaintext", k, aadA);

    const recovered = await decryptTeamEntry(ciphertext, k, aadA);
    expect(recovered).toBe("team-plaintext");

    let thrownError: unknown = null;
    try {
      await decryptTeamEntry(ciphertext, k, aadB);
    } catch (err) {
      thrownError = err;
    }
    expect(thrownError).not.toBeNull();
  });

  it("HKDF derivation chain is exercised — different secret bytes produce keys that reject each other's ciphertext", async () => {
    // Defense-in-depth: even if HKDF is weak (output collision for distinct inputs),
    // the test would catch it because two distinct 32-byte secrets must produce
    // distinct derived keys → cross-key ciphertext rejection.
    const k1Bytes = generateTeamSymmetricKey();
    const k2Bytes = generateTeamSymmetricKey();

    const k1A = await deriveTeamEncryptionKey(k1Bytes);
    const k1B = await deriveTeamEncryptionKey(k1Bytes); // SAME bytes — should produce SAME logical key
    const k2 = await deriveTeamEncryptionKey(k2Bytes);

    const ct = await encryptTeamEntry("hkdf-determinism", k1A);
    // Same bytes → derives to logically equivalent key; decryption succeeds.
    expect(await decryptTeamEntry(ct, k1B)).toBe("hkdf-determinism");

    // Different bytes → different derived key; decryption rejects.
    let rejected = false;
    try {
      await decryptTeamEntry(ct, k2);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });
});
