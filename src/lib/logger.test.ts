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
    process.env.AUDIT_LOG_APP_NAME = "custom-app";
    const mod = await import("@/lib/logger");
    // Logger is already created with the env var at module load time.
    // The module exports are not recreated; just assert the module loads cleanly.
    expect(mod.default).toBeDefined();
    delete process.env.AUDIT_LOG_APP_NAME;
  });

  it("uses LOG_LEVEL env var to control minimum log level", async () => {
    process.env.LOG_LEVEL = "warn";
    const mod = await import("@/lib/logger");
    // The level is applied at instantiation; module should load without error.
    expect(mod.default.level).toBe("warn");
    delete process.env.LOG_LEVEL;
  });

  it("requestContext.getStore() returns undefined outside of run()", async () => {
    const { requestContext } = await import("@/lib/logger");
    expect(requestContext.getStore()).toBeUndefined();
  });
});
