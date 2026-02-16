import { describe, it, expect } from "vitest";
import {
  hexEncode,
  hexDecode,
  deriveWrappingKey,
  deriveEncryptionKey,
  unwrapSecretKey,
  verifyKey,
  decryptData,
  buildPersonalEntryAAD,
  type EncryptedData,
} from "../../lib/crypto";

// ─── Hex utilities ──────────────────────────────────────────

describe("hexEncode", () => {
  it("encodes Uint8Array to hex string", () => {
    expect(hexEncode(new Uint8Array([0x00, 0xff, 0x0a]))).toBe("00ff0a");
  });

  it("encodes ArrayBuffer to hex string", () => {
    const buf = new Uint8Array([0xde, 0xad, 0xbe, 0xef]).buffer;
    expect(hexEncode(buf)).toBe("deadbeef");
  });

  it("returns empty string for empty input", () => {
    expect(hexEncode(new Uint8Array([]))).toBe("");
  });
});

describe("hexDecode", () => {
  it("decodes hex string to Uint8Array", () => {
    const result = hexDecode("00ff0a");
    expect(result).toEqual(new Uint8Array([0x00, 0xff, 0x0a]));
  });

  it("returns empty array for empty string", () => {
    expect(hexDecode("")).toEqual(new Uint8Array([]));
  });

  it("roundtrips with hexEncode", () => {
    const original = new Uint8Array([1, 2, 3, 128, 255]);
    expect(hexDecode(hexEncode(original))).toEqual(original);
  });
});

// ─── Key derivation (integration) ──────────────────────────

describe("deriveWrappingKey", () => {
  it("returns a CryptoKey usable for AES-GCM", async () => {
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const key = await deriveWrappingKey("test-passphrase", salt);
    expect(key).toBeInstanceOf(CryptoKey);
    expect(key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    expect(key.usages).toContain("encrypt");
    expect(key.usages).toContain("decrypt");
  });

  it("produces different keys for different passphrases", async () => {
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const key1 = await deriveWrappingKey("passA", salt);
    const key2 = await deriveWrappingKey("passB", salt);
    // Encrypt with key1, should fail to decrypt with key2
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode("test");
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key1, data);
    await expect(
      crypto.subtle.decrypt({ name: "AES-GCM", iv }, key2, encrypted),
    ).rejects.toThrow();
  }, 30_000);

  it("produces different keys for different salts", async () => {
    const salt1 = new Uint8Array(32).fill(1);
    const salt2 = new Uint8Array(32).fill(2);
    const key1 = await deriveWrappingKey("same", salt1);
    const key2 = await deriveWrappingKey("same", salt2);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode("test");
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key1, data);
    await expect(
      crypto.subtle.decrypt({ name: "AES-GCM", iv }, key2, encrypted),
    ).rejects.toThrow();
  }, 30_000);
});

describe("deriveEncryptionKey", () => {
  it("returns a CryptoKey from secret key bytes", async () => {
    const secretKey = crypto.getRandomValues(new Uint8Array(32));
    const key = await deriveEncryptionKey(secretKey);
    expect(key).toBeInstanceOf(CryptoKey);
    expect(key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
  });
});

// ─── Encrypt + decrypt roundtrip ────────────────────────────

async function makeTestKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encrypt(
  plaintext: string,
  key: CryptoKey,
  aad?: Uint8Array,
): Promise<EncryptedData> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const params: AesGcmParams = { name: "AES-GCM", iv };
  if (aad) params.additionalData = aad.buffer.slice(aad.byteOffset, aad.byteOffset + aad.byteLength) as ArrayBuffer;

  const encoded = new TextEncoder().encode(plaintext);
  const result = await crypto.subtle.encrypt(params, key, encoded);

  const resultBytes = new Uint8Array(result);
  const ciphertext = resultBytes.slice(0, -16);
  const authTag = resultBytes.slice(-16);

  return {
    ciphertext: hexEncode(ciphertext),
    iv: hexEncode(iv),
    authTag: hexEncode(authTag),
  };
}

