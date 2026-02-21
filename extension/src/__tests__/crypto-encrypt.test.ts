import { describe, it, expect } from "vitest";
import {
  encryptData,
  decryptData,
  buildPersonalEntryAAD,
} from "../lib/crypto";

// Web Crypto API is available in Node 20+ (vitest uses Node)

async function makeTestKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
}

describe("encryptData / decryptData round-trip", () => {
  it("encrypts and decrypts plain text", async () => {
    const key = await makeTestKey();
    const plaintext = "hello world";

    const encrypted = await encryptData(plaintext, key);
    expect(encrypted.ciphertext).toBeTruthy();
    expect(encrypted.iv).toBeTruthy();
    expect(encrypted.authTag).toBeTruthy();
    // Ciphertext should differ from plaintext hex
    expect(encrypted.ciphertext).not.toBe(
      Array.from(new TextEncoder().encode(plaintext))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
    );

    const decrypted = await decryptData(encrypted, key);
    expect(decrypted).toBe(plaintext);
  });

  it("encrypts and decrypts with AAD", async () => {
    const key = await makeTestKey();
    const plaintext = JSON.stringify({ password: "s3cret", username: "alice" });
    const aad = buildPersonalEntryAAD("user-123", "entry-456");

    const encrypted = await encryptData(plaintext, key, aad);
    const decrypted = await decryptData(encrypted, key, aad);
    expect(decrypted).toBe(plaintext);
  });

  it("fails to decrypt with wrong AAD", async () => {
    const key = await makeTestKey();
    const plaintext = "sensitive data";
    const aad1 = buildPersonalEntryAAD("user-1", "entry-1");
    const aad2 = buildPersonalEntryAAD("user-2", "entry-2");

    const encrypted = await encryptData(plaintext, key, aad1);

    await expect(decryptData(encrypted, key, aad2)).rejects.toThrow();
  });

  it("fails to decrypt with no AAD when encrypted with AAD", async () => {
    const key = await makeTestKey();
    const plaintext = "authenticated data";
    const aad = buildPersonalEntryAAD("user-1", "entry-1");

    const encrypted = await encryptData(plaintext, key, aad);

    await expect(decryptData(encrypted, key)).rejects.toThrow();
  });

  it("fails to decrypt with wrong key", async () => {
    const key1 = await makeTestKey();
    const key2 = await makeTestKey();
    const plaintext = "key-specific data";

    const encrypted = await encryptData(plaintext, key1);

    await expect(decryptData(encrypted, key2)).rejects.toThrow();
  });

  it("produces different ciphertext for same plaintext (random IV)", async () => {
    const key = await makeTestKey();
    const plaintext = "deterministic?";

    const enc1 = await encryptData(plaintext, key);
    const enc2 = await encryptData(plaintext, key);

    // IVs should differ
    expect(enc1.iv).not.toBe(enc2.iv);
    // Ciphertexts should differ
    expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
  });

  it("handles empty string", async () => {
    const key = await makeTestKey();
    const encrypted = await encryptData("", key);
    const decrypted = await decryptData(encrypted, key);
    expect(decrypted).toBe("");
  });

  it("handles large JSON payload", async () => {
    const key = await makeTestKey();
    const aad = buildPersonalEntryAAD("user-big", "entry-big");
    const payload = JSON.stringify({
      title: "Example",
      username: "user@example.com",
      password: "x".repeat(1000),
      url: "https://example.com",
      notes: "A".repeat(5000),
    });

    const encrypted = await encryptData(payload, key, aad);
    const decrypted = await decryptData(encrypted, key, aad);
    expect(decrypted).toBe(payload);
  });
});
