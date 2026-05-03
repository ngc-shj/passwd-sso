import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockQueryRaw,
  mockGetRedis,
  mockRedisPing,
} = vi.hoisted(() => ({
  mockQueryRaw: vi.fn(),
  mockGetRedis: vi.fn(),
  mockRedisPing: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: mockQueryRaw,
  },
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

import { runHealthChecks } from "./health";

describe("runHealthChecks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("warns (does not fail) when audit_outbox query rejects (graceful degradation)", async () => {
    mockQueryRaw.mockImplementation((strings: TemplateStringsArray) => {
      const sql = strings.join("");
      if (sql.includes("audit_outbox")) {
        return Promise.reject(new Error("relation does not exist"));
      }
      return Promise.resolve([{ "?column?": 1 }]);
    });

    const result = await runHealthChecks();
    expect(result.checks.auditOutbox.status).toBe("warn");
    // Overall: redis pass + db pass + outbox warn → degraded
    expect(result.status).toBe("degraded");
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
