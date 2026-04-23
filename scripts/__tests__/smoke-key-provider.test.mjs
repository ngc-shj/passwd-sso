/**
 * Smoke test: verifies key provider + error tracking code paths end-to-end.
 */
import { describe, it, expect, beforeEach } from "vitest";

process.env.SHARE_MASTER_KEY = "a".repeat(64);
process.env.VERIFIER_PEPPER_KEY = "b".repeat(64);
process.env.WEBAUTHN_PRF_SECRET = "c".repeat(64);
process.env.DIRECTORY_SYNC_MASTER_KEY = "d".repeat(64);

const { getKeyProvider, getKeyProviderSync, _resetKeyProvider } = await import("../../src/lib/key-provider/index.ts");
const { sanitizeErrorForSentry } = await import("../../src/lib/security/sentry-sanitize.ts");
const { mapPrismaError } = await import("../../src/lib/prisma/prisma-error.ts");
const { Prisma } = await import("@prisma/client");

describe("smoke: key provider + error tracking", () => {
  beforeEach(() => {
    _resetKeyProvider();
    delete process.env.KEY_PROVIDER;
  });

  it("env provider resolves all 4 key types", async () => {
    const provider = await getKeyProvider();
    await provider.validateKeys();
    expect(provider.name).toBe("env");

    const p = getKeyProviderSync();
    for (const k of ["share-master", "verifier-pepper", "directory-sync", "webauthn-prf"]) {
      const buf = p.getKeySync(k);
      expect(buf).toBeInstanceOf(Buffer);
      expect(buf.length).toBe(32);
    }
  });

  it("unknown KEY_PROVIDER gives clear error", async () => {
    process.env.KEY_PROVIDER = "unknown";
    await expect(getKeyProvider()).rejects.toThrow('Unknown KEY_PROVIDER: "unknown"');
  });

  it("aws-sm without SDK gives install instructions", async () => {
    process.env.KEY_PROVIDER = "aws-sm";
    process.env.AWS_REGION = "ap-northeast-1";
    const p = await getKeyProvider();
    await expect(p.validateKeys()).rejects.toThrow("@aws-sdk/client-secrets-manager is required");
  });

  it("azure-kv without SDK gives install instructions", async () => {
    process.env.KEY_PROVIDER = "azure-kv";
    process.env.AZURE_KV_URL = "https://test.vault.azure.net";
    const p = await getKeyProvider();
    await expect(p.validateKeys()).rejects.toThrow("@azure/keyvault-secrets and @azure/identity are required");
  });

  it("gcp-sm without SDK gives install instructions", async () => {
    process.env.KEY_PROVIDER = "gcp-sm";
    process.env.GCP_PROJECT_ID = "test-project";
    const p = await getKeyProvider();
    await expect(p.validateKeys()).rejects.toThrow("@google-cloud/secret-manager is required");
  });

  it("sanitizeErrorForSentry scrubs hex64 from message and stack", () => {
    const key = "a".repeat(64);
    const err = new Error("Failed with key: " + key);
    const sanitized = sanitizeErrorForSentry(err);
    expect(sanitized.message).not.toContain(key);
    expect(sanitized.message).toContain("[redacted-key]");
    expect(sanitized.stack).not.toContain(key);
  });

  it("mapPrismaError maps P2002 to 409 CONFLICT", () => {
    const err = new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "5" });
    expect(mapPrismaError(err)).toEqual({ status: 409, code: "CONFLICT" });
  });

  it("mapPrismaError maps P2025 to 404 NOT_FOUND", () => {
    const err = new Prisma.PrismaClientKnownRequestError("not found", { code: "P2025", clientVersion: "5" });
    expect(mapPrismaError(err)).toEqual({ status: 404, code: "NOT_FOUND" });
  });
});
