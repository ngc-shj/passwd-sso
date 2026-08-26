import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockQueryRaw, mockGetRedis, mockPing, mockWarn, mockWithBypassRls } =
  vi.hoisted(() => ({
    mockQueryRaw: vi.fn(),
    mockGetRedis: vi.fn(),
    mockPing: vi.fn(),
    mockWarn: vi.fn(),
    mockWithBypassRls: vi.fn(),
  }));

vi.mock("@/lib/prisma", () => ({
  prisma: { $queryRaw: mockQueryRaw },
}));

// Runs the callback against a tx whose $queryRaw is the same mock, so the
// outbox query keeps flowing through mockQueryRaw. The purpose argument is
// recorded, which is what pins the bypass context in place: dropping
// withBypassRls leaves this uncalled.
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
  getLogger: () => ({ warn: mockWarn, info: vi.fn(), error: vi.fn() }),
}));

import { runHealthChecks } from "@/lib/health";
import { AUDIT_OUTBOX } from "@/lib/constants/audit/audit";
import { BYPASS_PURPOSE } from "@/lib/tenant-rls";

describe("health checks", () => {
  // Fake timers are installed inside three test bodies. `useRealTimers` sits
  // before the assertion in each, so an assertion failure is safe — but a
  // rejection from the awaited promise would leak fake timers into every
  // subsequent test in the file.
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockWithBypassRls.mockImplementation((_prisma, fn) =>
      fn({ $queryRaw: mockQueryRaw }),
    );
    // Reset the IMPLEMENTATION, not just the call log: clearAllMocks leaves
    // one installed, and the timeout case below installs a never-resolving one.
    // Without this, the next test that sets no implementation of its own hangs
    // for the full test timeout and fails for a reason nothing names.
    mockQueryRaw.mockReset();
    mockQueryRaw.mockResolvedValue([{ "?column?": 1 }]);
    mockGetRedis.mockReturnValue(null);
  });

  // ─── checkDatabase ──────────────────────────────────────
  describe("database", () => {
    it("returns pass when SELECT 1 succeeds", async () => {
      mockQueryRaw.mockResolvedValue([{ "?column?": 1 }]);
      const result = await runHealthChecks();
      expect(result.checks.database.status).toBe("pass");
      expect(result.checks.database.responseTimeMs).toBeGreaterThanOrEqual(0);
    });

    it("returns fail when query rejects", async () => {
      mockQueryRaw.mockRejectedValue(new Error("connection refused"));
      const result = await runHealthChecks();
      expect(result.checks.database.status).toBe("fail");
      expect(mockWarn).toHaveBeenCalled();
    });

    it("returns fail on timeout", async () => {
      mockQueryRaw.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 10_000)),
      );
      vi.useFakeTimers();
      const promise = runHealthChecks();
      await vi.advanceTimersByTimeAsync(3_500);
      const result = await promise;
      vi.useRealTimers();
      expect(result.checks.database.status).toBe("fail");
    });

    it("does not include message in CheckResult (no info leakage)", async () => {
      mockQueryRaw.mockRejectedValue(new Error("secret connection string"));
      const result = await runHealthChecks();
      expect(result.checks.database).not.toHaveProperty("message");
    });
  });

  // ─── checkRedis ─────────────────────────────────────────
  describe("redis", () => {
    it("returns pass when redis is not configured (null)", async () => {
      mockGetRedis.mockReturnValue(null);
      const result = await runHealthChecks();
      expect(result.checks.redis.status).toBe("pass");
      expect(result.checks.redis.responseTimeMs).toBe(0);
    });

    it("returns pass when ping succeeds", async () => {
      mockPing.mockResolvedValue("PONG");
      mockGetRedis.mockReturnValue({ ping: mockPing });
      const result = await runHealthChecks();
      expect(result.checks.redis.status).toBe("pass");
    });

    it("returns warn when ping fails (default mode)", async () => {
      mockPing.mockRejectedValue(new Error("redis down"));
      mockGetRedis.mockReturnValue({ ping: mockPing });
      const result = await runHealthChecks();
      expect(result.checks.redis.status).toBe("warn");
      expect(mockWarn).toHaveBeenCalled();
    });

    it("does not include message in CheckResult (no info leakage)", async () => {
      mockPing.mockRejectedValue(new Error("secret redis url"));
      mockGetRedis.mockReturnValue({ ping: mockPing });
      const result = await runHealthChecks();
      expect(result.checks.redis).not.toHaveProperty("message");
    });

    it("returns warn on timeout", async () => {
      mockPing.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 10_000)),
      );
      mockGetRedis.mockReturnValue({ ping: mockPing });
      vi.useFakeTimers();
      const promise = runHealthChecks();
      await vi.advanceTimersByTimeAsync(3_500);
      const result = await promise;
      vi.useRealTimers();
      expect(result.checks.redis.status).toBe("warn");
    });
  });

  // ─── checkAuditOutbox ───────────────────────────────────
  describe("auditOutbox", () => {
    /**
     * A raw-query failure in the shape the pg driver adapter actually
     * produces — measured against a real database in
     * src/__tests__/db-integration/helpers.ts and pinned by fixture in
     * helpers.test.ts. Hand-writing a third spelling here is what let the
     * 42P01 branch be green in this file while returning null in production.
     */
    function pgFailure(sqlstate: string) {
      return Object.assign(
        new Error("\nInvalid `prisma.$queryRaw()` invocation:\n\nRaw query failed."),
        { code: "P2010", meta: { driverAdapterError: { cause: { code: sqlstate } } } },
      );
    }

    /**
     * Fail ONLY the outbox query, leaving `SELECT 1` healthy.
     *
     * A bare mockRejectedValue rejects both, so the database check fails in
     * lockstep and the aggregate is `unhealthy` whatever the outbox did — which
     * is why these cases could previously assert only `checks.auditOutbox`.
     */
    function rejectOutboxWith(err: unknown) {
      mockQueryRaw.mockImplementation((strings: TemplateStringsArray) => {
        const sql = Array.isArray(strings) ? strings.join("") : String(strings);
        if (sql.includes("audit_outbox")) return Promise.reject(err);
        return Promise.resolve([{ "?column?": 1 }]);
      });
    }

    it("reads the outbox inside a bypass-RLS transaction", async () => {
      mockQueryRaw.mockResolvedValue([{ pending: 0n, oldest_age: null }]);
      const result = await runHealthChecks();
      expect(result.checks.auditOutbox.status).toBe("pass");
      expect(mockWithBypassRls).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Function),
        BYPASS_PURPOSE.SYSTEM_MAINTENANCE,
      );
    });

    it("returns fail when the backlog exceeds the pending threshold", async () => {
      mockQueryRaw.mockResolvedValue([
        { pending: BigInt(AUDIT_OUTBOX.READY_PENDING_THRESHOLD + 1), oldest_age: 0 },
      ]);
      const result = await runHealthChecks();
      expect(result.checks.auditOutbox.status).toBe("fail");
    });

    it("returns warn when the table does not exist yet (42P01)", async () => {
      rejectOutboxWith(pgFailure("42P01"));
      const result = await runHealthChecks();
      expect(result.checks.auditOutbox.status).toBe("warn");
      // Reachable only because the database check stayed healthy.
      expect(result.status).toBe("degraded");
    });

    // The regression this narrowing exists for: a missing RLS context raises
    // 22P02, and the old blanket catch reported it as the same non-blocking
    // "warn" a pre-migration tree gets.
    it("returns fail on a query error that is not a missing table", async () => {
      rejectOutboxWith(pgFailure("22P02"));
      const result = await runHealthChecks();
      expect(result.checks.auditOutbox.status).toBe("fail");
      // Reachable only because the database check stayed healthy.
      expect(result.status).toBe("unhealthy");
    });

    it("returns fail when the query rejects with a non-PG error", async () => {
      rejectOutboxWith(new Error("connection refused"));
      const result = await runHealthChecks();
      expect(result.checks.auditOutbox.status).toBe("fail");
      expect(result.status).toBe("unhealthy");
    });

    it("returns fail on timeout", async () => {
      mockQueryRaw.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 10_000)),
      );
      vi.useFakeTimers();
      const promise = runHealthChecks();
      await vi.advanceTimersByTimeAsync(3_500);
      const result = await promise;
      vi.useRealTimers();
      expect(result.checks.auditOutbox.status).toBe("fail");
    });
  });

  // ─── runHealthChecks (aggregate) ────────────────────────
  describe("runHealthChecks", () => {
    it("returns healthy when all checks pass", async () => {
      mockQueryRaw.mockResolvedValue([{ "?column?": 1 }]);
      mockGetRedis.mockReturnValue(null);
      const result = await runHealthChecks();
      expect(result.status).toBe("healthy");
      expect(result.timestamp).toBeDefined();
    });

    it("returns degraded when redis warns", async () => {
      mockQueryRaw.mockResolvedValue([{ "?column?": 1 }]);
      mockPing.mockRejectedValue(new Error("redis down"));
      mockGetRedis.mockReturnValue({ ping: mockPing });
      const result = await runHealthChecks();
      expect(result.status).toBe("degraded");
    });

    it("returns unhealthy when database fails", async () => {
      mockQueryRaw.mockRejectedValue(new Error("db down"));
      mockGetRedis.mockReturnValue(null);
      const result = await runHealthChecks();
      expect(result.status).toBe("unhealthy");
    });

    it("returns unhealthy when database fails even if redis passes", async () => {
      mockQueryRaw.mockRejectedValue(new Error("db down"));
      mockPing.mockResolvedValue("PONG");
      mockGetRedis.mockReturnValue({ ping: mockPing });
      const result = await runHealthChecks();
      expect(result.status).toBe("unhealthy");
    });

    it("response has correct shape with no extra fields", async () => {
      mockQueryRaw.mockResolvedValue([{ "?column?": 1 }]);
      mockGetRedis.mockReturnValue(null);
      const result = await runHealthChecks();
      expect(Object.keys(result)).toEqual(["status", "timestamp", "checks"]);
      expect(Object.keys(result.checks)).toEqual(["database", "redis", "auditOutbox"]);
      expect(Object.keys(result.checks.database)).toEqual([
        "status",
        "responseTimeMs",
      ]);
    });
  });
});

