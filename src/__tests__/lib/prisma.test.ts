import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";

// ─── Mocks ──────────────────────────────────────────────────

const { mockOn, mockEnd, mockPoolConstructor, mockWarn, mockError, mockInfo } =
  vi.hoisted(() => ({
    mockOn: vi.fn(),
    mockEnd: vi.fn().mockResolvedValue(undefined),
    mockPoolConstructor: vi.fn(),
    mockWarn: vi.fn(),
    mockError: vi.fn(),
    mockInfo: vi.fn(),
  }));

vi.mock("pg", () => {
  // Use regular function (not arrow) so it can be called with `new`
  function Pool(this: Record<string, unknown>, ...args: unknown[]) {
    mockPoolConstructor(...args);
    this.on = mockOn;
    this.end = mockEnd;
  }
  return { default: { Pool }, Pool };
});

vi.mock("@prisma/adapter-pg", () => {
  function PrismaPg() {}
  return { PrismaPg };
});

vi.mock("@prisma/client", () => {
  function PrismaClient() {}
  return { PrismaClient };
});

vi.mock("@/lib/logger", () => ({
  getLogger: () => ({
    warn: mockWarn,
    error: mockError,
    info: mockInfo,
  }),
}));

// ─── Helpers ────────────────────────────────────────────────

const originalEnv = { ...process.env };

function resetEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, originalEnv);
}

/** Clear globalForPrisma singleton cache (persists on globalThis across vi.resetModules) */
function clearSingletonCache() {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.prisma;
  delete g.pool;
}

// ─── Tests ──────────────────────────────────────────────────

// Prevent MaxListenersExceededWarning from repeated process.once() calls across tests
const originalMaxListeners = process.getMaxListeners();
beforeAll(() => process.setMaxListeners(30));
afterAll(() => process.setMaxListeners(originalMaxListeners));

describe("prisma pool configuration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    clearSingletonCache();
    resetEnv();
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
  });

  afterEach(() => {
    resetEnv();
  });

  it("creates pool with default config values", async () => {
    await import("@/lib/prisma");

    expect(mockPoolConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionString: "postgresql://test:test@localhost:5432/test",
        max: 20,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30_000,
        maxLifetimeSeconds: 1800,
        statement_timeout: 30_000,
        application_name: "passwd-sso",
      }),
    );
  });

  it("uses custom env values for pool config", async () => {
    process.env.DB_POOL_MAX = "50";
    process.env.DB_POOL_CONNECTION_TIMEOUT_MS = "10000";
    process.env.DB_POOL_IDLE_TIMEOUT_MS = "60000";
    process.env.DB_POOL_MAX_LIFETIME_SECONDS = "3600";
    process.env.DB_POOL_STATEMENT_TIMEOUT_MS = "15000";

    await import("@/lib/prisma");

    expect(mockPoolConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        max: 50,
        connectionTimeoutMillis: 10000,
        idleTimeoutMillis: 60000,
        maxLifetimeSeconds: 3600,
        statement_timeout: 15000,
      }),
    );
  });

  it("registers error handler on pool", async () => {
    await import("@/lib/prisma");

    expect(mockOn).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("pool error handler logs with structured logger", async () => {
    await import("@/lib/prisma");

    const errorHandler = mockOn.mock.calls.find(
      (call) => call[0] === "error",
    )![1];
    const testErr = new Error("connection reset");
    errorHandler(testErr);

    expect(mockError).toHaveBeenCalledWith(
      { err: testErr },
      "pool.error.idle_client",
    );
  });

  it("throws when DATABASE_URL is not set", async () => {
    delete process.env.DATABASE_URL;

    await expect(import("@/lib/prisma")).rejects.toThrow(
      "DATABASE_URL environment variable is not set",
    );
  });
});

