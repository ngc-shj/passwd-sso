import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetKeyProvider } from "@/lib/key-provider";
import { getMasterKeyByVersion } from "@/lib/crypto/crypto-server";
import { encryptWithKey } from "@/lib/crypto/envelope";
import {
  KEY_WARM_STATUS,
  collectEnvelopeVersions,
  warmShareMasterKeys,
} from "../lib/share-master-keys";
import { prepareMigration } from "../migrate-account-tokens-to-encrypted";

// Stateful stand-in for the cloud provider: getKey fills a cache, getKeySync
// serves only what getKey fetched, like the real base-cloud-provider.
const fake = vi.hoisted(() => ({ rejectVersions: new Set<number>(), calls: [] as number[] }));

vi.mock("@/lib/key-provider/aws-sm-provider", () => {
  class AwsSmKeyProvider {
    name = "aws-sm";
    private cache = new Map<number, Buffer>();
    constructor(public config: unknown) {}
    async getKey(_name: string, version: number): Promise<Buffer> {
      fake.calls.push(version);
      if (fake.rejectVersions.has(version)) {
        throw new Error("secret arn:aws:secretsmanager:eu-west-1:123:secret:leak not found");
      }
      const key = Buffer.alloc(32, version);
      this.cache.set(version, key);
      return key;
    }
    getKeySync(_name: string, version: number): Buffer {
      const key = this.cache.get(version);
      if (!key) throw new Error(`key ${version} not loaded`);
      return key;
    }
    async validateKeys() {}
  }
  return { AwsSmKeyProvider };
});

const CURRENT = 2;

beforeEach(() => {
  _resetKeyProvider();
  fake.rejectVersions.clear();
  fake.calls.length = 0;
  vi.stubEnv("KEY_PROVIDER", "aws-sm");
  vi.stubEnv("AWS_REGION", "eu-west-1");
  vi.stubEnv("SHARE_MASTER_KEY_CURRENT_VERSION", String(CURRENT));
});

afterEach(() => {
  _resetKeyProvider();
  vi.unstubAllEnvs();
});

describe("warmShareMasterKeys", () => {
  it("makes getMasterKeyByVersion serve the requested and the current version", async () => {
    // Negative control: without warming, the production reader cannot serve the key.
    expect(() => getMasterKeyByVersion(1)).toThrow();
    _resetKeyProvider();

    const report = await warmShareMasterKeys([1]);

    expect(report.get(1)).toBe(KEY_WARM_STATUS.OK);
    expect(report.get(CURRENT)).toBe(KEY_WARM_STATUS.OK);
    expect(getMasterKeyByVersion(1)).toEqual(Buffer.alloc(32, 1));
    expect(getMasterKeyByVersion(CURRENT)).toEqual(Buffer.alloc(32, CURRENT));
  });

  it("reports a rejecting version as unavailable while the others stay ok", async () => {
    fake.rejectVersions.add(1);

    const report = await warmShareMasterKeys([1, 3]);

    expect(report.get(1)).toBe(KEY_WARM_STATUS.UNAVAILABLE);
    expect(report.get(3)).toBe(KEY_WARM_STATUS.OK);
    expect(report.get(CURRENT)).toBe(KEY_WARM_STATUS.OK);
    expect(() => getMasterKeyByVersion(1)).toThrow();
    expect(getMasterKeyByVersion(3)).toEqual(Buffer.alloc(32, 3));
  });

  it("fetches each version once, in ascending order, including the current one", async () => {
    await warmShareMasterKeys([3, 1, 3]);
    expect(fake.calls).toEqual([1, 2, 3]);
  });
});

describe("collectEnvelopeVersions", () => {
  const key = Buffer.alloc(32, 7);
  const aad = Buffer.from("aad");

  it("collects versions from real envelopes", () => {
    const values = [encryptWithKey("a", 1, key, aad), encryptWithKey("b", 4, key, aad), encryptWithKey("c", 4, key, aad)];
    expect(collectEnvelopeVersions(values)).toEqual(new Set([1, 4]));
  });

  it("skips null and undefined", () => {
    expect(collectEnvelopeVersions([null, undefined])).toEqual(new Set());
  });

  it("skips a value without the envelope prefix", () => {
    expect(collectEnvelopeVersions(["plain-token", "2:abcd"])).toEqual(new Set());
  });

  it.each(["psoenc1:nocolon", "psoenc1:x:AAAA", "psoenc1:3:AA"])("skips the malformed envelope %j", (value) => {
    expect(collectEnvelopeVersions([value])).toEqual(new Set());
  });

  it("skips a well-formed body behind the wrong prefix", () => {
    const real = encryptWithKey("a", 5, key, aad);
    expect(collectEnvelopeVersions([real.replace("psoenc1:", "xxxxxxx:")])).toEqual(new Set());
  });

  it("keeps the valid versions beside skipped values", () => {
    const good = encryptWithKey("a", 5, key, aad);
    expect(collectEnvelopeVersions([null, "plain", "psoenc1:bad", good])).toEqual(new Set([5]));
  });
});

describe("prepareMigration", () => {
  it("warms the current version so the production reader serves it", async () => {
    // Negative control: before preparing, the current version is not served.
    expect(() => getMasterKeyByVersion(CURRENT)).toThrow();
    _resetKeyProvider();

    await expect(prepareMigration()).resolves.toBeUndefined();

    expect(getMasterKeyByVersion(CURRENT)).toEqual(Buffer.alloc(32, CURRENT));
  });

  it("rejects naming the version, without the provider's error text", async () => {
    fake.rejectVersions.add(CURRENT);

    const err = await prepareMigration().then(
      () => null,
      (e: Error) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain(`version ${CURRENT}`);
    expect(err!.message).not.toMatch(/arn:|secretsmanager|leak/);
  });
});