describe("decryptData", () => {
  it("decrypts data encrypted with AES-256-GCM", async () => {
    const key = await makeTestKey();
    const encrypted = await encrypt("hello world", key);
    const result = await decryptData(encrypted, key);
    expect(result).toBe("hello world");
  });

  it("decrypts with AAD", async () => {
    const key = await makeTestKey();
    const aad = new TextEncoder().encode("extra-context");
    const encrypted = await encrypt("secret", key, aad);
    const result = await decryptData(encrypted, key, aad);
    expect(result).toBe("secret");
  });

  it("fails with wrong key", async () => {
    const key1 = await makeTestKey();
    const key2 = await makeTestKey();
    const encrypted = await encrypt("data", key1);
    await expect(decryptData(encrypted, key2)).rejects.toThrow();
  });

  it("fails with tampered ciphertext", async () => {
    const key = await makeTestKey();
    const encrypted = await encrypt("data", key);
    const b = parseInt(encrypted.ciphertext.slice(0, 2), 16);
    const f = ((b ^ 0x01) & 0xff).toString(16).padStart(2, "0");
    encrypted.ciphertext = f + encrypted.ciphertext.slice(2);
    await expect(decryptData(encrypted, key)).rejects.toThrow();
  });
});

// ─── unwrapSecretKey ────────────────────────────────────────

describe("unwrapSecretKey", () => {
  it("unwraps an encrypted secret key", async () => {
    const wrappingKey = await makeTestKey();
    const secretKey = crypto.getRandomValues(new Uint8Array(32));

    // Wrap the secret key
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const result = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      wrappingKey,
      secretKey,
    );
    const resultBytes = new Uint8Array(result);
    const ciphertext = resultBytes.slice(0, -16);
    const authTag = resultBytes.slice(-16);

    const encrypted: EncryptedData = {
      ciphertext: hexEncode(ciphertext),
      iv: hexEncode(iv),
      authTag: hexEncode(authTag),
    };

    const unwrapped = await unwrapSecretKey(encrypted, wrappingKey);
    expect(unwrapped).toEqual(secretKey);
  });
});

// ─── verifyKey ──────────────────────────────────────────────

describe("verifyKey", () => {
  it("returns true for valid verification artifact", async () => {
    const key = await makeTestKey();
    const plaintext = "passwd-sso-vault-verification-v1";
    const encrypted = await encrypt(plaintext, key);
    const result = await verifyKey(key, encrypted);
    expect(result).toBe(true);
  });

  it("returns false for wrong plaintext", async () => {
    const key = await makeTestKey();
    const encrypted = await encrypt("wrong-plaintext", key);
    const result = await verifyKey(key, encrypted);
    expect(result).toBe(false);
  });

  it("returns false for wrong key", async () => {
    const key1 = await makeTestKey();
    const key2 = await makeTestKey();
    const encrypted = await encrypt("passwd-sso-vault-verification-v1", key1);
    const result = await verifyKey(key2, encrypted);
    expect(result).toBe(false);
  });
});

// ─── buildPersonalEntryAAD ──────────────────────────────────

describe("buildPersonalEntryAAD", () => {
  it("produces deterministic output", () => {
    const a = buildPersonalEntryAAD("user-1", "entry-1");
    const b = buildPersonalEntryAAD("user-1", "entry-1");
    expect(hexEncode(a)).toBe(hexEncode(b));
  });

  it("differs for different userId", () => {
    const a = buildPersonalEntryAAD("user-1", "entry-1");
    const b = buildPersonalEntryAAD("user-2", "entry-1");
    expect(hexEncode(a)).not.toBe(hexEncode(b));
  });

  it("differs for different entryId", () => {
    const a = buildPersonalEntryAAD("user-1", "entry-1");
    const b = buildPersonalEntryAAD("user-1", "entry-2");
    expect(hexEncode(a)).not.toBe(hexEncode(b));
  });

  it("starts with scope 'PV' and version 1", () => {
    const aad = buildPersonalEntryAAD("u", "e");
    expect(aad[0]).toBe("P".charCodeAt(0));
    expect(aad[1]).toBe("V".charCodeAt(0));
    expect(aad[2]).toBe(1); // version
    expect(aad[3]).toBe(2); // field count
  });

  it("can be used as AAD for encryption/decryption", async () => {
    const key = await makeTestKey();
    const aad = buildPersonalEntryAAD("user-1", "entry-1");
    const encrypted = await encrypt("secret-data", key, aad);
    const result = await decryptData(encrypted, key, aad);
    expect(result).toBe("secret-data");
  });
});
