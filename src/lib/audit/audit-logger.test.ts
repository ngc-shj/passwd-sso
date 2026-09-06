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
      "storedVersion",
    ];
    for (const key of expected) {
      expect(METADATA_BLOCKLIST.has(key)).toBe(true);
    }
  });

  it("does not contain non-sensitive fields", () => {
    expect(METADATA_BLOCKLIST.has("username")).toBe(false);
    expect(METADATA_BLOCKLIST.has("email")).toBe(false);
  });

  it("strips storedVersion but keeps non-sensitive fields", () => {
    const output = collectOutput((l) =>
      l.info({
        audit: {
          metadata: {
            storedVersion: 2,
            shareId: "x",
          },
        },
      }, "blocklist test")
    );
    const line = JSON.parse(output);
    expect(line.audit.metadata.storedVersion).toBe("[REDACTED]");
    expect(line.audit.metadata.shareId).toBe("x");
  });
});

// ─── refusedEmitLogger (C2 / I2.5) ───────────────────────────────
//
// The whole reason this logger exists rather than a fourth `audit-dead-letter`
// reason is its `_logType`: the shipped forwarder excludes that type wholesale
// and filters on `_logType` alone, so a record carrying it is dropped before any
// output. If this value drifts back to "audit-dead-letter", the refusal becomes
// unobservable in a default deployment and every other test stays green.
describe("refusedEmitLogger", () => {
  it("ships under its own _logType, distinct from the excluded dead-letter stream", async () => {
    const { refusedEmitLogger, deadLetterLogger } = await import("./audit-logger");
    const refusedType = (refusedEmitLogger.bindings() as Record<string, unknown>)._logType;
    const deadLetterType = (deadLetterLogger.bindings() as Record<string, unknown>)._logType;

    expect(refusedType).toBe("audit-refused");
    expect(refusedType).not.toBe(deadLetterType);
  });

  it("carries _app, which is what the forwarder's keep-filter matches on", async () => {
    // fluent-bit keeps records via `Regex _app .` before the exclusion runs; a
    // logger without it is filtered out for a different reason than the one
    // this design reasoned about.
    const { refusedEmitLogger } = await import("./audit-logger");
    expect((refusedEmitLogger.bindings() as Record<string, unknown>)._app).toBeTruthy();
  });

  it("is enabled unconditionally, unlike auditLogger", async () => {
    // auditLogger is gated on AUDIT_LOG_FORWARD, which defaults to false. A
    // refusal that shared that gate would be silent in a default deployment.
    const { refusedEmitLogger } = await import("./audit-logger");
    expect(refusedEmitLogger.level).toBe("warn");
  });
});