describe("prisma shutdown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    clearSingletonCache();
    resetEnv();
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
  });

  afterEach(() => {
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
    resetEnv();
  });

  it("registers SIGTERM and SIGINT handlers", async () => {
    await import("@/lib/prisma");

    expect(process.listenerCount("SIGTERM")).toBe(1);
    expect(process.listenerCount("SIGINT")).toBe(1);
  });

  it("SIGTERM handler calls pool.end()", async () => {
    await import("@/lib/prisma");

    const handler = process.listeners("SIGTERM")[0] as () => Promise<void>;
    await handler();

    expect(mockInfo).toHaveBeenCalledWith("pool.shutdown.start");
    expect(mockEnd).toHaveBeenCalled();
    expect(mockInfo).toHaveBeenCalledWith("pool.shutdown.complete");
  });

  it("SIGTERM handler logs error when pool.end() fails", async () => {
    const endError = new Error("pool end failed");
    mockEnd.mockRejectedValueOnce(endError);

    await import("@/lib/prisma");
    const handler = process.listeners("SIGTERM")[0] as () => Promise<void>;
    await handler();

    expect(mockError).toHaveBeenCalledWith(
      { err: endError },
      "pool.shutdown.error",
    );
  });

  it("calls pool.end() only once when both SIGTERM and SIGINT fire", async () => {
    await import("@/lib/prisma");

    const sigterm = process.listeners("SIGTERM")[0] as () => Promise<void>;
    const sigint = process.listeners("SIGINT")[0] as () => Promise<void>;
    await Promise.all([sigterm(), sigint()]);

    expect(mockEnd).toHaveBeenCalledTimes(1);
  });
});

describe("envInt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    clearSingletonCache();
    resetEnv();
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
  });

  afterEach(() => {
    resetEnv();
  });

  it("returns default when env var is not set", async () => {
    const { envInt } = await import("@/lib/prisma");
    expect(envInt("NONEXISTENT_VAR", 42)).toBe(42);
  });

  it("returns default when env var is empty string", async () => {
    process.env.TEST_ENVINT = "";
    const { envInt } = await import("@/lib/prisma");
    expect(envInt("TEST_ENVINT", 42)).toBe(42);
  });

  it("parses valid integer", async () => {
    process.env.TEST_ENVINT = "100";
    const { envInt } = await import("@/lib/prisma");
    expect(envInt("TEST_ENVINT", 42, { min: 0, max: 200 })).toBe(100);
  });

  it("falls back on non-numeric value in dev/test", async () => {
    process.env.TEST_ENVINT = "abc";
    const { envInt } = await import("@/lib/prisma");
    expect(envInt("TEST_ENVINT", 42, { min: 0, max: 200 })).toBe(42);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ envVar: "TEST_ENVINT", raw: "abc" }),
      "pool.env.invalid_number.fallback",
    );
  });

  it("falls back on partial number like '20ms' in dev/test", async () => {
    process.env.TEST_ENVINT = "20ms";
    const { envInt } = await import("@/lib/prisma");
    expect(envInt("TEST_ENVINT", 42, { min: 0, max: 200 })).toBe(42);
    expect(mockWarn).toHaveBeenCalled();
  });

  it("falls back on negative value below min in dev/test", async () => {
    process.env.TEST_ENVINT = "-1";
    const { envInt } = await import("@/lib/prisma");
    expect(envInt("TEST_ENVINT", 42, { min: 0, max: 200 })).toBe(42);
    expect(mockWarn).toHaveBeenCalled();
  });

  it("falls back on value above max in dev/test", async () => {
    process.env.TEST_ENVINT = "999";
    const { envInt } = await import("@/lib/prisma");
    expect(envInt("TEST_ENVINT", 42, { min: 0, max: 200 })).toBe(42);
    expect(mockWarn).toHaveBeenCalled();
  });

  it("throws on invalid value in production", async () => {
    process.env.TEST_ENVINT = "abc";
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    const { envInt } = await import("@/lib/prisma");
    expect(() => envInt("TEST_ENVINT", 42, { min: 0, max: 200 })).toThrow(
      'Invalid DB pool config: TEST_ENVINT="abc"',
    );
  });

  it("throws on out-of-range value in production", async () => {
    process.env.TEST_ENVINT = "999";
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    const { envInt } = await import("@/lib/prisma");
    expect(() => envInt("TEST_ENVINT", 42, { min: 0, max: 200 })).toThrow(
      'Invalid DB pool config: TEST_ENVINT="999"',
    );
  });

  it("falls back on float value in dev/test", async () => {
    process.env.TEST_ENVINT = "3.14";
    const { envInt } = await import("@/lib/prisma");
    expect(envInt("TEST_ENVINT", 42, { min: 0, max: 200 })).toBe(42);
    expect(mockWarn).toHaveBeenCalled();
  });
});
