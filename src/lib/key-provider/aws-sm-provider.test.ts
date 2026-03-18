import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  AwsSmKeyProvider,
  _resetAwsSmModuleCache,
  _setAwsSmModuleLoader,
} from "./aws-sm-provider";

const PLAINTEXT_HEX = "a".repeat(64);
const PLAINTEXT_KEY = Buffer.from(PLAINTEXT_HEX, "hex");

const mockSend = vi.fn();

function makeProvider(ttlMs = 300_000, maxStaleTtlMs?: number) {
  return new AwsSmKeyProvider({ region: "us-east-1", ttlMs, maxStaleTtlMs });
}

describe("AwsSmKeyProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    _resetAwsSmModuleCache();
    _setAwsSmModuleLoader(async () => ({
      SecretsManagerClient: class {
        send = mockSend;
      },
      GetSecretValueCommand: class {
        input: unknown;
        constructor(input: unknown) { this.input = input; }
      },
    }));
  });

  it("has name 'aws-sm'", () => {
    expect(makeProvider().name).toBe("aws-sm");
  });

  // ── cache hit ─────────────────────────────────────────────────

  describe("cache hit", () => {
    it("calls Secrets Manager only once for two consecutive getKey calls within TTL", async () => {
      mockSend.mockResolvedValue({ SecretString: PLAINTEXT_HEX });

      const provider = makeProvider();
      const key1 = await provider.getKey("share-master");
      const key2 = await provider.getKey("share-master");

      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(key1).toEqual(PLAINTEXT_KEY);
      expect(key2).toEqual(PLAINTEXT_KEY);
    });
  });

  // ── cache expiry ──────────────────────────────────────────────

  describe("cache expiry", () => {
    it("calls Secrets Manager again after TTL expires", async () => {
      vi.useFakeTimers();
      mockSend.mockResolvedValue({ SecretString: PLAINTEXT_HEX });

      const provider = makeProvider(1000);
      await provider.getKey("share-master");

      vi.advanceTimersByTime(1001);
      await provider.getKey("share-master");

      expect(mockSend).toHaveBeenCalledTimes(2);
    });
  });

  // ── max stale TTL ─────────────────────────────────────────────

  describe("max stale TTL", () => {
    it("returns stale cached key when SM fails and within maxStaleTtlMs", async () => {
      vi.useFakeTimers();
      mockSend
        .mockResolvedValueOnce({ SecretString: PLAINTEXT_HEX })
        .mockRejectedValueOnce(new Error("SM unavailable"));

      const provider = makeProvider(1000, 3000);
      await provider.getKey("share-master");

      vi.advanceTimersByTime(1500);
      const key = await provider.getKey("share-master");
      expect(key).toEqual(PLAINTEXT_KEY);
    });

    it("throws when SM fails and beyond maxStaleTtlMs", async () => {
      vi.useFakeTimers();
      mockSend
        .mockResolvedValueOnce({ SecretString: PLAINTEXT_HEX })
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
      mockSend.mockResolvedValue({ SecretString: PLAINTEXT_HEX });

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
    it("uses default secret name with passwd-sso prefix", async () => {
      mockSend.mockResolvedValue({ SecretString: PLAINTEXT_HEX });

      const provider = makeProvider();
      await provider.getKey("share-master");

      const cmd = mockSend.mock.calls[0][0];
      expect(cmd.input).toEqual({ SecretId: "passwd-sso/share-master-key" });
    });

    it("uses custom secret name from env var", async () => {
      vi.stubEnv("AWS_SM_SECRET_SHARE_MASTER", "my-custom-key");
      mockSend.mockResolvedValue({ SecretString: PLAINTEXT_HEX });

      const provider = makeProvider();
      await provider.getKey("share-master");

      const cmd = mockSend.mock.calls[0][0];
      expect(cmd.input).toEqual({ SecretId: "my-custom-key" });
    });

    it("appends version suffix for versioned keys", async () => {
      mockSend.mockResolvedValue({ SecretString: PLAINTEXT_HEX });

      const provider = makeProvider();
      await provider.getKey("share-master", 2);

      const cmd = mockSend.mock.calls[0][0];
      expect(cmd.input).toEqual({ SecretId: "passwd-sso/share-master-key-v2" });
    });

    it("resolves directory-sync key", async () => {
      mockSend.mockResolvedValue({ SecretString: PLAINTEXT_HEX });

      const provider = makeProvider();
      await provider.getKey("directory-sync");

      const cmd = mockSend.mock.calls[0][0];
      expect(cmd.input).toEqual({ SecretId: "passwd-sso/directory-sync-key" });
    });
  });

  // ── hex validation ────────────────────────────────────────────

  describe("hex validation", () => {
    it("throws when secret value is not valid hex64", async () => {
      mockSend.mockResolvedValue({ SecretString: "not-hex" });

      const provider = makeProvider();
      await expect(provider.getKey("share-master")).rejects.toThrow(
        "not a valid 64-char hex string"
      );
    });

    it("throws when secret has no SecretString", async () => {
      mockSend.mockResolvedValue({});

      const provider = makeProvider();
      await expect(provider.getKey("share-master")).rejects.toThrow("has no SecretString");
    });
  });

  // ── validateKeys ──────────────────────────────────────────────

  describe("validateKeys", () => {
    it("warms cache for share-master", async () => {
      mockSend.mockResolvedValue({ SecretString: PLAINTEXT_HEX });

      const provider = makeProvider();
      await provider.validateKeys();

      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(provider.getKeySync("share-master")).toEqual(PLAINTEXT_KEY);
    });

    it("warms all configured key types", async () => {
      vi.stubEnv("AWS_SM_SECRET_VERIFIER_PEPPER", "my-pepper");
      vi.stubEnv("AWS_SM_SECRET_DIRECTORY_SYNC", "my-dir-sync");
      vi.stubEnv("AWS_SM_SECRET_WEBAUTHN_PRF", "my-prf");
      mockSend.mockResolvedValue({ SecretString: PLAINTEXT_HEX });

      const provider = makeProvider();
      await provider.validateKeys();

      expect(mockSend).toHaveBeenCalledTimes(4);
    });

    it("throws when AWS_REGION is empty", async () => {
      const provider = new AwsSmKeyProvider({ region: "" });
      await expect(provider.validateKeys()).rejects.toThrow("AWS_REGION is required");
    });
  });

  // ── module loader failure ───────────────────────────────────

  describe("module loader failure", () => {
    it("throws descriptive error when AWS SDK is unavailable", async () => {
      _setAwsSmModuleLoader(async () => {
        throw new Error("Cannot find module");
      });

      const provider = makeProvider();
      await expect(provider.getKey("share-master")).rejects.toThrow(
        "@aws-sdk/client-secrets-manager is required for KEY_PROVIDER=aws-sm"
      );
    });
  });

  // ── client reuse ──────────────────────────────────────────────

  it("reuses Secrets Manager client across calls", async () => {
    mockSend.mockResolvedValue({ SecretString: PLAINTEXT_HEX });

    const provider = makeProvider();
    await provider.getKey("share-master");
    await provider.getKey("verifier-pepper");

    expect(mockSend).toHaveBeenCalledTimes(2);
  });
});
