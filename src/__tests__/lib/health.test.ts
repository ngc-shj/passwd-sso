import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockQueryRaw, mockGetRedis, mockPing, mockWarn } = vi.hoisted(() => ({
  mockQueryRaw: vi.fn(),
  mockGetRedis: vi.fn(),
  mockPing: vi.fn(),
  mockWarn: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { $queryRaw: mockQueryRaw },
}));

vi.mock("@/lib/redis", () => ({
  getRedis: mockGetRedis,
}));

vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ warn: mockWarn, info: vi.fn(), error: vi.fn() }),
}));

import { runHealthChecks } from "@/lib/health";

describe("health checks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      expect(Object.keys(result.checks)).toEqual(["database", "redis"]);
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
