import { describe, it, expect, beforeEach, vi } from "vitest";
import { AwsKmsKeyProvider, _resetKmsModuleCache, _setKmsModuleLoader } from "./aws-kms-provider";

const mockSend = vi.fn();

const PLAINTEXT_KEY = Buffer.from("a".repeat(64), "hex");
const ENCRYPTED_B64 = Buffer.from("encrypted-ciphertext").toString("base64");

function makeProvider(ttlMs = 300_000, maxStaleTtlMs?: number) {
  return new AwsKmsKeyProvider({ region: "us-east-1", ttlMs, maxStaleTtlMs });
}

describe("AwsKmsKeyProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    _resetKmsModuleCache();
    // Inject mock KMS module loader
    _setKmsModuleLoader(async () => ({
      KMSClient: class {
        send = mockSend;
      },
      DecryptCommand: class {
        input: unknown;
        constructor(input: unknown) { this.input = input; }
      },
    }));
  });

  it("has name 'aws-kms'", () => {
    expect(makeProvider().name).toBe("aws-kms");
  });

  // ── cache hit ─────────────────────────────────────────────────

  describe("cache hit", () => {
    it("calls KMS only once for two consecutive getKey calls within TTL", async () => {
      vi.stubEnv("KMS_ENCRYPTED_KEY_SHARE_MASTER_V1", ENCRYPTED_B64);
      mockSend.mockResolvedValue({ Plaintext: PLAINTEXT_KEY });

      const provider = makeProvider();
      const key1 = await provider.getKey("share-master", 1);
      const key2 = await provider.getKey("share-master", 1);

      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(key1).toEqual(PLAINTEXT_KEY);
      expect(key2).toEqual(PLAINTEXT_KEY);
    });

    it("uses separate cache entries for different versions", async () => {
      vi.stubEnv("KMS_ENCRYPTED_KEY_SHARE_MASTER_V1", ENCRYPTED_B64);
      vi.stubEnv("KMS_ENCRYPTED_KEY_SHARE_MASTER_V2", ENCRYPTED_B64);
      const key2Plaintext = Buffer.from("b".repeat(64), "hex");
      mockSend
        .mockResolvedValueOnce({ Plaintext: PLAINTEXT_KEY })
        .mockResolvedValueOnce({ Plaintext: key2Plaintext });

      const provider = makeProvider();
      const k1 = await provider.getKey("share-master", 1);
      const k2 = await provider.getKey("share-master", 2);

      expect(mockSend).toHaveBeenCalledTimes(2);
      expect(k1).toEqual(PLAINTEXT_KEY);
      expect(k2).toEqual(key2Plaintext);
    });
  });

  // ── cache expiry ──────────────────────────────────────────────

  describe("cache expiry", () => {
    it("calls KMS again after TTL expires", async () => {
      vi.useFakeTimers();
      vi.stubEnv("KMS_ENCRYPTED_KEY_SHARE_MASTER_V1", ENCRYPTED_B64);
      mockSend.mockResolvedValue({ Plaintext: PLAINTEXT_KEY });

      const provider = makeProvider(1000);
      await provider.getKey("share-master", 1);

      // Advance past TTL
      vi.advanceTimersByTime(1001);

      await provider.getKey("share-master", 1);

      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it("returns cached value when within TTL", async () => {
      vi.useFakeTimers();
      vi.stubEnv("KMS_ENCRYPTED_KEY_SHARE_MASTER_V1", ENCRYPTED_B64);
      mockSend.mockResolvedValue({ Plaintext: PLAINTEXT_KEY });

      const provider = makeProvider(1000);
      await provider.getKey("share-master", 1);

      vi.advanceTimersByTime(500);

      await provider.getKey("share-master", 1);

      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });

  // ── max stale TTL ─────────────────────────────────────────────

  describe("max stale TTL", () => {
    it("returns stale cached key when KMS fails and within maxStaleTtlMs", async () => {
      vi.useFakeTimers();
      vi.stubEnv("KMS_ENCRYPTED_KEY_SHARE_MASTER_V1", ENCRYPTED_B64);
      mockSend
        .mockResolvedValueOnce({ Plaintext: PLAINTEXT_KEY })
        .mockRejectedValueOnce(new Error("KMS unavailable"));

      const provider = makeProvider(1000, 3000);
      await provider.getKey("share-master", 1);

      // Advance past TTL but within maxStaleTtlMs
      vi.advanceTimersByTime(1500);

      const key = await provider.getKey("share-master", 1);
      expect(key).toEqual(PLAINTEXT_KEY);
    });

    it("throws when KMS fails and stale key is beyond maxStaleTtlMs", async () => {
      vi.useFakeTimers();
      vi.stubEnv("KMS_ENCRYPTED_KEY_SHARE_MASTER_V1", ENCRYPTED_B64);
      mockSend
        .mockResolvedValueOnce({ Plaintext: PLAINTEXT_KEY })
        .mockRejectedValueOnce(new Error("KMS unavailable"));

      const provider = makeProvider(1000, 2000);
      await provider.getKey("share-master", 1);

      // Advance beyond maxStaleTtlMs
      vi.advanceTimersByTime(2001);

      await expect(provider.getKey("share-master", 1)).rejects.toThrow(
        "KMS unavailable"
      );
    });

    it("throws when KMS fails and no cached key exists", async () => {
      vi.stubEnv("KMS_ENCRYPTED_KEY_SHARE_MASTER_V1", ENCRYPTED_B64);
      mockSend.mockRejectedValue(new Error("KMS unavailable"));

      const provider = makeProvider();
      await expect(provider.getKey("share-master", 1)).rejects.toThrow(
        "KMS unavailable"
      );
    });
  });

  // ── getKeySync ────────────────────────────────────────────────

  describe("getKeySync", () => {
    it("returns cached value when cache is warm", async () => {
      vi.stubEnv("KMS_ENCRYPTED_KEY_SHARE_MASTER_V1", ENCRYPTED_B64);
      mockSend.mockResolvedValue({ Plaintext: PLAINTEXT_KEY });

      const provider = makeProvider();
      await provider.getKey("share-master", 1);
      const key = provider.getKeySync("share-master", 1);

      expect(key).toEqual(PLAINTEXT_KEY);
    });

    it("throws when cache is cold (not pre-warmed)", () => {
      const provider = makeProvider();
      expect(() => provider.getKeySync("share-master", 1)).toThrow(
        "Key \"share-master\" not in cache. Call validateKeys() at startup."
      );
    });

    it("throws when cache has expired beyond maxStaleTtlMs", async () => {
      vi.useFakeTimers();
      vi.stubEnv("KMS_ENCRYPTED_KEY_SHARE_MASTER_V1", ENCRYPTED_B64);
      mockSend.mockResolvedValue({ Plaintext: PLAINTEXT_KEY });

      const provider = makeProvider(1000, 2000);
      await provider.getKey("share-master", 1);

      vi.advanceTimersByTime(2001);

      expect(() => provider.getKeySync("share-master", 1)).toThrow(
        "cache expired beyond max stale TTL"
      );
    });

    it("triggers background refresh when past TTL but within maxStaleTtlMs", async () => {
      vi.useFakeTimers();
      vi.stubEnv("KMS_ENCRYPTED_KEY_SHARE_MASTER_V1", ENCRYPTED_B64);
      mockSend.mockResolvedValue({ Plaintext: PLAINTEXT_KEY });

      const provider = makeProvider(1000, 3000);
      await provider.getKey("share-master", 1);

      // Past TTL but within maxStaleTtlMs
      vi.advanceTimersByTime(1500);

      const key = provider.getKeySync("share-master", 1);
      expect(key).toEqual(PLAINTEXT_KEY);

      // Let the background refresh microtask run
      await vi.runAllTimersAsync();

      // Should have called KMS a second time (background refresh)
      expect(mockSend).toHaveBeenCalledTimes(2);
    });
  });

  // ── validateKeys ──────────────────────────────────────────────

  // ── KMS returns no Plaintext ──────────────────────────────────

  it("throws when KMS returns no Plaintext", async () => {
    vi.stubEnv("KMS_ENCRYPTED_KEY_SHARE_MASTER", ENCRYPTED_B64);
    mockSend.mockResolvedValue({});

    const provider = makeProvider();
    await expect(provider.getKey("share-master")).rejects.toThrow(
      "KMS Decrypt returned no plaintext"
    );
  });

  // ── directory-sync key type ──────────────────────────────────

  it("resolves directory-sync key via KMS_ENCRYPTED_KEY_DIRECTORY_SYNC", async () => {
    vi.stubEnv("KMS_ENCRYPTED_KEY_DIRECTORY_SYNC", ENCRYPTED_B64);
    mockSend.mockResolvedValue({ Plaintext: PLAINTEXT_KEY });

    const provider = makeProvider();
    const key = await provider.getKey("directory-sync");
    expect(key).toEqual(PLAINTEXT_KEY);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  // ── validateKeys ──────────────────────────────────────────────

  describe("validateKeys", () => {
    it("warms cache for share-master (unversioned)", async () => {
      vi.stubEnv("SHARE_MASTER_KEY_CURRENT_VERSION", "1");
      vi.stubEnv("KMS_ENCRYPTED_KEY_SHARE_MASTER", ENCRYPTED_B64);
      mockSend.mockResolvedValue({ Plaintext: PLAINTEXT_KEY });

      const provider = makeProvider();
      await provider.validateKeys();

      expect(mockSend).toHaveBeenCalledTimes(1);
      // getKeySync with no version should work
      expect(provider.getKeySync("share-master")).toEqual(PLAINTEXT_KEY);
    });

    it("also warms other key types when their env vars are set", async () => {
      vi.stubEnv("SHARE_MASTER_KEY_CURRENT_VERSION", "1");
      vi.stubEnv("KMS_ENCRYPTED_KEY_SHARE_MASTER", ENCRYPTED_B64);
      vi.stubEnv("KMS_ENCRYPTED_KEY_VERIFIER_PEPPER", ENCRYPTED_B64);
      vi.stubEnv("KMS_ENCRYPTED_KEY_DIRECTORY_SYNC", ENCRYPTED_B64);
      vi.stubEnv("KMS_ENCRYPTED_KEY_WEBAUTHN_PRF", ENCRYPTED_B64);
      mockSend.mockResolvedValue({ Plaintext: PLAINTEXT_KEY });

      const provider = makeProvider();
      await provider.validateKeys();

      // share-master, verifier-pepper, directory-sync, webauthn-prf = 4 calls
      expect(mockSend).toHaveBeenCalledTimes(4);
    });

    it("throws when KMS decryption fails during validation", async () => {
      vi.stubEnv("SHARE_MASTER_KEY_CURRENT_VERSION", "1");
      vi.stubEnv("KMS_ENCRYPTED_KEY_SHARE_MASTER", ENCRYPTED_B64);
      mockSend.mockRejectedValue(new Error("KMS access denied"));

      const provider = makeProvider();
      await expect(provider.validateKeys()).rejects.toThrow("KMS access denied");
    });

    it("throws when encrypted key env var is not set", async () => {
      vi.stubEnv("SHARE_MASTER_KEY_CURRENT_VERSION", "1");
      // KMS_ENCRYPTED_KEY_SHARE_MASTER not set → prerequisite check fires
      const provider = makeProvider();
      await expect(provider.validateKeys()).rejects.toThrow(
        "KMS_ENCRYPTED_KEY_SHARE_MASTER is required"
      );
    });

    it("throws when SHARE_MASTER_KEY_CURRENT_VERSION is invalid", async () => {
      vi.stubEnv("SHARE_MASTER_KEY_CURRENT_VERSION", "abc");
      vi.stubEnv("KMS_ENCRYPTED_KEY_SHARE_MASTER", ENCRYPTED_B64);

      const provider = makeProvider();
      await expect(provider.validateKeys()).rejects.toThrow(
        "SHARE_MASTER_KEY_CURRENT_VERSION must be a positive integer"
      );
    });

    it("throws when AWS_REGION is empty", async () => {
      const provider = new AwsKmsKeyProvider({ region: "", ttlMs: 300_000 });
      await expect(provider.validateKeys()).rejects.toThrow(
        "AWS_REGION is required"
      );
    });
  });
});
