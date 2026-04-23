import { describe, it, expect, vi } from "vitest";
import {
  deriveWrappingKey,
  deriveWrappingKeyWithParams,
  DEFAULT_KDF_PARAMS,
  ARGON2ID_KDF_PARAMS,
  hexEncode,
  generateSecretKey,
  wrapSecretKey,
  unwrapSecretKey,
  deriveEncryptionKey,
  deriveAuthKey,
  computeAuthHash,
  createVerificationArtifact,
  verifyKey,
} from "./crypto-client";
import type { EncryptedData } from "./crypto-client";

// Mock argon2-browser for Node/Vitest (WASM not available)
// Uses PBKDF2 as a deterministic stand-in — NOT cryptographically equivalent,
// but sufficient to verify the integration plumbing.
vi.mock("argon2-browser", () => ({
  default: {
    ArgonType: { Argon2d: 0, Argon2i: 1, Argon2id: 2 },
    hash: async (opts: {
      pass: string | Uint8Array;
      salt: string | Uint8Array;
      time: number;
      mem: number;
      parallelism: number;
      hashLen: number;
      type: number;
    }) => {
      // Deterministic hash using Web Crypto PBKDF2 as stand-in
      const passBytes = typeof opts.pass === "string"
        ? new TextEncoder().encode(opts.pass)
        : opts.pass;
      const saltBytes = typeof opts.salt === "string"
        ? new TextEncoder().encode(opts.salt)
        : opts.salt;
      // Include argon2 params in salt to ensure param changes produce different output
      const paramSuffix = new TextEncoder().encode(
        `argon2id:t=${opts.time}:m=${opts.mem}:p=${opts.parallelism}`
      );
      const combinedSalt = new Uint8Array(saltBytes.length + paramSuffix.length);
      combinedSalt.set(saltBytes);
      combinedSalt.set(paramSuffix, saltBytes.length);

      const keyMaterial = await crypto.subtle.importKey(
        "raw", passBytes, "PBKDF2", false, ["deriveBits"],
      );
      const bits = await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt: combinedSalt, iterations: 1000, hash: "SHA-256" },
        keyMaterial,
        opts.hashLen * 8,
      );
      return { hash: new Uint8Array(bits), hashHex: "", encoded: "" };
    },
  },
}));

const TEST_PASSPHRASE = "test-passphrase-for-unit-tests";
const TEST_SALT = new Uint8Array(32).fill(0xab);

describe("deriveWrappingKeyWithParams", () => {
  it("produces the same key as deriveWrappingKey with default params", async () => {
    const [keyA, keyB] = await Promise.all([
      deriveWrappingKey(TEST_PASSPHRASE, TEST_SALT),
      deriveWrappingKeyWithParams(TEST_PASSPHRASE, TEST_SALT, DEFAULT_KDF_PARAMS),
    ]);

    // Both keys are non-extractable by design, but we can export for test
    // deriveWrappingKey creates non-extractable keys, so compare via encrypt
    const testData = new TextEncoder().encode("test");
    const iv = new Uint8Array(12);

    const encA = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, keyA, testData);
    const encB = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, keyB, testData);

    expect(hexEncode(encA)).toBe(hexEncode(encB));
  });

  it("falls back to hardcoded constants when params is undefined", async () => {
    const [keyA, keyB] = await Promise.all([
      deriveWrappingKey(TEST_PASSPHRASE, TEST_SALT),
      deriveWrappingKeyWithParams(TEST_PASSPHRASE, TEST_SALT),
    ]);

    const testData = new TextEncoder().encode("fallback-test");
    const iv = new Uint8Array(12).fill(0x01);

    const encA = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, keyA, testData);
    const encB = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, keyB, testData);

    expect(hexEncode(encA)).toBe(hexEncode(encB));
  });

  it("throws on unsupported kdfType", async () => {
    await expect(
      deriveWrappingKeyWithParams(TEST_PASSPHRASE, TEST_SALT, {
        kdfType: 2,
        kdfIterations: 600_000,
      }),
    ).rejects.toThrow("Unsupported kdfType: 2");
  });

  it("throws on iterations below minimum", async () => {
    await expect(
      deriveWrappingKeyWithParams(TEST_PASSPHRASE, TEST_SALT, {
        kdfType: 0,
        kdfIterations: 100_000,
      }),
    ).rejects.toThrow("below minimum");
  });

  it("DEFAULT_KDF_PARAMS has expected values", () => {
    expect(DEFAULT_KDF_PARAMS).toEqual({
      kdfType: 0,
      kdfIterations: 600_000,
    });
  });

  it("ARGON2ID_KDF_PARAMS has expected values", () => {
    expect(ARGON2ID_KDF_PARAMS).toEqual({
      kdfType: 1,
      kdfIterations: 3,
      kdfMemory: 65536,
      kdfParallelism: 4,
    });
  });
});

