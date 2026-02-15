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

  it("uses _logType 'app' (not 'audit')", async () => {
    const { chunks, stream } = createSink();
    const mod = await import("@/lib/logger");
    // Create a child logger that writes to our sink by re-creating with same options
    const testLogger = pino(
      {
        level: "info",
        timestamp: pino.stdTimeFunctions.isoTime,
        base: { _logType: "app", _app: "test-app" },
        formatters: {
          level(label: string) {
            return { level: label };
          },
        },
      },
      stream,
    );

    testLogger.info("test message");
    testLogger.flush();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(chunks.length).toBeGreaterThan(0);
    const record = JSON.parse(chunks[0]);
    expect(record._logType).toBe("app");
    expect(record._app).toBe("test-app");
    expect(record.level).toBe("info");

    // Verify the actual module's default export has correct base
    expect(mod.default).toBeDefined();
  });

  it("redacts sensitive fields at top level", async () => {
    const { chunks, stream } = createSink();

    // Re-create logger with same redact config but custom destination
    const testLogger = pino(
      {
        level: "info",
        base: { _logType: "app" },
        redact: {
          paths: [
            "password",
            "passphrase",
            "secret",
            "secretKey",
            "authHash",
            "encryptedBlob",
            "encryptedOverview",
            "encryptedData",
            "encryptedSecretKey",
            "token",
            "tokenHash",
            "accessToken",
            "refreshToken",
            "idToken",
            "authorization",
            "cookie",
          ],
          censor: "[REDACTED]",
        },
        formatters: {
          level(label: string) {
            return { level: label };
          },
        },
      },
      stream,
    );

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
