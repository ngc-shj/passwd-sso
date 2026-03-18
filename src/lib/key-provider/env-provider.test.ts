import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { EnvKeyProvider } from "./env-provider";

const VALID_HEX = "a".repeat(64);
const VALID_HEX_B = "b".repeat(64);
const VALID_HEX_C = "c".repeat(64);
const VALID_HEX_D = "d".repeat(64);

describe("EnvKeyProvider", () => {
  let provider: EnvKeyProvider;

  beforeEach(() => {
    provider = new EnvKeyProvider();
    vi.unstubAllEnvs();
  });

  it("has name 'env'", () => {
    expect(provider.name).toBe("env");
  });

  // ── share-master ──────────────────────────────────────────────

  describe("share-master", () => {
    it("reads SHARE_MASTER_KEY_V1 for version 1", () => {
      vi.stubEnv("SHARE_MASTER_KEY_V1", VALID_HEX);
      const key = provider.getKeySync("share-master", 1);
      expect(key).toEqual(Buffer.from(VALID_HEX, "hex"));
    });

    it("falls back to SHARE_MASTER_KEY when V1 is absent", () => {
      vi.stubEnv("SHARE_MASTER_KEY_V1", "");
      vi.stubEnv("SHARE_MASTER_KEY", VALID_HEX_B);
      const key = provider.getKeySync("share-master", 1);
      expect(key).toEqual(Buffer.from(VALID_HEX_B, "hex"));
    });

    it("prefers SHARE_MASTER_KEY_V1 over SHARE_MASTER_KEY", () => {
      vi.stubEnv("SHARE_MASTER_KEY_V1", VALID_HEX);
      vi.stubEnv("SHARE_MASTER_KEY", VALID_HEX_B);
      const key = provider.getKeySync("share-master", 1);
      expect(key).toEqual(Buffer.from(VALID_HEX, "hex"));
    });

    it("reads versioned key for V2+", () => {
      vi.stubEnv("SHARE_MASTER_KEY_V2", VALID_HEX_C);
      const key = provider.getKeySync("share-master", 2);
      expect(key).toEqual(Buffer.from(VALID_HEX_C, "hex"));
    });

    it("throws when V2 key is missing", () => {
      vi.stubEnv("SHARE_MASTER_KEY_V2", "");
      expect(() => provider.getKeySync("share-master", 2)).toThrow(
        "Master key for version 2 not found or invalid"
      );
    });

    it("throws for invalid version 0", () => {
      expect(() => provider.getKeySync("share-master", 0)).toThrow(
        "Invalid master key version: 0"
      );
    });

    it("throws for version 101", () => {
      expect(() => provider.getKeySync("share-master", 101)).toThrow(
        "Invalid master key version: 101"
      );
    });

    it("throws for non-integer version", () => {
      expect(() => provider.getKeySync("share-master", 1.5)).toThrow(
        "Invalid master key version: 1.5"
      );
    });

    it("throws when hex is invalid format", () => {
      vi.stubEnv("SHARE_MASTER_KEY_V1", "not-hex");
      expect(() => provider.getKeySync("share-master", 1)).toThrow(
        "not found or invalid"
      );
    });

    it("getKey returns same as getKeySync (Promise)", async () => {
      vi.stubEnv("SHARE_MASTER_KEY_V1", VALID_HEX);
      const key = await provider.getKey("share-master", 1);
      expect(key).toEqual(Buffer.from(VALID_HEX, "hex"));
    });

    it("defaults version to 1 when not specified", () => {
      vi.stubEnv("SHARE_MASTER_KEY_V1", VALID_HEX);
      const key = provider.getKeySync("share-master");
      expect(key).toEqual(Buffer.from(VALID_HEX, "hex"));
    });
  });

  // ── verifier-pepper ──────────────────────────────────────────

  describe("verifier-pepper", () => {
    it("reads VERIFIER_PEPPER_KEY when set", () => {
      vi.stubEnv("VERIFIER_PEPPER_KEY", VALID_HEX_B);
      const key = provider.getKeySync("verifier-pepper");
      expect(key).toEqual(Buffer.from(VALID_HEX_B, "hex"));
    });

    it("throws when VERIFIER_PEPPER_KEY is invalid hex", () => {
      vi.stubEnv("VERIFIER_PEPPER_KEY", "zzzz");
      expect(() => provider.getKeySync("verifier-pepper")).toThrow(
        "VERIFIER_PEPPER_KEY must be a 64-char hex string"
      );
    });

    it("falls back to derived key in dev/test mode", () => {
      vi.stubEnv("VERIFIER_PEPPER_KEY", "");
      vi.stubEnv("NODE_ENV", "test");
      vi.stubEnv("SHARE_MASTER_KEY_V1", VALID_HEX);
      const key = provider.getKeySync("verifier-pepper");
      const expected = createHash("sha256")
        .update("verifier-pepper:")
        .update(Buffer.from(VALID_HEX, "hex"))
        .digest();
      expect(key).toEqual(expected);
    });

    it("throws in production when VERIFIER_PEPPER_KEY is missing", () => {
      vi.stubEnv("VERIFIER_PEPPER_KEY", "");
      vi.stubEnv("NODE_ENV", "production");
      expect(() => provider.getKeySync("verifier-pepper")).toThrow(
        "VERIFIER_PEPPER_KEY is required in production"
      );
    });
  });

  // ── directory-sync ───────────────────────────────────────────

  describe("directory-sync", () => {
    it("reads DIRECTORY_SYNC_MASTER_KEY when set", () => {
      vi.stubEnv("DIRECTORY_SYNC_MASTER_KEY", VALID_HEX_D);
      const key = provider.getKeySync("directory-sync");
      expect(key).toEqual(Buffer.from(VALID_HEX_D, "hex"));
    });

    it("falls back to SHARE_MASTER_KEY_V1 in dev/test", () => {
      vi.stubEnv("DIRECTORY_SYNC_MASTER_KEY", "");
      vi.stubEnv("NODE_ENV", "test");
      vi.stubEnv("SHARE_MASTER_KEY_V1", VALID_HEX);
      const key = provider.getKeySync("directory-sync");
      expect(key).toEqual(Buffer.from(VALID_HEX, "hex"));
    });

    it("falls back to SHARE_MASTER_KEY when V1 absent in dev/test", () => {
      vi.stubEnv("DIRECTORY_SYNC_MASTER_KEY", "");
      vi.stubEnv("SHARE_MASTER_KEY_V1", "");
      vi.stubEnv("NODE_ENV", "test");
      vi.stubEnv("SHARE_MASTER_KEY", VALID_HEX_B);
      const key = provider.getKeySync("directory-sync");
      expect(key).toEqual(Buffer.from(VALID_HEX_B, "hex"));
    });

    it("throws in production when DIRECTORY_SYNC_MASTER_KEY is missing", () => {
      vi.stubEnv("DIRECTORY_SYNC_MASTER_KEY", "");
      vi.stubEnv("NODE_ENV", "production");
      expect(() => provider.getKeySync("directory-sync")).toThrow(
        "DIRECTORY_SYNC_MASTER_KEY required in production"
      );
    });

    it("throws in dev/test when no fallback key is available", () => {
      vi.stubEnv("DIRECTORY_SYNC_MASTER_KEY", "");
      vi.stubEnv("SHARE_MASTER_KEY_V1", "");
      vi.stubEnv("SHARE_MASTER_KEY", "");
      vi.stubEnv("NODE_ENV", "test");
      expect(() => provider.getKeySync("directory-sync")).toThrow(
        "No encryption key available for directory sync credentials"
      );
    });
  });

  // ── webauthn-prf ─────────────────────────────────────────────

  describe("webauthn-prf", () => {
    it("reads WEBAUTHN_PRF_SECRET when set", () => {
      vi.stubEnv("WEBAUTHN_PRF_SECRET", VALID_HEX_C);
      const key = provider.getKeySync("webauthn-prf");
      expect(key).toEqual(Buffer.from(VALID_HEX_C, "hex"));
    });

    it("throws when WEBAUTHN_PRF_SECRET is missing", () => {
      vi.stubEnv("WEBAUTHN_PRF_SECRET", "");
      expect(() => provider.getKeySync("webauthn-prf")).toThrow(
        "WEBAUTHN_PRF_SECRET must be a 64-character hex string"
      );
    });

    it("throws when WEBAUTHN_PRF_SECRET is wrong length", () => {
      vi.stubEnv("WEBAUTHN_PRF_SECRET", "abcd");
      expect(() => provider.getKeySync("webauthn-prf")).toThrow(
        "WEBAUTHN_PRF_SECRET must be a 64-character hex string"
      );
    });

    it("throws in production when WEBAUTHN_PRF_SECRET is missing", () => {
      vi.stubEnv("WEBAUTHN_PRF_SECRET", "");
      vi.stubEnv("NODE_ENV", "production");
      expect(() => provider.getKeySync("webauthn-prf")).toThrow(
        "WEBAUTHN_PRF_SECRET must be a 64-character hex string"
      );
    });
  });

  // ── validateKeys ─────────────────────────────────────────────

  describe("validateKeys", () => {
    it("resolves when current version key is accessible", async () => {
      vi.stubEnv("SHARE_MASTER_KEY_CURRENT_VERSION", "1");
      vi.stubEnv("SHARE_MASTER_KEY_V1", VALID_HEX);
      await expect(provider.validateKeys()).resolves.toBeUndefined();
    });

    it("defaults to version 1 when SHARE_MASTER_KEY_CURRENT_VERSION is unset", async () => {
      vi.stubEnv("SHARE_MASTER_KEY_CURRENT_VERSION", "");
      vi.stubEnv("SHARE_MASTER_KEY", VALID_HEX);
      await expect(provider.validateKeys()).resolves.toBeUndefined();
    });

    it("rejects when current version key is missing", async () => {
      vi.stubEnv("SHARE_MASTER_KEY_CURRENT_VERSION", "2");
      vi.stubEnv("SHARE_MASTER_KEY_V2", "");
      await expect(provider.validateKeys()).rejects.toThrow(
        "Master key for version 2 not found or invalid"
      );
    });

    it("rejects when SHARE_MASTER_KEY_CURRENT_VERSION is invalid", async () => {
      vi.stubEnv("SHARE_MASTER_KEY_CURRENT_VERSION", "0");
      await expect(provider.validateKeys()).rejects.toThrow(
        "SHARE_MASTER_KEY_CURRENT_VERSION must be a positive integer"
      );
    });
  });
});
