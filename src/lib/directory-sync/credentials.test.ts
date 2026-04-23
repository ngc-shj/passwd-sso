import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { ServerEncryptedData } from "@/lib/crypto/crypto-server";

// Mock crypto-server before importing the module under test
vi.mock("@/lib/crypto/crypto-server", () => ({
  encryptServerData: vi.fn(),
  decryptServerData: vi.fn(),
}));

import { encryptCredentials, decryptCredentials } from "./credentials";
import { encryptServerData, decryptServerData } from "@/lib/crypto/crypto-server";

const mockEncrypt = encryptServerData as ReturnType<typeof vi.fn>;
const mockDecrypt = decryptServerData as ReturnType<typeof vi.fn>;

const FAKE_ENCRYPTED: ServerEncryptedData = {
  ciphertext: "deadbeef",
  iv: "aabbccdd001122334455667788990011",
  authTag: "00112233445566778899aabbccddeeff",
};

// Save env vars set globally by setup.ts so we can restore them
const SAVED_ENV_KEYS = [
  "DIRECTORY_SYNC_MASTER_KEY",
  "SHARE_MASTER_KEY",
  "SHARE_MASTER_KEY_V1",
  "NODE_ENV",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(
    SAVED_ENV_KEYS.map((k) => [k, process.env[k]]),
  );
  mockEncrypt.mockReset();
  mockDecrypt.mockReset();
});

afterEach(() => {
  // Restore original env (including deleting vars that weren't set before)
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
});

describe("encryptCredentials", () => {
  it("calls encryptServerData with correct key derived from DIRECTORY_SYNC_MASTER_KEY", () => {
    vi.stubEnv("DIRECTORY_SYNC_MASTER_KEY", "d".repeat(64));
    mockEncrypt.mockReturnValue(FAKE_ENCRYPTED);

    const result = encryptCredentials('{"token":"secret"}', "config-1", "tenant-1");

    expect(mockEncrypt).toHaveBeenCalledOnce();
    const [plaintext, key, aad] = mockEncrypt.mock.calls[0];
    expect(plaintext).toBe('{"token":"secret"}');
    // key should be a 32-byte Buffer derived from the hex env var
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key.length).toBe(32);
    // AAD should bind configId and tenantId
    expect(aad.toString()).toBe("config-1:tenant-1");
    expect(result).toEqual(FAKE_ENCRYPTED);
  });

  it("falls back to SHARE_MASTER_KEY_V1 in non-production", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("SHARE_MASTER_KEY_V1", "e".repeat(64));
    mockEncrypt.mockReturnValue(FAKE_ENCRYPTED);

    encryptCredentials("data", "cfg", "ten");

    expect(mockEncrypt).toHaveBeenCalledOnce();
    const [, key] = mockEncrypt.mock.calls[0];
    expect(key.length).toBe(32);
  });

  it("falls back to SHARE_MASTER_KEY when SHARE_MASTER_KEY_V1 is absent", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("SHARE_MASTER_KEY", "f".repeat(64));
    mockEncrypt.mockReturnValue(FAKE_ENCRYPTED);

    encryptCredentials("data", "cfg", "ten");

    expect(mockEncrypt).toHaveBeenCalledOnce();
  });

  it("throws when no key is available in non-production", () => {
    process.env.NODE_ENV = "test";
    delete process.env.DIRECTORY_SYNC_MASTER_KEY;
    delete process.env.SHARE_MASTER_KEY_V1;
    delete process.env.SHARE_MASTER_KEY;
    expect(() => encryptCredentials("data", "cfg", "ten")).toThrow(
      "No encryption key available for directory sync credentials",
    );
  });

  it("throws in production when DIRECTORY_SYNC_MASTER_KEY is missing", () => {
    process.env.NODE_ENV = "production";
    delete process.env.DIRECTORY_SYNC_MASTER_KEY;
    // fallback keys should not be consulted in production
    process.env.SHARE_MASTER_KEY = "f".repeat(64);
    expect(() => encryptCredentials("data", "cfg", "ten")).toThrow(
      "DIRECTORY_SYNC_MASTER_KEY required in production",
    );
  });

  it("rejects an invalid (non-hex) DIRECTORY_SYNC_MASTER_KEY", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DIRECTORY_SYNC_MASTER_KEY", "z".repeat(64)); // invalid hex
    vi.stubEnv("SHARE_MASTER_KEY", "a".repeat(64)); // fallback
    mockEncrypt.mockReturnValue(FAKE_ENCRYPTED);

    // Should use fallback since the primary key fails validation
    encryptCredentials("data", "cfg", "ten");
    expect(mockEncrypt).toHaveBeenCalledOnce();
  });

  it("builds AAD as configId:tenantId for different IDs", () => {
    vi.stubEnv("DIRECTORY_SYNC_MASTER_KEY", "a".repeat(64));
    mockEncrypt.mockReturnValue(FAKE_ENCRYPTED);

    encryptCredentials("payload", "my-config", "my-tenant");

    const [, , aad] = mockEncrypt.mock.calls[0];
    expect(aad.toString()).toBe("my-config:my-tenant");
  });
});

describe("decryptCredentials", () => {
  it("calls decryptServerData with correct arguments", () => {
    vi.stubEnv("DIRECTORY_SYNC_MASTER_KEY", "d".repeat(64));
    mockDecrypt.mockReturnValue('{"token":"secret"}');

    const result = decryptCredentials(FAKE_ENCRYPTED, "config-1", "tenant-1");

    expect(mockDecrypt).toHaveBeenCalledOnce();
    const [encrypted, key, aad] = mockDecrypt.mock.calls[0];
    expect(encrypted).toEqual(FAKE_ENCRYPTED);
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key.length).toBe(32);
    expect(aad.toString()).toBe("config-1:tenant-1");
    expect(result).toBe('{"token":"secret"}');
  });

  it("returns the decrypted plaintext string", () => {
    vi.stubEnv("DIRECTORY_SYNC_MASTER_KEY", "d".repeat(64));
    mockDecrypt.mockReturnValue("decrypted-value");

    const result = decryptCredentials(FAKE_ENCRYPTED, "cfg", "ten");
    expect(result).toBe("decrypted-value");
  });

  it("propagates errors thrown by decryptServerData (e.g. auth tag mismatch)", () => {
    vi.stubEnv("DIRECTORY_SYNC_MASTER_KEY", "d".repeat(64));
    mockDecrypt.mockImplementation(() => {
      throw new Error("Unsupported state or unable to authenticate data");
    });

    expect(() => decryptCredentials(FAKE_ENCRYPTED, "cfg", "ten")).toThrow(
      "Unsupported state or unable to authenticate data",
    );
  });
});