describe("deriveWrappingKeyWithParams (Argon2id)", () => {
  // Use low-cost params for fast tests
  const ARGON2_TEST_PARAMS = {
    kdfType: 1 as const,
    kdfIterations: 1,
    kdfMemory: 16384,
    kdfParallelism: 1,
  };

  it("derives a working AES-256-GCM key from Argon2id", async () => {
    const key = await deriveWrappingKeyWithParams(
      TEST_PASSPHRASE,
      TEST_SALT,
      ARGON2_TEST_PARAMS,
    );

    expect(key.algorithm).toMatchObject({ name: "AES-GCM" });
    expect(key.usages).toContain("encrypt");
    expect(key.usages).toContain("decrypt");

    // Round-trip encrypt/decrypt
    const data = new TextEncoder().encode("argon2id-test");
    const iv = new Uint8Array(12).fill(0x42);
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encrypted);
    expect(new TextDecoder().decode(decrypted)).toBe("argon2id-test");
  });

  it("produces deterministic output for same input", async () => {
    const key1 = await deriveWrappingKeyWithParams(
      TEST_PASSPHRASE,
      TEST_SALT,
      ARGON2_TEST_PARAMS,
    );
    const key2 = await deriveWrappingKeyWithParams(
      TEST_PASSPHRASE,
      TEST_SALT,
      ARGON2_TEST_PARAMS,
    );

    const data = new TextEncoder().encode("determinism-test");
    const iv = new Uint8Array(12).fill(0x33);
    const enc1 = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key1, data);
    const enc2 = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key2, data);
    expect(hexEncode(enc1)).toBe(hexEncode(enc2));
  });

  it("produces different key from PBKDF2 with same passphrase", async () => {
    const argon2Key = await deriveWrappingKeyWithParams(
      TEST_PASSPHRASE,
      TEST_SALT,
      ARGON2_TEST_PARAMS,
    );
    const pbkdf2Key = await deriveWrappingKeyWithParams(
      TEST_PASSPHRASE,
      TEST_SALT,
      DEFAULT_KDF_PARAMS,
    );

    const data = new TextEncoder().encode("cross-kdf-test");
    const iv = new Uint8Array(12).fill(0x55);
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, argon2Key, data);
    await expect(
      crypto.subtle.decrypt({ name: "AES-GCM", iv }, pbkdf2Key, encrypted),
    ).rejects.toThrow();
  });

  it("different salts produce different keys", async () => {
    const salt2 = new Uint8Array(32).fill(0xcd);
    const key1 = await deriveWrappingKeyWithParams(
      TEST_PASSPHRASE,
      TEST_SALT,
      ARGON2_TEST_PARAMS,
    );
    const key2 = await deriveWrappingKeyWithParams(
      TEST_PASSPHRASE,
      salt2,
      ARGON2_TEST_PARAMS,
    );

    const data = new TextEncoder().encode("salt-test");
    const iv = new Uint8Array(12).fill(0x66);
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key1, data);
    await expect(
      crypto.subtle.decrypt({ name: "AES-GCM", iv }, key2, encrypted),
    ).rejects.toThrow();
  });

  it("rejects memory below minimum", async () => {
    await expect(
      deriveWrappingKeyWithParams(TEST_PASSPHRASE, TEST_SALT, {
        kdfType: 1, kdfIterations: 1, kdfMemory: 1024, kdfParallelism: 1,
      }),
    ).rejects.toThrow("below minimum 16384");
  });

  it("rejects parallelism below minimum", async () => {
    await expect(
      deriveWrappingKeyWithParams(TEST_PASSPHRASE, TEST_SALT, {
        kdfType: 1, kdfIterations: 1, kdfMemory: 16384, kdfParallelism: 0,
      }),
    ).rejects.toThrow("below minimum 1");
  });

  it("rejects iterations below minimum", async () => {
    await expect(
      deriveWrappingKeyWithParams(TEST_PASSPHRASE, TEST_SALT, {
        kdfType: 1, kdfIterations: 0, kdfMemory: 16384, kdfParallelism: 1,
      }),
    ).rejects.toThrow("below minimum 1");
  });

  it("different params produce different keys", async () => {
    const params2 = { ...ARGON2_TEST_PARAMS, kdfParallelism: 2 };
    const key1 = await deriveWrappingKeyWithParams(
      TEST_PASSPHRASE,
      TEST_SALT,
      ARGON2_TEST_PARAMS,
    );
    const key2 = await deriveWrappingKeyWithParams(
      TEST_PASSPHRASE,
      TEST_SALT,
      params2,
    );

    const data = new TextEncoder().encode("param-test");
    const iv = new Uint8Array(12).fill(0x77);
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key1, data);
    await expect(
      crypto.subtle.decrypt({ name: "AES-GCM", iv }, key2, encrypted),
    ).rejects.toThrow();
  });
});

