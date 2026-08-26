import { describe, it, expect, vi, beforeEach } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";

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

describe("logger", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  /**
   * Build a logger from the module's REAL options, writing to a sink.
   *
   * The previous version of this file hand-rolled an equivalent-looking pino
   * config, so it asserted only that the copy matched itself — a change to the
   * module's base field shipped green. Importing the options is what makes
   * these cases able to fail for the reason they claim.
   */
  async function realLoggerTo(stream: Writable) {
    const { loggerOptions } = await import("@/lib/logger");
    return pino({ ...loggerOptions, level: "info" }, stream);
  }

  it("labels the app stream with _stream, not _logType", async () => {
    const { chunks, stream } = createSink();
    const testLogger = await realLoggerTo(stream);

    testLogger.info("test message");
    testLogger.flush();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(chunks.length).toBeGreaterThan(0);
    const record = JSON.parse(chunks[0]);
    expect(record._stream).toBe("app");
    expect(record._app).toBe("passwd-sso");
    expect(record.level).toBe("info");
    // The base must NOT claim _logType: that key belongs to the call site, and
    // a base value for it is what produced duplicate keys on every alert line.
    expect(record).not.toHaveProperty("_logType");
  });

  it("emits _logType exactly once when a call site sets it", async () => {
    // The property the whole alerting contract rests on. Asserted on the RAW
    // line, not the parsed object: JSON.parse is last-wins, so a parsed record
    // reports the right value even when the key appears twice — the parse would
    // hide exactly the defect this pins.
    const { chunks, stream } = createSink();
    const testLogger = await realLoggerTo(stream);

    testLogger.error({ _logType: "worker.pool.error" }, "worker.pool.error");
    testLogger.flush();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(chunks.length).toBeGreaterThan(0);
    const line = chunks[0];
    expect(line.match(/"_logType"/g)).toHaveLength(1);
    expect(JSON.parse(line)._logType).toBe("worker.pool.error");
  });

  it("redacts sensitive fields at top level", async () => {
    const { chunks, stream } = createSink();
    // The module's real redact paths, not a transcribed copy: a key dropped
    // from SECRET_REDACT_KEYS must redden this, and against a local list it
    // could not.
    const testLogger = await realLoggerTo(stream);

    testLogger.info(
      {
        password: "super-secret",
        authHash: "abc123",
        token: "bearer-xyz",
        authorization: "Bearer token123",
        cookie: "session=abc",
        userId: "user_123",
        path: "/api/vault/unlock",
      },
      "test.redaction",
    );
    testLogger.flush();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(chunks.length).toBeGreaterThan(0);
    const record = JSON.parse(chunks[0]);

    // Sensitive fields are redacted
    expect(record.password).toBe("[REDACTED]");
    expect(record.authHash).toBe("[REDACTED]");
    expect(record.token).toBe("[REDACTED]");
    expect(record.authorization).toBe("[REDACTED]");
    expect(record.cookie).toBe("[REDACTED]");

    // Non-sensitive fields pass through
    expect(record.userId).toBe("user_123");
    expect(record.path).toBe("/api/vault/unlock");
  });

  it("getLogger() returns default logger when no request context", async () => {
    const { getLogger } = await import("@/lib/logger");
    const log = getLogger();
    // Should return a pino logger instance
    expect(log).toBeDefined();
    expect(typeof log.info).toBe("function");
    expect(typeof log.warn).toBe("function");
    expect(typeof log.error).toBe("function");
  });
});