describe("health checks (HEALTH_REDIS_REQUIRED=true)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithBypassRls.mockImplementation((_prisma, fn) =>
      fn({ $queryRaw: mockQueryRaw }),
    );
    // Reset the IMPLEMENTATION, not just the call log: clearAllMocks leaves
    // one installed, and the timeout case below installs a never-resolving one.
    // Without this, the next test that sets no implementation of its own hangs
    // for the full test timeout and fails for a reason nothing names.
    mockQueryRaw.mockReset();
    mockQueryRaw.mockResolvedValue([{ "?column?": 1 }]);
  });

  it("returns fail when redis is not configured but required", async () => {
    vi.stubEnv("HEALTH_REDIS_REQUIRED", "true");
    vi.resetModules();

    const { runHealthChecks: run } = await import("@/lib/health");

    mockQueryRaw.mockResolvedValue([{ "?column?": 1 }]);
    mockGetRedis.mockReturnValue(null);
    const result = await run();
    expect(result.checks.redis.status).toBe("fail");
    expect(result.status).toBe("unhealthy");
    expect(mockWarn).toHaveBeenCalled();

    vi.unstubAllEnvs();
  });

  it("returns fail when redis ping fails and required", async () => {
    vi.stubEnv("HEALTH_REDIS_REQUIRED", "true");
    vi.resetModules();

    const { runHealthChecks: run } = await import("@/lib/health");

    mockQueryRaw.mockResolvedValue([{ "?column?": 1 }]);
    mockPing.mockRejectedValue(new Error("redis down"));
    mockGetRedis.mockReturnValue({ ping: mockPing });
    const result = await run();
    expect(result.checks.redis.status).toBe("fail");
    expect(result.status).toBe("unhealthy");

    vi.unstubAllEnvs();
  });
});
