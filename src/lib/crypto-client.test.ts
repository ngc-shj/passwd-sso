import { describe, it, expect } from "vitest";
import {
  deriveWrappingKey,
  deriveWrappingKeyWithParams,
  DEFAULT_KDF_PARAMS,
  hexEncode,
} from "./crypto-client";

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
        kdfType: 1,
        kdfIterations: 600_000,
      }),
    ).rejects.toThrow("Unsupported kdfType: 1");
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
});