// ─── Helpers shared across lower-level test suites ───────────────────────────

async function makeWrappingKey(): Promise<CryptoKey> {
  return deriveWrappingKeyWithParams(TEST_PASSPHRASE, TEST_SALT, DEFAULT_KDF_PARAMS);
}

async function makeWrappingKey2(): Promise<CryptoKey> {
  const salt2 = new Uint8Array(32).fill(0xcd);
  return deriveWrappingKeyWithParams("different-passphrase", salt2, DEFAULT_KDF_PARAMS);
}

// ─── wrapSecretKey / unwrapSecretKey ─────────────────────────────────────────

describe("wrapSecretKey / unwrapSecretKey", () => {
  it("roundtrip: wrap then unwrap returns the original secret key", async () => {
    const secretKey = generateSecretKey();
    const wrappingKey = await makeWrappingKey();

    const encrypted = await wrapSecretKey(secretKey, wrappingKey);
    const recovered = await unwrapSecretKey(encrypted, wrappingKey);

    expect(recovered).toEqual(secretKey);
  });

  it("different wrapping keys produce different ciphertexts for the same secret key", async () => {
    const secretKey = generateSecretKey();
    const wrappingKey1 = await makeWrappingKey();
    const wrappingKey2 = await makeWrappingKey2();

    const enc1 = await wrapSecretKey(secretKey, wrappingKey1);
    const enc2 = await wrapSecretKey(secretKey, wrappingKey2);

    // Ciphertexts must differ (different keys, different IVs — at least one differs)
    expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
  });

  it("each wrap produces a unique IV (non-deterministic)", async () => {
    const secretKey = generateSecretKey();
    const wrappingKey = await makeWrappingKey();

    const enc1 = await wrapSecretKey(secretKey, wrappingKey);
    const enc2 = await wrapSecretKey(secretKey, wrappingKey);

    expect(enc1.iv).not.toBe(enc2.iv);
  });

  it("tampered ciphertext causes unwrap to throw (GCM auth failure)", async () => {
    const secretKey = generateSecretKey();
    const wrappingKey = await makeWrappingKey();
    const encrypted = await wrapSecretKey(secretKey, wrappingKey);

    // Flip the first byte of the ciphertext hex
    const tampered: EncryptedData = {
      ...encrypted,
      ciphertext: flipFirstHexByte(encrypted.ciphertext),
    };

    await expect(unwrapSecretKey(tampered, wrappingKey)).rejects.toThrow();
  });

  it("tampered authTag causes unwrap to throw", async () => {
    const secretKey = generateSecretKey();
    const wrappingKey = await makeWrappingKey();
    const encrypted = await wrapSecretKey(secretKey, wrappingKey);

    const tampered: EncryptedData = {
      ...encrypted,
      authTag: flipFirstHexByte(encrypted.authTag),
    };

    await expect(unwrapSecretKey(tampered, wrappingKey)).rejects.toThrow();
  });

  it("tampered IV causes unwrap to throw", async () => {
    const secretKey = generateSecretKey();
    const wrappingKey = await makeWrappingKey();
    const encrypted = await wrapSecretKey(secretKey, wrappingKey);

    const tampered: EncryptedData = {
      ...encrypted,
      iv: flipFirstHexByte(encrypted.iv),
    };

    await expect(unwrapSecretKey(tampered, wrappingKey)).rejects.toThrow();
  });

  it("wrong wrapping key causes unwrap to throw", async () => {
    const secretKey = generateSecretKey();
    const wrappingKey1 = await makeWrappingKey();
    const wrappingKey2 = await makeWrappingKey2();

    const encrypted = await wrapSecretKey(secretKey, wrappingKey1);

    await expect(unwrapSecretKey(encrypted, wrappingKey2)).rejects.toThrow();
  });
});

