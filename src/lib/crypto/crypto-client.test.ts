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

// Mock hash-wasm for Node/Vitest unit tests. Uses Web Crypto PBKDF2 as a
// fast deterministic stand-in — NOT cryptographically equivalent, but
// sufficient to verify integration plumbing. Real Argon2id RFC 9106
// conformance is proven by `argon2-vectors.test.ts` (cross-impl agreement
// hash-wasm vs @noble/hashes — both produce identical output for the same
// input).
//
// The mock parameter shape derives every non-(password|salt) field from
// hash-wasm's real `argon2id` signature via `Parameters<...>[0]` so a future
// upstream rename (e.g. `memorySize → memSize`) fails to compile here
// instead of producing a silently-broken mock. We narrow password/salt to
// `string | Uint8Array` because production callers only ever pass those two
// (hash-wasm itself accepts wider types, but exercising Buffer / ITypedArray
// in the mock would require Web-Crypto-incompatible copies).
type Hashwasm$Argon2idOpts = Parameters<
  typeof import("hash-wasm").argon2id
>[0];
type MockArgon2idOpts =
  Omit<Hashwasm$Argon2idOpts, "password" | "salt"> & {
    password: string | Uint8Array;
    salt: string | Uint8Array;
  };

vi.mock("hash-wasm", () => ({
  argon2id: async (opts: MockArgon2idOpts) => {
    // Re-wrap into an ArrayBuffer-backed Uint8Array. The Parameters<...> type
    // widens to Uint8Array<ArrayBufferLike> (could be SharedArrayBuffer-backed)
    // which Web Crypto APIs reject; Uint8Array.from() copies into a fresh
    // ArrayBuffer-backed buffer.
    const passBytes = Uint8Array.from(
      typeof opts.password === "string"
        ? new TextEncoder().encode(opts.password)
        : opts.password,
    );
    const saltBytes = Uint8Array.from(
      typeof opts.salt === "string"
        ? new TextEncoder().encode(opts.salt)
        : opts.salt,
    );
    // Fold argon2 params into salt so param changes produce different output.
    const paramSuffix = new TextEncoder().encode(
      `argon2id:t=${opts.iterations}:m=${opts.memorySize}:p=${opts.parallelism}`
    );
    const combinedSalt = new Uint8Array(saltBytes.length + paramSuffix.length);
    combinedSalt.set(saltBytes);
    combinedSalt.set(paramSuffix, saltBytes.length);

    const keyMaterial = await crypto.subtle.importKey(
      "raw", passBytes, "PBKDF2", false, ["deriveBits"],
    );
    // 1000 iter = fast test stand-in; production enforces 3 Argon2id iter via
    // deriveWrappingKeyArgon2id. PBKDF2 1000 iter is NOT a secure floor — mock only.
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: combinedSalt, iterations: 1000, hash: "SHA-256" },
      keyMaterial,
      opts.hashLength * 8,
    );
    return new Uint8Array(bits);
  },
}));

const TEST_PASSPHRASE = "test-passphrase-for-unit-tests";
const TEST_SALT = new Uint8Array(32).fill(0xab);

// deriveWrappingKeyWithParams integration tests — these verify the plumbing
// (param flow, output shape, error propagation) but DO NOT prove real Argon2id
// conformance: the mock above is a PBKDF2 stand-in. Real RFC 9106 conformance
// is proven by `argon2-vectors.test.ts` via cross-impl agreement.
describe("deriveWrappingKeyWithParams (Argon2id — integration only; conformance in argon2-vectors.test.ts)", () => {
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
