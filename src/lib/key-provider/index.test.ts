import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getKeyProvider,
  getKeyProviderSync,
  _resetKeyProvider,
} from "./index";

// Mock provider modules so we don't need real keys
vi.mock("./env-provider", () => {
  class EnvKeyProvider {
    name = "env";
    getKey = vi.fn();
    getKeySync = vi.fn();
    validateKeys = vi.fn();
  }
  return { EnvKeyProvider };
});

vi.mock("./aws-sm-provider", () => {
  class AwsSmKeyProvider {
    name = "aws-sm";
    getKey = vi.fn();
    getKeySync = vi.fn();
    validateKeys = vi.fn();
    constructor(public config: unknown) {}
  }
  return { AwsSmKeyProvider };
});

describe("key-provider index", () => {
  beforeEach(() => {
    _resetKeyProvider();
    vi.unstubAllEnvs();
  });

  // ── provider selection ────────────────────────────────────────

  describe("getKeyProvider", () => {
    it("selects EnvKeyProvider by default (no KEY_PROVIDER set)", async () => {
      // Do not stub KEY_PROVIDER — rely on it being absent from process.env
      // (vi.unstubAllEnvs in beforeEach removes any previously stubbed values)
      delete process.env.KEY_PROVIDER;
      const provider = await getKeyProvider();
      expect(provider.name).toBe("env");
    });

    it("selects EnvKeyProvider when KEY_PROVIDER=env", async () => {
      vi.stubEnv("KEY_PROVIDER", "env");
      const provider = await getKeyProvider();
      expect(provider.name).toBe("env");
    });

    it("selects AwsSmKeyProvider when KEY_PROVIDER=aws-sm", async () => {
      vi.stubEnv("KEY_PROVIDER", "aws-sm");
      vi.stubEnv("AWS_REGION", "us-east-1");
      const provider = await getKeyProvider();
      expect(provider.name).toBe("aws-sm");
    });

    it("throws for unknown KEY_PROVIDER value", async () => {
      vi.stubEnv("KEY_PROVIDER", "gcp-kms");
      await expect(getKeyProvider()).rejects.toThrow("Unknown KEY_PROVIDER: \"gcp-kms\"");
    });

    it("returns same singleton on repeated calls", async () => {
      vi.stubEnv("KEY_PROVIDER", "env");
      const p1 = await getKeyProvider();
      const p2 = await getKeyProvider();
      expect(p1).toBe(p2);
    });

    it("passes SM_CACHE_TTL_MS to AwsSmKeyProvider when set", async () => {
      vi.stubEnv("KEY_PROVIDER", "aws-sm");
      vi.stubEnv("AWS_REGION", "eu-west-1");
      vi.stubEnv("SM_CACHE_TTL_MS", "60000");

      const provider = await getKeyProvider() as { config?: unknown };
      expect(provider.name).toBe("aws-sm");
      expect((provider as { config?: { ttlMs?: number } }).config).toMatchObject({
        ttlMs: 60000,
      });
    });
  });

  // ── getKeyProviderSync ────────────────────────────────────────

  describe("getKeyProviderSync", () => {
    it("throws when called before getKeyProvider", () => {
      expect(() => getKeyProviderSync()).toThrow(
        "KeyProvider not initialized. Call getKeyProvider() at startup."
      );
    });

    it("returns provider after getKeyProvider has been called", async () => {
      vi.stubEnv("KEY_PROVIDER", "env");
      const p = await getKeyProvider();
      expect(getKeyProviderSync()).toBe(p);
    });
  });

  // ── _resetKeyProvider ─────────────────────────────────────────

  describe("_resetKeyProvider", () => {
    it("clears singleton so next getKeyProvider creates a new instance", async () => {
      vi.stubEnv("KEY_PROVIDER", "env");
      const p1 = await getKeyProvider();
      _resetKeyProvider();
      const p2 = await getKeyProvider();
      // Both are EnvKeyProvider instances, but they should be different objects
      expect(p1).not.toBe(p2);
    });

    it("causes getKeyProviderSync to throw after reset", async () => {
      vi.stubEnv("KEY_PROVIDER", "env");
      await getKeyProvider();
      _resetKeyProvider();
      expect(() => getKeyProviderSync()).toThrow(
        "KeyProvider not initialized"
      );
    });
  });
});