// ─── computeAuthHash ─────────────────────────────────────────────────────────

describe("computeAuthHash", () => {
  it("is deterministic: same key produces same hash", async () => {
    const secretKey = new Uint8Array(32).fill(0xaa);
    const authKey = await deriveAuthKey(secretKey);

    const hash1 = await computeAuthHash(authKey);
    const hash2 = await computeAuthHash(authKey);

    expect(hash1).toBe(hash2);
  });

  it("different keys produce different hashes", async () => {
    const secretKey1 = new Uint8Array(32).fill(0xaa);
    const secretKey2 = new Uint8Array(32).fill(0xbb);

    const authKey1 = await deriveAuthKey(secretKey1);
    const authKey2 = await deriveAuthKey(secretKey2);

    const hash1 = await computeAuthHash(authKey1);
    const hash2 = await computeAuthHash(authKey2);

    expect(hash1).not.toBe(hash2);
  });

  it("output is a 64-character lowercase hex string (SHA-256)", async () => {
    const secretKey = generateSecretKey();
    const authKey = await deriveAuthKey(secretKey);

    const hash = await computeAuthHash(authKey);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ─── createVerificationArtifact / verifyKey ──────────────────────────────────

describe("createVerificationArtifact / verifyKey", () => {
  it("roundtrip: create then verify with same key returns true", async () => {
    const secretKey = generateSecretKey();
    const encryptionKey = await deriveEncryptionKey(secretKey);

    const artifact = await createVerificationArtifact(encryptionKey);
    const result = await verifyKey(encryptionKey, artifact);

    expect(result).toBe(true);
  });

  it("verify with wrong key returns false", async () => {
    const secretKey1 = generateSecretKey();
    const secretKey2 = generateSecretKey();
    const encryptionKey1 = await deriveEncryptionKey(secretKey1);
    const encryptionKey2 = await deriveEncryptionKey(secretKey2);

    const artifact = await createVerificationArtifact(encryptionKey1);
    const result = await verifyKey(encryptionKey2, artifact);

    expect(result).toBe(false);
  });

  it("tampered artifact returns false", async () => {
    const secretKey = generateSecretKey();
    const encryptionKey = await deriveEncryptionKey(secretKey);

    const artifact = await createVerificationArtifact(encryptionKey);
    const tampered: EncryptedData = {
      ...artifact,
      ciphertext: flipFirstHexByte(artifact.ciphertext),
    };

    const result = await verifyKey(encryptionKey, tampered);
    expect(result).toBe(false);
  });
});

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Flip the first byte of a hex string to produce a deterministically different value.
 * "00..." → "01...", "ff..." → "fe..."
 */
function flipFirstHexByte(hex: string): string {
  const byte = parseInt(hex.slice(0, 2), 16);
  const flipped = (byte ^ 0xff).toString(16).padStart(2, "0");
  return flipped + hex.slice(2);
}
