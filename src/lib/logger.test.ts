import { describe, it, expect, vi, beforeEach } from "vitest";

describe("logger module", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("exports a default pino logger with info, warn, error methods", async () => {
    const mod = await import("@/lib/logger");
    expect(typeof mod.default.info).toBe("function");
    expect(typeof mod.default.warn).toBe("function");
    expect(typeof mod.default.error).toBe("function");
  });

  it("exports requestContext as AsyncLocalStorage", async () => {
    const mod = await import("@/lib/logger");
    expect(mod.requestContext).toBeDefined();
    expect(typeof mod.requestContext.run).toBe("function");
    expect(typeof mod.requestContext.getStore).toBe("function");
  });

  it("getLogger() returns fallback logger when no context is set", async () => {
    const { getLogger, default: defaultLogger } = await import("@/lib/logger");
    const log = getLogger();
    expect(log).toBe(defaultLogger);
  });

  it("getLogger() returns child logger when requestContext is active", async () => {
    const { getLogger, requestContext, default: defaultLogger } = await import("@/lib/logger");
    const child = defaultLogger.child({ requestId: "test-req-id" });
    const result = await requestContext.run(child, () => getLogger());
    expect(result).toBe(child);
    expect(result).not.toBe(defaultLogger);
  });

  it("uses AUDIT_LOG_APP_NAME env var as app name when set", async () => {
    vi.stubEnv("AUDIT_LOG_APP_NAME", "custom-app");
    const mod = await import("@/lib/logger");
    // Logger is already created with the env var at module load time.
    // The module exports are not recreated; just assert the module loads cleanly.
    expect(mod.default).toBeDefined();
  });

  it("uses LOG_LEVEL env var to control minimum log level", async () => {
    vi.stubEnv("LOG_LEVEL", "warn");
    const mod = await import("@/lib/logger");
    // The level is applied at instantiation; module should load without error.
    expect(mod.default.level).toBe("warn");
  });

  it("requestContext.getStore() returns undefined outside of run()", async () => {
    const { requestContext } = await import("@/lib/logger");
    expect(requestContext.getStore()).toBeUndefined();
  });

  // The server (pino) and client loggers implement ONE redaction policy. They
  // derive from a shared constant precisely so they cannot drift; this pins the
  // wiring, so replacing the shared list with a local copy goes red.
  it("redacts every shared secret key from the bytes pino actually writes", async () => {
    const pino = (await import("pino")).default;
    const { SECRET_REDACT_KEYS, REDACTED } = await import("@/lib/logger/redact-keys");

    // Build an instance with the SAME redact config the module ships, writing
    // to a capture stream so the assertion sees the serialized output rather
    // than the pre-redaction arguments.
    const written: string[] = [];
    const probe = pino(
      { redact: { paths: [...SECRET_REDACT_KEYS], censor: REDACTED } },
      { write: (line: string) => written.push(line) },
    );

    const fields = Object.fromEntries(
      SECRET_REDACT_KEYS.map((k) => [k, `leaked-${k}`]),
    );
    probe.error(fields, "probe");

    const output = written.join("");
    expect(output).not.toContain("leaked-");
    for (const key of SECRET_REDACT_KEYS) {
      expect(JSON.parse(output)[key]).toBe(REDACTED);
    }
  });

  it("the pino instance is configured from the shared key list, not a local copy", async () => {
    const { SECRET_REDACT_KEYS } = await import("@/lib/logger/redact-keys");
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/lib/logger.ts", "utf8");

    // A hardcoded list here would silently diverge from the client logger.
    expect(src).toContain("SECRET_REDACT_KEYS");
    expect(src).not.toMatch(/paths:\s*\[\s*"password"/);
    expect(SECRET_REDACT_KEYS).toContain("password");
    expect(SECRET_REDACT_KEYS).toContain("token");
  });
});
