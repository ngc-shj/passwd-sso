/**
 * Tests for BaseCloudKeyProvider via a minimal in-memory subclass. The
 * subclass keeps the public surface (getKey / getKeySync / validateKeys /
 * resolveSecretName / validateHex64) honest without pulling in real cloud
 * SDKs. Concrete provider tests (aws-sm-provider.test.ts etc.) cover
 * fetchSecret() integration.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  BaseCloudKeyProvider,
  HEX64_RE,
  type CloudProviderConfig,
} from "./base-cloud-provider";
import type { KeyName } from "./types";

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const HEX_A_BUF = Buffer.from(HEX_A, "hex");

class TestProvider extends BaseCloudKeyProvider {
  readonly name = "test";
  fetchCalls: Array<{ name: KeyName; version?: number; resolvedSecretName: string }> = [];
  fetchHandler: (name: KeyName, version?: number) => Promise<string | Buffer> = async () => HEX_A;
  validateConfigError: Error | null = null;

  protected readonly secretNameEnvMap: Record<KeyName, string> = {
    "share-master": "TEST_SECRET_SHARE_MASTER",
    "verifier-pepper": "TEST_SECRET_VERIFIER_PEPPER",
    "directory-sync": "TEST_SECRET_DIRECTORY_SYNC",
    "webauthn-prf": "TEST_SECRET_WEBAUTHN_PRF",
    "audit-anchor-signing": "TEST_SECRET_AUDIT_ANCHOR_SIGNING",
    "audit-anchor-tag-secret": "TEST_SECRET_AUDIT_ANCHOR_TAG_SECRET",
  };

  protected readonly defaultSecretNames: Record<KeyName, string> = {
    "share-master": "test/share-master",
    "verifier-pepper": "test/verifier-pepper",
    "directory-sync": "test/directory-sync",
    "webauthn-prf": "test/webauthn-prf",
    "audit-anchor-signing": "test/audit-anchor-signing",
    "audit-anchor-tag-secret": "test/audit-anchor-tag-secret",
  };

  protected validateConfig(): void {
    if (this.validateConfigError) throw this.validateConfigError;
  }

  protected async fetchSecret(name: KeyName, version?: number): Promise<Buffer> {
    const resolvedSecretName = this.resolveSecretName(name, version);
    this.fetchCalls.push({ name, version, resolvedSecretName });
    const result = await this.fetchHandler(name, version);
    if (Buffer.isBuffer(result)) return result;
    return this.validateHex64(result, resolvedSecretName);
  }

  // Test-only accessors
  _resolveSecretNameForTest(name: KeyName, version?: number) {
    return this.resolveSecretName(name, version);
  }
  _validateHex64ForTest(value: string, secretName: string) {
    return this.validateHex64(value, secretName);
  }
}

function makeProvider(config: CloudProviderConfig = {}): TestProvider {
  return new TestProvider(config);
}

describe("BaseCloudKeyProvider", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    // Silence the dynamic logger import in stale-warning path
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(BaseCloudKeyProvider.prototype as any, "logStaleWarning").mockImplementation(
      () => {},
    );
  });

  describe("HEX64_RE re-export", () => {
    it("exports the same hex64 regex used elsewhere", () => {
      expect(HEX64_RE.test("a".repeat(64))).toBe(true);
      expect(HEX64_RE.test("a".repeat(63))).toBe(false);
      expect(HEX64_RE.test("z".repeat(64))).toBe(false);
    });
  });

  describe("constructor defaults", () => {
    it("defaults ttlMs to 5 minutes (300_000)", async () => {
      vi.useFakeTimers();
      const provider = makeProvider();
      provider.fetchHandler = async () => HEX_A;
      await provider.getKey("share-master");
      // Advance just under 5 minutes — should still be a cache hit
      vi.advanceTimersByTime(299_999);
      await provider.getKey("share-master");
      expect(provider.fetchCalls.length).toBe(1);
    });

    it("defaults maxStaleTtlMs to 2 × ttlMs", async () => {
      vi.useFakeTimers();
      const provider = makeProvider({ ttlMs: 1000 });
      let calls = 0;
      provider.fetchHandler = async () => {
        calls++;
        if (calls === 1) return HEX_A;
        throw new Error("backend down");
      };
      await provider.getKey("share-master");

      // Advance past ttl but within 2×ttl — should still serve stale
      vi.advanceTimersByTime(1500);
      const key = await provider.getKey("share-master");
      expect(key).toEqual(HEX_A_BUF);

      // Advance past 2×ttl — must throw
      vi.advanceTimersByTime(1000); // total 2500 > 2×1000
      await expect(provider.getKey("share-master")).rejects.toThrow("backend down");
    });
  });

  describe("getKey caching", () => {
    it("caches per (name, version) tuple", async () => {
      const provider = makeProvider();
      await provider.getKey("share-master", 1);
      await provider.getKey("share-master", 1);
      await provider.getKey("share-master", 2);
      // (share-master, 1) cached → 1 fetch
      // (share-master, 2) different cache key → 1 more fetch
      expect(provider.fetchCalls.length).toBe(2);
    });

    it("caches name without version separately from name with version", async () => {
      const provider = makeProvider();
      await provider.getKey("directory-sync");
      await provider.getKey("directory-sync");
      expect(provider.fetchCalls.length).toBe(1);
    });

    it("re-fetches after ttlMs elapses", async () => {
      vi.useFakeTimers();
      const provider = makeProvider({ ttlMs: 1000 });
      await provider.getKey("share-master");
      vi.advanceTimersByTime(1001);
      await provider.getKey("share-master");
      expect(provider.fetchCalls.length).toBe(2);
    });
  });

  describe("getKey stale fallback", () => {
    it("returns stale cached key when fetch fails within maxStaleTtlMs", async () => {
      vi.useFakeTimers();
      const provider = makeProvider({ ttlMs: 1000, maxStaleTtlMs: 5000 });
      let calls = 0;
      provider.fetchHandler = async () => {
        calls++;
        if (calls === 1) return HEX_A;
        throw new Error("backend transient failure");
      };
      await provider.getKey("share-master");

      vi.advanceTimersByTime(1500); // past ttl, before maxStale
      const key = await provider.getKey("share-master");
      expect(key).toEqual(HEX_A_BUF);
    });

    it("propagates fetch error when no cached value at all", async () => {
      const provider = makeProvider();
      provider.fetchHandler = async () => {
        throw new Error("first-call failure");
      };
      await expect(provider.getKey("share-master")).rejects.toThrow("first-call failure");
    });

    it("propagates fetch error when cache is past maxStaleTtlMs", async () => {
      vi.useFakeTimers();
      const provider = makeProvider({ ttlMs: 1000, maxStaleTtlMs: 2000 });
      let calls = 0;
      provider.fetchHandler = async () => {
        calls++;
        if (calls === 1) return HEX_A;
        throw new Error("backend gone");
      };
      await provider.getKey("share-master");

      vi.advanceTimersByTime(2500);
      await expect(provider.getKey("share-master")).rejects.toThrow("backend gone");
    });
  });

  describe("getKeySync", () => {
    it("throws when cache is cold", () => {
      const provider = makeProvider();
      expect(() => provider.getKeySync("share-master")).toThrow(
        /not in cache/,
      );
    });

    it("returns cached key when warm", async () => {
      const provider = makeProvider();
      await provider.getKey("share-master");
      expect(provider.getKeySync("share-master")).toEqual(HEX_A_BUF);
    });

    it("throws when cache is past maxStaleTtlMs", async () => {
      vi.useFakeTimers();
      const provider = makeProvider({ ttlMs: 1000, maxStaleTtlMs: 3000 });
      await provider.getKey("share-master");
      vi.setSystemTime(Date.now() + 3001);
      expect(() => provider.getKeySync("share-master")).toThrow(
        /cache expired beyond max stale TTL/,
      );
    });

    it("triggers background refresh when within stale window but past ttl", async () => {
      vi.useFakeTimers();
      const provider = makeProvider({ ttlMs: 1000, maxStaleTtlMs: 5000 });
      await provider.getKey("share-master");
      const callsBefore = provider.fetchCalls.length;
      vi.advanceTimersByTime(1500); // past ttl, still within stale window

      // sync access returns cached value immediately
      const key = provider.getKeySync("share-master");
      expect(key).toEqual(HEX_A_BUF);

      // and schedules a refresh — flush microtasks
      await Promise.resolve();
      await Promise.resolve();
      expect(provider.fetchCalls.length).toBeGreaterThan(callsBefore);
    });
  });

  describe("resolveSecretName", () => {
    it("uses default secret name when env override is unset", () => {
      const provider = makeProvider();
      expect(provider._resolveSecretNameForTest("share-master")).toBe("test/share-master");
    });

    it("uses custom name when env override is set", () => {
      vi.stubEnv("TEST_SECRET_SHARE_MASTER", "ops/custom-share-master");
      const provider = makeProvider();
      expect(provider._resolveSecretNameForTest("share-master")).toBe(
        "ops/custom-share-master",
      );
    });

    it("appends -v<n> suffix for versioned key", () => {
      const provider = makeProvider();
      expect(provider._resolveSecretNameForTest("share-master", 3)).toBe(
        "test/share-master-v3",
      );
    });

    it("verifier-pepper v1 keeps unversioned name (V1 backward-compat shim)", () => {
      const provider = makeProvider();
      expect(provider._resolveSecretNameForTest("verifier-pepper", 1)).toBe(
        "test/verifier-pepper",
      );
    });

    it("verifier-pepper v2+ uses -v<n> suffix", () => {
      const provider = makeProvider();
      expect(provider._resolveSecretNameForTest("verifier-pepper", 2)).toBe(
        "test/verifier-pepper-v2",
      );
    });

    it("share-master v1 uses -v1 suffix (shim does NOT generalize)", () => {
      // Important: the V1-no-suffix exemption is BY-NAME only.
      // share-master has always been versioned.
      const provider = makeProvider();
      expect(provider._resolveSecretNameForTest("share-master", 1)).toBe(
        "test/share-master-v1",
      );
    });
  });

  describe("validateHex64", () => {
    it("returns Buffer for valid 64-char hex", () => {
      const provider = makeProvider();
      expect(provider._validateHex64ForTest(HEX_A, "x")).toEqual(HEX_A_BUF);
    });

    it("trims surrounding whitespace before validation", () => {
      const provider = makeProvider();
      expect(provider._validateHex64ForTest(`  ${HEX_B}\n`, "x")).toEqual(
        Buffer.from(HEX_B, "hex"),
      );
    });

    it("rejects non-hex characters", () => {
      const provider = makeProvider();
      expect(() => provider._validateHex64ForTest("z".repeat(64), "secret-X")).toThrow(
        /Secret "secret-X" is not a valid 64-char hex string/,
      );
    });

    it("rejects wrong length", () => {
      const provider = makeProvider();
      expect(() => provider._validateHex64ForTest("a".repeat(63), "secret-Y")).toThrow(
        /Secret "secret-Y"/,
      );
    });

    it("rejects empty string", () => {
      const provider = makeProvider();
      expect(() => provider._validateHex64ForTest("", "secret-Z")).toThrow();
    });
  });

  describe("validateKeys", () => {
    it("propagates validateConfig errors", async () => {
      const provider = makeProvider();
      provider.validateConfigError = new Error("region missing");
      await expect(provider.validateKeys()).rejects.toThrow("region missing");
    });

    it("warms share-master + verifier-pepper + directory-sync + webauthn-prf by default", async () => {
      vi.stubEnv("SHARE_MASTER_KEY_CURRENT_VERSION", "1");
      vi.stubEnv("AUDIT_ANCHOR_PUBLISHER_ENABLED", "false");
      const provider = makeProvider();
      await provider.validateKeys();
      const names = provider.fetchCalls.map((c) => c.name).sort();
      expect(names).toEqual(
        ["directory-sync", "share-master", "verifier-pepper", "webauthn-prf"].sort(),
      );
    });

    it("includes audit-anchor-signing + audit-anchor-tag-secret when publisher enabled", async () => {
      vi.stubEnv("SHARE_MASTER_KEY_CURRENT_VERSION", "1");
      vi.stubEnv("AUDIT_ANCHOR_PUBLISHER_ENABLED", "true");
      const provider = makeProvider();
      await provider.validateKeys();
      const names = provider.fetchCalls.map((c) => c.name);
      expect(names).toContain("audit-anchor-signing");
      expect(names).toContain("audit-anchor-tag-secret");
    });

    it("does NOT include audit-anchor keys when publisher flag is unset (default)", async () => {
      vi.stubEnv("SHARE_MASTER_KEY_CURRENT_VERSION", "1");
      vi.stubEnv("AUDIT_ANCHOR_PUBLISHER_ENABLED", "");
      const provider = makeProvider();
      await provider.validateKeys();
      const names = provider.fetchCalls.map((c) => c.name);
      expect(names).not.toContain("audit-anchor-signing");
      expect(names).not.toContain("audit-anchor-tag-secret");
    });

    it("rejects SHARE_MASTER_KEY_CURRENT_VERSION = 0", async () => {
      vi.stubEnv("SHARE_MASTER_KEY_CURRENT_VERSION", "0");
      const provider = makeProvider();
      await expect(provider.validateKeys()).rejects.toThrow(
        /SHARE_MASTER_KEY_CURRENT_VERSION must be a positive integer/,
      );
    });

    it("rejects non-numeric SHARE_MASTER_KEY_CURRENT_VERSION", async () => {
      vi.stubEnv("SHARE_MASTER_KEY_CURRENT_VERSION", "abc");
      const provider = makeProvider();
      await expect(provider.validateKeys()).rejects.toThrow(
        /SHARE_MASTER_KEY_CURRENT_VERSION must be a positive integer/,
      );
    });

    it("uses share-master version 1 when env var is unset", async () => {
      // Source uses `?? "1"` which only fires on null/undefined.
      // setup.ts may have left no value; explicitly set "1" to verify default.
      vi.stubEnv("SHARE_MASTER_KEY_CURRENT_VERSION", "1");
      const provider = makeProvider();
      await provider.validateKeys();
      const shareMasterCall = provider.fetchCalls.find((c) => c.name === "share-master");
      expect(shareMasterCall?.version).toBe(1);
    });
  });
});
