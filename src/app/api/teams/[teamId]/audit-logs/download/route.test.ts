import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";
import { AUDIT_LOG_MAX_ROWS, AUDIT_LOG_BATCH_SIZE } from "@/lib/validations/common.server";

const { mockAuth, mockPrismaAuditLog, mockPrismaUser, mockRequireTeamPermission, TeamAuthError, mockWithTeamTenantRls, mockLogAudit, mockExtractRequestMeta, mockAssertPolicyAllowsExport, PolicyViolationError, mockCheckRateLimit } = vi.hoisted(() => {
  class _TeamAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "TeamAuthError";
      this.status = status;
    }
  }
  class _PolicyViolationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "PolicyViolationError";
    }
  }
  return {
    mockAuth: vi.fn(),
    mockPrismaAuditLog: { findMany: vi.fn() },
    mockPrismaUser: { findMany: vi.fn().mockResolvedValue([]) },
    mockRequireTeamPermission: vi.fn(),
    TeamAuthError: _TeamAuthError,
    mockWithTeamTenantRls: vi.fn(async (_teamId: string, fn: () => unknown) => fn()),
    mockLogAudit: vi.fn(),
    mockExtractRequestMeta: vi.fn(() => ({ ip: null, userAgent: null })),
    mockAssertPolicyAllowsExport: vi.fn(),
    PolicyViolationError: _PolicyViolationError,
    mockCheckRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: mockPrismaAuditLog,
    user: mockPrismaUser,
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({
      $executeRaw: vi.fn().mockResolvedValue(undefined),
    })),
  },
}));
vi.mock("@/lib/auth/team-auth", () => ({
  requireTeamPermission: mockRequireTeamPermission,
  TeamAuthError,
}));
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: mockWithTeamTenantRls,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: mockExtractRequestMeta,
  teamAuditBase: vi.fn((_, userId, teamId) => ({ scope: "TEAM", userId, teamId })),
}));
vi.mock("@/lib/team-policy", () => ({
  assertPolicyAllowsExport: mockAssertPolicyAllowsExport,
  PolicyViolationError,
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockCheckRateLimit }),
}));

import { GET } from "./route";

const TEAM_ID = "team-123";

async function streamToString(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let result = "";
  let done = false;
  while (!done) {
    const chunk = await reader.read();
    done = chunk.done;
    if (chunk.value) result += decoder.decode(chunk.value, { stream: !done });
  }
  return result;
}

