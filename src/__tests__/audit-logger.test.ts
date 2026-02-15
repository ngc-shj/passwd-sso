import { describe, it, expect, vi, beforeEach } from "vitest";
import { Writable } from "node:stream";

/** Helper: create a Writable stream that collects chunks as strings. */
function createSink() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { chunks, stream };
}

describe("createAuditLogger", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("is disabled when AUDIT_LOG_FORWARD is not set", async () => {
    delete process.env.AUDIT_LOG_FORWARD;
    const { createAuditLogger } = await import("@/lib/audit-logger");
    const logger = createAuditLogger();
    expect(logger.isLevelEnabled("info")).toBe(false);
  });

  it("is disabled when AUDIT_LOG_FORWARD is 'false'", async () => {
    process.env.AUDIT_LOG_FORWARD = "false";
    const { createAuditLogger } = await import("@/lib/audit-logger");
    const logger = createAuditLogger();
    expect(logger.isLevelEnabled("info")).toBe(false);
  });

  it("is enabled when AUDIT_LOG_FORWARD is 'true'", async () => {
    const { createAuditLogger } = await import("@/lib/audit-logger");
    const logger = createAuditLogger({ enabled: true });
    expect(logger.isLevelEnabled("info")).toBe(true);
  });

  it("does not write to sink when disabled", async () => {
    const { createAuditLogger } = await import("@/lib/audit-logger");
    const { chunks, stream } = createSink();

    const logger = createAuditLogger({ enabled: false, destination: stream });
    logger.info({ audit: { action: "TEST" } }, "test");
    logger.flush();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(chunks).toHaveLength(0);
  });

  it("writes to sink when enabled", async () => {
    const { createAuditLogger } = await import("@/lib/audit-logger");
    const { chunks, stream } = createSink();

    const logger = createAuditLogger({ enabled: true, destination: stream });
    logger.info({ audit: { action: "TEST" } }, "test.msg");
    logger.flush();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(chunks.length).toBeGreaterThan(0);
  });

  it("includes _logType, _app, _version in base fields", async () => {
    const { createAuditLogger } = await import("@/lib/audit-logger");
    const { chunks, stream } = createSink();

    const logger = createAuditLogger({
      enabled: true,
      appName: "test-app",
      destination: stream,
    });

    logger.info({ audit: { action: "TEST" } }, "test.msg");
    logger.flush();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(chunks.length).toBeGreaterThan(0);
    const record = JSON.parse(chunks[0]);
    expect(record._logType).toBe("audit");
    expect(record._app).toBe("test-app");
    expect(record._version).toBe("1");
    expect(record.name).toBe("test-app");
    expect(record.level).toBe("info");
    expect(record.msg).toBe("test.msg");
  });

  it("redacts sensitive fields in audit.metadata", async () => {
    const { createAuditLogger } = await import("@/lib/audit-logger");
    const { chunks, stream } = createSink();

    const logger = createAuditLogger({ enabled: true, destination: stream });

    logger.info(
      {
        audit: {
          metadata: {
            password: "super-secret",
            passphrase: "my-passphrase",
            token: "bearer-xyz",
            secretKey: "key-material",
            encryptedBlob: "blob-data",
            accessToken: "access-123",
            filename: "export.csv",
            count: 42,
          },
        },
      },
      "audit.TEST",
    );
    logger.flush();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(chunks.length).toBeGreaterThan(0);
    const record = JSON.parse(chunks[0]);
    expect(record.audit.metadata.password).toBe("[REDACTED]");
    expect(record.audit.metadata.passphrase).toBe("[REDACTED]");
    expect(record.audit.metadata.token).toBe("[REDACTED]");
    expect(record.audit.metadata.secretKey).toBe("[REDACTED]");
    expect(record.audit.metadata.encryptedBlob).toBe("[REDACTED]");
    expect(record.audit.metadata.accessToken).toBe("[REDACTED]");
    // Non-sensitive fields pass through
    expect(record.audit.metadata.filename).toBe("export.csv");
    expect(record.audit.metadata.count).toBe(42);
  });

  it("uses custom appName when provided", async () => {
    const { createAuditLogger } = await import("@/lib/audit-logger");
    const { chunks, stream } = createSink();

    const logger = createAuditLogger({
      enabled: true,
      appName: "my-custom-app",
      destination: stream,
    });

    logger.info({ audit: { action: "TEST" } }, "test");
    logger.flush();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(chunks.length).toBeGreaterThan(0);
    const record = JSON.parse(chunks[0]);
    expect(record.name).toBe("my-custom-app");
    expect(record._app).toBe("my-custom-app");
  });
});

describe("METADATA_BLOCKLIST", () => {
  it("contains expected sensitive keys", async () => {
    const { METADATA_BLOCKLIST } = await import("@/lib/audit-logger");

    const expectedKeys = [
      "password",
      "passphrase",
      "secret",
      "secretKey",
      "encryptedBlob",
      "encryptedOverview",
      "encryptedData",
      "encryptedSecretKey",
      "encryptedOrgKey",
      "masterPasswordServerHash",
      "token",
      "tokenHash",
      "accessToken",
      "refreshToken",
      "idToken",
      "accountSalt",
      "passphraseVerifierHmac",
    ];

    for (const key of expectedKeys) {
      expect(METADATA_BLOCKLIST.has(key)).toBe(true);
    }
  });

  it("does not contain normal audit fields", async () => {
    const { METADATA_BLOCKLIST } = await import("@/lib/audit-logger");

    const safeKeys = [
      "filename",
      "format",
      "count",
      "entryCount",
      "previousRole",
      "newRole",
      "granteeEmail",
      "waitDays",
    ];

    for (const key of safeKeys) {
      expect(METADATA_BLOCKLIST.has(key)).toBe(false);
    }
  });
});
