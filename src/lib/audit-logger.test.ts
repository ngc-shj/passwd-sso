import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { createAuditLogger, METADATA_BLOCKLIST } from "./audit-logger";

function collectOutput(fn: (logger: ReturnType<typeof createAuditLogger>) => void): string {
  let buf = "";
  const dest = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString();
      cb();
    },
  });
  const logger = createAuditLogger({
    enabled: true,
    appName: "test-app",
    destination: dest,
  });
  fn(logger);
  return buf;
}

describe("createAuditLogger", () => {
  it("produces JSON output with _logType=audit", () => {
    const output = collectOutput((l) => l.info({ audit: { action: "test" } }, "hello"));
    const line = JSON.parse(output);
    expect(line._logType).toBe("audit");
    expect(line._app).toBe("test-app");
    expect(line.level).toBe("info");
  });

  it("redacts sensitive metadata fields", () => {
    const output = collectOutput((l) =>
      l.info({
        audit: {
          metadata: {
            password: "secret123",
            passphrase: "my phrase",
            token: "tok",
            safe: "visible",
          },
        },
      }, "redaction test")
    );
    const line = JSON.parse(output);
    expect(line.audit.metadata.password).toBe("[REDACTED]");
    expect(line.audit.metadata.passphrase).toBe("[REDACTED]");
    expect(line.audit.metadata.token).toBe("[REDACTED]");
    expect(line.audit.metadata.safe).toBe("visible");
  });

  it("produces no output when disabled", () => {
    collectOutput(() => {});
    // re-create disabled logger
    let buf = "";
    const dest = new Writable({
      write(chunk, _enc, cb) {
        buf += chunk.toString();
        cb();
      },
    });
    const logger = createAuditLogger({ enabled: false, destination: dest });
    logger.info("should not appear");
    expect(buf).toBe("");
  });

  it("uses isoTime timestamp format", () => {
    const output = collectOutput((l) => l.info("ts-check"));
    const line = JSON.parse(output);
    // pino isoTime uses "time" key with ISO 8601 format
    expect(line.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("METADATA_BLOCKLIST", () => {
  it("contains expected sensitive field names", () => {
    const expected = [
      "password", "passphrase", "secret", "secretKey",
      "encryptedBlob", "encryptedOverview", "encryptedData",
      "token", "accessToken", "refreshToken", "idToken",
    ];
    for (const key of expected) {
      expect(METADATA_BLOCKLIST.has(key)).toBe(true);
    }
  });

  it("does not contain non-sensitive fields", () => {
    expect(METADATA_BLOCKLIST.has("username")).toBe(false);
    expect(METADATA_BLOCKLIST.has("email")).toBe(false);
  });
});
