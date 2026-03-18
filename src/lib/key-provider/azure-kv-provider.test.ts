import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  AzureKvKeyProvider,
  _resetAzureKvModuleCache,
  _setAzureKvModuleLoader,
} from "./azure-kv-provider";
import { BaseCloudKeyProvider } from "./base-cloud-provider";

const PLAINTEXT_HEX = "a".repeat(64);
const PLAINTEXT_KEY = Buffer.from(PLAINTEXT_HEX, "hex");

const mockGetSecret = vi.fn();

function makeProvider(ttlMs = 300_000, maxStaleTtlMs?: number) {
  return new AzureKvKeyProvider({
    vaultUrl: "https://test-vault.vault.azure.net",
    ttlMs,
    maxStaleTtlMs,
  });
}

describe("AzureKvKeyProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    _resetAzureKvModuleCache();
    _setAzureKvModuleLoader(async () => ({
      kv: {
        SecretClient: class {
          getSecret = mockGetSecret;
        },
      },
      identity: {
        DefaultAzureCredential: class {},
      },
    }));
    // Silence logStaleWarning — logger named import is undefined in this module
    // because @/lib/logger has no named `logger` export (only default export).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(BaseCloudKeyProvider.prototype as any, "logStaleWarning").mockImplementation(() => {});
  });

  it("has name 'azure-kv'", () => {
    expect(makeProvider().name).toBe("azure-kv");
  });

  // ── cache hit ─────────────────────────────────────────────────

  describe("cache hit", () => {
    it("calls Key Vault only once for two consecutive getKey calls within TTL", async () => {
      mockGetSecret.mockResolvedValue({ value: PLAINTEXT_HEX });

      const provider = makeProvider();
      const key1 = await provider.getKey("share-master");
      const key2 = await provider.getKey("share-master");

      expect(mockGetSecret).toHaveBeenCalledTimes(1);
      expect(key1).toEqual(PLAINTEXT_KEY);
      expect(key2).toEqual(PLAINTEXT_KEY);
    });
  });

  // ── cache expiry ──────────────────────────────────────────────

  describe("cache expiry", () => {
    it("calls Key Vault again after TTL expires", async () => {
      vi.useFakeTimers();
      mockGetSecret.mockResolvedValue({ value: PLAINTEXT_HEX });

      const provider = makeProvider(1000);
      await provider.getKey("share-master");

      vi.advanceTimersByTime(1001);
      await provider.getKey("share-master");

      expect(mockGetSecret).toHaveBeenCalledTimes(2);
    });
  });

  // ── max stale TTL ─────────────────────────────────────────────

  describe("max stale TTL", () => {
    it("returns stale cached key when KV fails and within maxStaleTtlMs", async () => {
      vi.useFakeTimers();
      mockGetSecret
        .mockResolvedValueOnce({ value: PLAINTEXT_HEX })
        .mockRejectedValueOnce(new Error("KV unavailable"));

      const provider = makeProvider(1000, 3000);
      await provider.getKey("share-master");

      vi.advanceTimersByTime(1500);
      const key = await provider.getKey("share-master");
      expect(key).toEqual(PLAINTEXT_KEY);
    });

    it("throws when KV fails and beyond maxStaleTtlMs", async () => {
      vi.useFakeTimers();
      mockGetSecret
        .mockResolvedValueOnce({ value: PLAINTEXT_HEX })
        .mockRejectedValueOnce(new Error("KV unavailable"));

      const provider = makeProvider(1000, 2000);
      await provider.getKey("share-master");

      vi.advanceTimersByTime(2001);
      await expect(provider.getKey("share-master")).rejects.toThrow("KV unavailable");
    });
  });

  // ── getKeySync ────────────────────────────────────────────────

  describe("getKeySync", () => {
    it("returns cached value when cache is warm", async () => {
      mockGetSecret.mockResolvedValue({ value: PLAINTEXT_HEX });

      const provider = makeProvider();
      await provider.getKey("share-master");
      expect(provider.getKeySync("share-master")).toEqual(PLAINTEXT_KEY);
    });

    it("throws when cache is cold", () => {
      const provider = makeProvider();
      expect(() => provider.getKeySync("share-master")).toThrow("not in cache");
    });
  });

  // ── secret name resolution ────────────────────────────────────

  describe("secret name resolution", () => {
    it("uses default secret name when env var not set", async () => {
      mockGetSecret.mockResolvedValue({ value: PLAINTEXT_HEX });

      const provider = makeProvider();
      await provider.getKey("share-master");

      expect(mockGetSecret).toHaveBeenCalledWith("share-master-key");
    });

    it("uses custom secret name from env var", async () => {
      vi.stubEnv("AZ_KV_SECRET_SHARE_MASTER", "my-custom-key");
      mockGetSecret.mockResolvedValue({ value: PLAINTEXT_HEX });

      const provider = makeProvider();
      await provider.getKey("share-master");

      expect(mockGetSecret).toHaveBeenCalledWith("my-custom-key");
    });

    it("appends version suffix for versioned keys", async () => {
      mockGetSecret.mockResolvedValue({ value: PLAINTEXT_HEX });

      const provider = makeProvider();
      await provider.getKey("share-master", 2);

      expect(mockGetSecret).toHaveBeenCalledWith("share-master-key-v2");
    });

    it("resolves directory-sync key", async () => {
      mockGetSecret.mockResolvedValue({ value: PLAINTEXT_HEX });

      const provider = makeProvider();
      await provider.getKey("directory-sync");

      expect(mockGetSecret).toHaveBeenCalledWith("directory-sync-key");
    });
  });

  // ── hex validation ────────────────────────────────────────────

  describe("hex validation", () => {
    it("throws when secret value is not valid hex64", async () => {
      mockGetSecret.mockResolvedValue({ value: "not-a-hex-key" });

      const provider = makeProvider();
      await expect(provider.getKey("share-master")).rejects.toThrow(
        "not a valid 64-char hex string"
      );
    });

    it("throws when secret has no value", async () => {
      mockGetSecret.mockResolvedValue({});

      const provider = makeProvider();
      await expect(provider.getKey("share-master")).rejects.toThrow("has no value");
    });
  });

  // ── validateKeys ──────────────────────────────────────────────

  describe("validateKeys", () => {
    it("warms cache for share-master and all other key types", async () => {
      mockGetSecret.mockResolvedValue({ value: PLAINTEXT_HEX });

      const provider = makeProvider();
      await provider.validateKeys();

      // validateKeys always warms share-master (v1) + verifier-pepper + directory-sync + webauthn-prf
      expect(mockGetSecret).toHaveBeenCalledTimes(4);
      // share-master is fetched with version=1 (SHARE_MASTER_KEY_CURRENT_VERSION default)
      expect(provider.getKeySync("share-master", 1)).toEqual(PLAINTEXT_KEY);
    });

    it("warms all configured key types", async () => {
      vi.stubEnv("AZ_KV_SECRET_VERIFIER_PEPPER", "my-pepper");
      vi.stubEnv("AZ_KV_SECRET_DIRECTORY_SYNC", "my-dir-sync");
      vi.stubEnv("AZ_KV_SECRET_WEBAUTHN_PRF", "my-prf");
      mockGetSecret.mockResolvedValue({ value: PLAINTEXT_HEX });

      const provider = makeProvider();
      await provider.validateKeys();

      expect(mockGetSecret).toHaveBeenCalledTimes(4);
    });

    it("throws when AZURE_KV_URL is empty", async () => {
      const provider = new AzureKvKeyProvider({ vaultUrl: "" });
      await expect(provider.validateKeys()).rejects.toThrow("AZURE_KV_URL is required");
    });
  });

  // ── module loader failure ───────────────────────────────────

  describe("module loader failure", () => {
    it("throws descriptive error when Azure SDK is unavailable", async () => {
      _setAzureKvModuleLoader(async () => {
        throw new Error("Cannot find module '@azure/keyvault-secrets'");
      });

      const provider = makeProvider();
      await expect(provider.getKey("share-master")).rejects.toThrow(
        "@azure/keyvault-secrets and @azure/identity are required"
      );
    });
  });
});