describe("GET /api/teams/[teamId]/audit-logs/download", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireTeamPermission.mockResolvedValue({ role: "OWNER" });
    mockAssertPolicyAllowsExport.mockResolvedValue(undefined);
    mockCheckRateLimit.mockResolvedValue({ allowed: true });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/audit-logs/download`),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when permission denied", async () => {
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("INSUFFICIENT_PERMISSION", 403));
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/audit-logs/download`),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("rethrows unexpected permission errors", async () => {
    mockRequireTeamPermission.mockRejectedValue(new Error("boom"));
    await expect(
      GET(
        createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/audit-logs/download`),
        createParams({ teamId: TEAM_ID }),
      ),
    ).rejects.toThrow("boom");
  });

  it("returns 403 when export is disabled by policy", async () => {
    mockAssertPolicyAllowsExport.mockRejectedValue(new PolicyViolationError("Export is disabled by team policy"));
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/audit-logs/download`),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("rethrows unexpected policy errors", async () => {
    mockAssertPolicyAllowsExport.mockRejectedValue(new Error("boom"));
    await expect(
      GET(
        createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/audit-logs/download`),
        createParams({ teamId: TEAM_ID }),
      ),
    ).rejects.toThrow("boom");
  });

  it("returns 429 when rate limit exceeded", async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false });
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/audit-logs/download`),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(429);
  });

  it("returns 400 when date range exceeds 90 days", async () => {
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/audit-logs/download`, {
        searchParams: { from: "2025-01-01", to: "2025-06-01" },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid date format", async () => {
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/audit-logs/download`, {
        searchParams: { from: "not-a-date" },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when from is after to", async () => {
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/audit-logs/download`, {
        searchParams: { from: "2025-06-02", to: "2025-06-01" },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid action filters", async () => {
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/audit-logs/download`, {
        searchParams: { actions: "ENTRY_CREATE,NOT_REAL", from: "2025-06-01", to: "2025-06-30" },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("streams JSONL format by default", async () => {
    const logEntry = {
      id: "log-1",
      userId: "u1",
      actorType: "HUMAN",
      action: "ENTRY_CREATE",
      targetType: "password",
      targetId: "pw-1",
      metadata: { foo: "bar" },
      ip: "127.0.0.1",
      userAgent: "TestAgent",
      createdAt: new Date("2025-06-01T00:00:00Z"),
    };
    mockPrismaAuditLog.findMany.mockResolvedValue([logEntry]);
    mockPrismaUser.findMany.mockResolvedValue([
      { id: "u1", name: "Test User", email: "test@example.com" },
    ]);

    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/audit-logs/download`, {
        searchParams: { from: "2025-06-01", to: "2025-06-30" },
      }),
      createParams({ teamId: TEAM_ID }),
    );

    expect(res.headers.get("Content-Type")).toContain("application/x-ndjson");
    expect(res.headers.get("Content-Disposition")).toContain("team-audit-logs.jsonl");

    const text = await streamToString(res);
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.id).toBe("log-1");
    expect(parsed.action).toBe("ENTRY_CREATE");
    expect(parsed.user.email).toBe("test@example.com");
    expect(parsed.actorType).toBe("HUMAN");
  });

  it("streams CSV format when requested", async () => {
    const logEntry = {
      id: "log-1",
      action: "ENTRY_CREATE",
      targetType: "password",
      targetId: "pw-1",
      ip: "127.0.0.1",
      userAgent: "TestAgent",
      createdAt: new Date("2025-06-01T00:00:00Z"),
      user: { id: "u1", name: "Test User", email: "test@example.com" },
    };
    mockPrismaAuditLog.findMany.mockResolvedValue([logEntry]);

    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/audit-logs/download`, {
        searchParams: { format: "csv", from: "2025-06-01", to: "2025-06-30" },
      }),
      createParams({ teamId: TEAM_ID }),
    );

    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toContain("team-audit-logs.csv");

    const text = await streamToString(res);
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(2); // header + 1 data row
    expect(lines[0]).toContain("id,action");
    expect(lines[0]).toContain("actorType");
  });

  it("paginates when a full batch is returned", async () => {
    const batch = Array.from({ length: 500 }, (_, index) => ({
      id: `log-${index}`,
      action: "ENTRY_CREATE",
      targetType: "password",
      targetId: `pw-${index}`,
      metadata: null,
      ip: null,
      userAgent: null,
      createdAt: new Date("2025-06-01T00:00:00Z"),
      user: null,
    }));
    mockPrismaAuditLog.findMany
      .mockResolvedValueOnce(batch)
      .mockResolvedValueOnce([]);

    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/audit-logs/download`, {
        searchParams: { from: "2025-06-01", to: "2025-06-30" },
      }),
      createParams({ teamId: TEAM_ID }),
    );

    await streamToString(res);

    expect(mockPrismaAuditLog.findMany).toHaveBeenCalledTimes(2);
    expect(mockPrismaAuditLog.findMany.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        cursor: { id: "log-499" },
        skip: 1,
      }),
    );
  });

  it("logs audit event for download", async () => {
    mockPrismaAuditLog.findMany.mockResolvedValue([]);

    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/audit-logs/download`, {
        searchParams: { from: "2025-06-01", to: "2025-06-30" },
      }),
      createParams({ teamId: TEAM_ID }),
    );

    // Consume stream to ensure it completes
    await streamToString(res);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "AUDIT_LOG_DOWNLOAD",
        teamId: TEAM_ID,
      }),
    );
  });

  it("returns 400 when neither from nor to is provided", async () => {
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/audit-logs/download`),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.details.date).toMatch(/from.*to|to.*from/i);
  });

  it("stops fetching after AUDIT_LOG_MAX_ROWS are reached", async () => {
    const maxBatches = AUDIT_LOG_MAX_ROWS / AUDIT_LOG_BATCH_SIZE;
    const fullBatch = Array.from({ length: AUDIT_LOG_BATCH_SIZE }, (_, index) => ({
      id: `log-${index}`,
      userId: "u1",
      actorType: "HUMAN",
      action: "ENTRY_CREATE",
      targetType: null,
      targetId: null,
      metadata: null,
      ip: null,
      userAgent: null,
      createdAt: new Date("2025-06-01T00:00:00Z"),
    }));

    let callCount = 0;
    mockPrismaAuditLog.findMany.mockImplementation(async () => {
      callCount++;
      return fullBatch;
    });

    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/audit-logs/download`, {
        searchParams: { from: "2025-06-01", to: "2025-06-30" },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    await streamToString(res);

    expect(callCount).toBe(maxBatches);
    expect(mockPrismaAuditLog.findMany).toHaveBeenCalledTimes(maxBatches);
  });
});
