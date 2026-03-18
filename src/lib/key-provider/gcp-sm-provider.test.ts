import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  GcpSmKeyProvider,
  _resetGcpSmModuleCache,
  _setGcpSmModuleLoader,
} from "./gcp-sm-provider";

const PLAINTEXT_HEX = "a".repeat(64);
const PLAINTEXT_KEY = Buffer.from(PLAINTEXT_HEX, "hex");

const mockAccessSecretVersion = vi.fn();

function makeProvider(ttlMs = 300_000, maxStaleTtlMs?: number) {
  return new GcpSmKeyProvider({
    projectId: "test-project",
    ttlMs,
    maxStaleTtlMs,
  });
}

function mockSecretResponse(hex: string) {
  return [{ payload: { data: Buffer.from(hex) } }];
}

describe("GcpSmKeyProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    _resetGcpSmModuleCache();
    _setGcpSmModuleLoader(async () => ({
      SecretManagerServiceClient: class {
        accessSecretVersion = mockAccessSecretVersion;
      },
    }));
  });

  it("has name 'gcp-sm'", () => {
    expect(makeProvider().name).toBe("gcp-sm");
  });

  // ── cache hit ─────────────────────────────────────────────────

  describe("cache hit", () => {
    it("calls Secret Manager only once for two consecutive getKey calls within TTL", async () => {
      mockAccessSecretVersion.mockResolvedValue(mockSecretResponse(PLAINTEXT_HEX));

      const provider = makeProvider();
      const key1 = await provider.getKey("share-master");
      const key2 = await provider.getKey("share-master");

      expect(mockAccessSecretVersion).toHaveBeenCalledTimes(1);
      expect(key1).toEqual(PLAINTEXT_KEY);
      expect(key2).toEqual(PLAINTEXT_KEY);
    });
  });

  // ── cache expiry ──────────────────────────────────────────────

  describe("cache expiry", () => {
    it("calls Secret Manager again after TTL expires", async () => {
      vi.useFakeTimers();
      mockAccessSecretVersion.mockResolvedValue(mockSecretResponse(PLAINTEXT_HEX));

      const provider = makeProvider(1000);
      await provider.getKey("share-master");

      vi.advanceTimersByTime(1001);
      await provider.getKey("share-master");

      expect(mockAccessSecretVersion).toHaveBeenCalledTimes(2);
    });
  });

  // ── max stale TTL ─────────────────────────────────────────────

  describe("max stale TTL", () => {
    it("returns stale cached key when SM fails and within maxStaleTtlMs", async () => {
      vi.useFakeTimers();
      mockAccessSecretVersion
        .mockResolvedValueOnce(mockSecretResponse(PLAINTEXT_HEX))
        .mockRejectedValueOnce(new Error("SM unavailable"));

      const provider = makeProvider(1000, 3000);
      await provider.getKey("share-master");

      vi.advanceTimersByTime(1500);
      const key = await provider.getKey("share-master");
      expect(key).toEqual(PLAINTEXT_KEY);
    });

    it("throws when SM fails and beyond maxStaleTtlMs", async () => {
      vi.useFakeTimers();
      mockAccessSecretVersion
        .mockResolvedValueOnce(mockSecretResponse(PLAINTEXT_HEX))
        .mockRejectedValueOnce(new Error("SM unavailable"));

      const provider = makeProvider(1000, 2000);
      await provider.getKey("share-master");

      vi.advanceTimersByTime(2001);
      await expect(provider.getKey("share-master")).rejects.toThrow("SM unavailable");
    });
  });

  // ── getKeySync ────────────────────────────────────────────────

  describe("getKeySync", () => {
    it("returns cached value when cache is warm", async () => {
      mockAccessSecretVersion.mockResolvedValue(mockSecretResponse(PLAINTEXT_HEX));

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
    it("uses default secret name and correct resource path", async () => {
      mockAccessSecretVersion.mockResolvedValue(mockSecretResponse(PLAINTEXT_HEX));

      const provider = makeProvider();
      await provider.getKey("share-master");

      expect(mockAccessSecretVersion).toHaveBeenCalledWith({
        name: "projects/test-project/secrets/share-master-key/versions/latest",
      });
    });

    it("uses custom secret name from env var", async () => {
      vi.stubEnv("SM_SECRET_SHARE_MASTER", "my-custom-key");
      mockAccessSecretVersion.mockResolvedValue(mockSecretResponse(PLAINTEXT_HEX));

      const provider = makeProvider();
      await provider.getKey("share-master");

      expect(mockAccessSecretVersion).toHaveBeenCalledWith({
        name: "projects/test-project/secrets/my-custom-key/versions/latest",
      });
    });

    it("appends version suffix for versioned keys", async () => {
      mockAccessSecretVersion.mockResolvedValue(mockSecretResponse(PLAINTEXT_HEX));

      const provider = makeProvider();
      await provider.getKey("share-master", 2);

      expect(mockAccessSecretVersion).toHaveBeenCalledWith({
        name: "projects/test-project/secrets/share-master-key-v2/versions/latest",
      });
    });

    it("resolves directory-sync key", async () => {
      mockAccessSecretVersion.mockResolvedValue(mockSecretResponse(PLAINTEXT_HEX));

      const provider = makeProvider();
      await provider.getKey("directory-sync");

      expect(mockAccessSecretVersion).toHaveBeenCalledWith({
        name: "projects/test-project/secrets/directory-sync-key/versions/latest",
      });
    });
  });

  // ── hex validation ────────────────────────────────────────────

  describe("hex validation", () => {
    it("throws when secret value is not valid hex64", async () => {
      mockAccessSecretVersion.mockResolvedValue(mockSecretResponse("not-hex"));

      const provider = makeProvider();
      await expect(provider.getKey("share-master")).rejects.toThrow(
        "not a valid 64-char hex string"
      );
    });

    it("throws when secret has no payload data", async () => {
      mockAccessSecretVersion.mockResolvedValue([{ payload: {} }]);

      const provider = makeProvider();
      await expect(provider.getKey("share-master")).rejects.toThrow("has no payload data");
    });
  });

  // ── validateKeys ──────────────────────────────────────────────

  describe("validateKeys", () => {
    it("warms cache for share-master", async () => {
      mockAccessSecretVersion.mockResolvedValue(mockSecretResponse(PLAINTEXT_HEX));

      const provider = makeProvider();
      await provider.validateKeys();

      expect(mockAccessSecretVersion).toHaveBeenCalledTimes(1);
      expect(provider.getKeySync("share-master")).toEqual(PLAINTEXT_KEY);
    });

    it("warms all configured key types", async () => {
      vi.stubEnv("SM_SECRET_VERIFIER_PEPPER", "my-pepper");
      vi.stubEnv("SM_SECRET_DIRECTORY_SYNC", "my-dir-sync");
      vi.stubEnv("SM_SECRET_WEBAUTHN_PRF", "my-prf");
      mockAccessSecretVersion.mockResolvedValue(mockSecretResponse(PLAINTEXT_HEX));

      const provider = makeProvider();
      await provider.validateKeys();

      expect(mockAccessSecretVersion).toHaveBeenCalledTimes(4);
    });

    it("throws when GCP_PROJECT_ID is empty", async () => {
      const provider = new GcpSmKeyProvider({ projectId: "" });
      await expect(provider.validateKeys()).rejects.toThrow("GCP_PROJECT_ID is required");
    });
  });

  // ── module loader failure ───────────────────────────────────

  describe("module loader failure", () => {
    it("throws descriptive error when GCP SDK is unavailable", async () => {
      _setGcpSmModuleLoader(async () => {
        throw new Error("Cannot find module '@google-cloud/secret-manager'");
      });

      const provider = makeProvider();
      await expect(provider.getKey("share-master")).rejects.toThrow(
        "@google-cloud/secret-manager is required for KEY_PROVIDER=gcp-sm"
      );
    });
  });
});
