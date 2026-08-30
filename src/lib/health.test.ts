import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockQueryRaw,
  mockGetRedis,
  mockRedisPing,
  mockWithBypassRls,
} = vi.hoisted(() => ({
  mockQueryRaw: vi.fn(),
  mockGetRedis: vi.fn(),
  mockRedisPing: vi.fn(),
  mockWithBypassRls: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: mockQueryRaw,
  },
}));

// The outbox read runs inside a bypass-RLS transaction; the callback gets a tx
// whose $queryRaw is the same mock, so the SQL-discriminating implementations
// below keep working.
// BYPASS_PURPOSE comes from the REAL module. Re-typing its value here would
// let the mock and the assertion agree with each other while production
// recorded a different purpose in app.bypass_purpose — the double and the
// expectation would share an author.
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant-rls")>()),
  withBypassRls: mockWithBypassRls,
}));

vi.mock("@/lib/redis", () => ({
  getRedis: mockGetRedis,
}));

vi.mock("@/lib/logger", () => ({
  getLogger: () => ({
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { runHealthChecks, CHECK_TIMEOUT_MS } from "./health";
import { BYPASS_PURPOSE } from "@/lib/tenant-rls";

describe("runHealthChecks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithBypassRls.mockImplementation((_prisma, fn) =>
      fn({ $queryRaw: mockQueryRaw }),
    );
    mockGetRedis.mockReturnValue({ ping: mockRedisPing });
    // Default audit_outbox query result: empty pending queue
    mockQueryRaw.mockImplementation((strings: TemplateStringsArray) => {
      const sql = strings.join("");
      if (sql.includes("audit_outbox")) {
        return Promise.resolve([{ pending: 0n, oldest_age: 0 }]);
      }
      return Promise.resolve([{ "?column?": 1 }]);
    });
    mockRedisPing.mockResolvedValue("PONG");
  });

  it("returns healthy when DB, Redis, and outbox all pass", async () => {
    const result = await runHealthChecks();

    expect(result.status).toBe("healthy");
    expect(result.checks.database.status).toBe("pass");
    expect(result.checks.redis.status).toBe("pass");
    expect(result.checks.auditOutbox.status).toBe("pass");
    expect(typeof result.timestamp).toBe("string");
  });

  it("returns unhealthy when DB query fails", async () => {
    mockQueryRaw.mockImplementation((strings: TemplateStringsArray) => {
      const sql = strings.join("");
      if (sql.includes("audit_outbox")) {
        return Promise.resolve([{ pending: 0n, oldest_age: 0 }]);
      }
      return Promise.reject(new Error("connect refused"));
    });

    const result = await runHealthChecks();

    expect(result.status).toBe("unhealthy");
    expect(result.checks.database.status).toBe("fail");
  });

  it("returns degraded when Redis ping fails (not required)", async () => {
    vi.stubEnv("HEALTH_REDIS_REQUIRED", "false");
    mockRedisPing.mockRejectedValue(new Error("conn"));

    const result = await runHealthChecks();
    expect(result.status).toBe("degraded");
    expect(result.checks.redis.status).toBe("warn");
  });

  it("returns healthy when Redis is not configured (and not required)", async () => {
    mockGetRedis.mockReturnValue(null);
    const result = await runHealthChecks();
    expect(result.checks.redis.status).toBe("pass");
    expect(result.checks.redis.responseTimeMs).toBe(0);
  });

  it("flags audit_outbox as 'fail' when pending count exceeds threshold", async () => {
    mockQueryRaw.mockImplementation((strings: TemplateStringsArray) => {
      const sql = strings.join("");
      if (sql.includes("audit_outbox")) {
        return Promise.resolve([{ pending: 1_000_000n, oldest_age: 0 }]);
      }
      return Promise.resolve([{ "?column?": 1 }]);
    });

    const result = await runHealthChecks();
    expect(result.status).toBe("unhealthy");
    expect(result.checks.auditOutbox.status).toBe("fail");
  });

  /** Rejects the outbox query with `err`, leaving `SELECT 1` healthy. */
  function rejectOutboxWith(err: unknown) {
    mockQueryRaw.mockImplementation((strings: TemplateStringsArray) => {
      const sql = strings.join("");
      if (sql.includes("audit_outbox")) return Promise.reject(err);
      return Promise.resolve([{ "?column?": 1 }]);
    });
  }

  /**
   * The shape the pg driver adapter actually produces (measured — see
   * src/__tests__/db-integration/helpers.ts), not a hand-written one.
   */
  function pgFailure(sqlstate: string) {
    return Object.assign(
      new Error("\nInvalid `prisma.$queryRaw()` invocation:\n\nRaw query failed."),
      { code: "P2010", meta: { driverAdapterError: { cause: { code: sqlstate } } } },
    );
  }

  it("warns (does not fail) when the audit_outbox table does not exist yet", async () => {
    // The pre-migration tree — the only case the graceful degradation is for.
    rejectOutboxWith(pgFailure("42P01"));

    const result = await runHealthChecks();
    expect(result.checks.auditOutbox.status).toBe("warn");
    // Overall: redis pass + db pass + outbox warn → degraded
    expect(result.status).toBe("degraded");
  });

  it("fails when the audit_outbox query rejects for any other reason", async () => {
    // Degrading every error to "warn" left the check unable to report a fault:
    // a missing RLS context raises 22P02 and came back looking like a tree that
    // had not been migrated yet.
    rejectOutboxWith(pgFailure("22P02"));

    const result = await runHealthChecks();
    expect(result.checks.auditOutbox.status).toBe("fail");
    expect(result.status).toBe("unhealthy");
  });

  // F-M7: the twin at src/__tests__/lib/health.test.ts asserts this; without it
  // here, deleting withBypassRls from health.ts leaves this whole suite green,
  // because the mock forwards to the same mockQueryRaw the bare client uses.
  it("reads the outbox inside a bypass-RLS transaction", async () => {
    const result = await runHealthChecks();
    expect(result.checks.auditOutbox.status).toBe("pass");
    expect(mockWithBypassRls).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function),
      BYPASS_PURPOSE.SYSTEM_MAINTENANCE,
      expect.objectContaining({
        timeout: expect.any(Number),
        maxWait: expect.any(Number),
      }),
    );
  });

  it("bounds the outbox transaction with Prisma's own budget, not only the race", async () => {
    // withTimeout rejects the race; it does not end the transaction, so without
    // this the connection stayed held to Prisma's 5 s default after the check
    // had already reported "fail".
    await runHealthChecks();
    const options = mockWithBypassRls.mock.calls[0]?.[3] as
      | { timeout: number; maxWait: number }
      | undefined;
    expect(options).toBeDefined();
    // The SPLIT is not the contract and must not be pinned here. Prisma bounds
    // the two phases separately — maxWait to START the transaction, timeout to
    // RUN it — so passing only `timeout` still holds a connection for maxWait
    // beyond the budget. Each of the three assertions below has its own
    // mutation: drop maxWait, drop timeout, or widen either past the budget.
    expect(options!.maxWait).toBeGreaterThan(0);
    expect(options!.timeout).toBeGreaterThan(0);
    expect(options!.maxWait + options!.timeout).toBeLessThanOrEqual(CHECK_TIMEOUT_MS);
  });

  it("includes responseTimeMs as a non-negative number on each check", async () => {
    const result = await runHealthChecks();
    expect(result.checks.database.responseTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.checks.redis.responseTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.checks.auditOutbox.responseTimeMs).toBeGreaterThanOrEqual(0);
  });

  it("returns an ISO-8601 timestamp", async () => {
    const result = await runHealthChecks();
    expect(() => new Date(result.timestamp).toISOString()).not.toThrow();
    expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
  });
});
