import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const {
  mockAuth,
  mockPrismaAuditLog,
  mockPrismaTeam,
  mockRequireTenantPermission,
  TenantAuthError,
  mockWithTenantRls,
  mockLogAudit,
  mockDownloadLimiterCheck,
} = vi.hoisted(() => {
  class _TenantAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "TenantAuthError";
      this.status = status;
    }
  }
  return {
    mockAuth: vi.fn(),
    mockPrismaAuditLog: { findMany: vi.fn() },
    mockPrismaTeam: { findFirst: vi.fn() },
    mockRequireTenantPermission: vi.fn(),
    TenantAuthError: _TenantAuthError,
    mockWithTenantRls: vi.fn(
      async (prisma: unknown, _tenantId: unknown, fn: (tx: unknown) => unknown) => fn(prisma),
    ),
    mockLogAudit: vi.fn(),
    mockDownloadLimiterCheck: vi.fn().mockResolvedValue({ allowed: true }),
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { auditLog: mockPrismaAuditLog, team: mockPrismaTeam },
}));
vi.mock("@/lib/auth/access/tenant-auth", () => ({
  requireTenantPermission: mockRequireTenantPermission,
  TenantAuthError,
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: mockWithTenantRls,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: vi.fn(() => ({ ip: "127.0.0.1", userAgent: "test" })),
  tenantAuditBase: (_req: unknown, userId: string, tenantId: string) => ({
    scope: "TENANT",
    userId,
    tenantId,
    ip: "127.0.0.1",
    userAgent: "test",
  }),
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({
    check: mockDownloadLimiterCheck,
  }),
}));
vi.mock("@/lib/logger", () => ({
  default: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/lib/http/with-request-log", () => ({
  withRequestLog: (fn: (...args: unknown[]) => unknown) => fn,
}));

import { GET } from "./route";
import { parseLocalDate } from "@/lib/format/format-datetime";

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

// 7-day-ago ISO string — used to satisfy the route's "from or to required" guard
// without coupling tests to a specific calendar date.
const VALID_FROM = new Date(Date.now() - 7 * 86400000).toISOString();
// The tenant download always applies a date range (to defaults to now).
const RANGE = { from: VALID_FROM, to: expect.any(String) };

const MOCK_LOGS = [
  {
    id: "log-1",
    action: "AUTH_LOGIN",
    targetType: null,
    targetId: null,
    metadata: null,
    ip: "1.2.3.4",
    userAgent: "Chrome/120",
    createdAt: new Date("2026-01-15T10:00:00Z"),
    user: { id: "user-1", name: "Test User", email: "test@example.com" },
  },
];

describe("GET /api/tenant/audit-logs/download", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant-1" });
    mockPrismaAuditLog.findMany.mockResolvedValue(MOCK_LOGS);
    mockDownloadLimiterCheck.mockResolvedValue({ allowed: true });
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const req = createRequest("GET", "http://localhost:3000/api/tenant/audit-logs/download", {
      searchParams: { from: VALID_FROM },
    });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("returns 403 when permission denied", async () => {
    mockRequireTenantPermission.mockRejectedValue(new TenantAuthError("INSUFFICIENT_PERMISSION", 403));
    const req = createRequest("GET", "http://localhost:3000/api/tenant/audit-logs/download", {
      searchParams: { from: VALID_FROM },
    });
    const res = await GET(req);
    expect(res.status).toBe(403);
  });

  it("rethrows unexpected permission errors", async () => {
    mockRequireTenantPermission.mockRejectedValue(new Error("boom"));
    const req = createRequest("GET", "http://localhost:3000/api/tenant/audit-logs/download", {
      searchParams: { from: VALID_FROM },
    });
    await expect(GET(req)).rejects.toThrow("boom");
  });

  it("returns 429 when rate limited", async () => {
    mockDownloadLimiterCheck.mockResolvedValue({ allowed: false });
    const req = createRequest("GET", "http://localhost:3000/api/tenant/audit-logs/download", {
      searchParams: { from: VALID_FROM },
    });
    const res = await GET(req);
    expect(res.status).toBe(429);
  });

  it("returns 400 when neither from nor to is provided", async () => {
    const req = createRequest("GET", "http://localhost:3000/api/tenant/audit-logs/download");
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid date format", async () => {
    const req = createRequest("GET", "http://localhost:3000/api/tenant/audit-logs/download", {
      searchParams: { from: "bad-date" },
    });
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 when from is after to", async () => {
    const req = createRequest("GET", "http://localhost:3000/api/tenant/audit-logs/download", {
      searchParams: { from: "2026-06-02T00:00:00Z", to: "2026-06-01T00:00:00Z" },
    });
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 when date range exceeds 90 days", async () => {
    const req = createRequest("GET", "http://localhost:3000/api/tenant/audit-logs/download", {
      searchParams: { from: new Date(Date.now() - 91 * 86400000).toISOString(), to: new Date().toISOString() },
    });
    const res = await GET(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.details.range).toContain("90");
  });

  it("reads a to-only download as the 90 days ending at to, queried and recorded", async () => {
    const res = await GET(
      createRequest("GET", "http://localhost:3000/api/tenant/audit-logs/download", { searchParams: { to: "2025-01-01T00:00:00.000Z" } }),
    );
    await streamToString(res);

    expect(res.status).toBe(200);
    expect(mockPrismaAuditLog.findMany.mock.calls[0][0].where.createdAt).toEqual({
      gte: new Date("2024-10-03T00:00:00.000Z"),
      lte: new Date("2025-01-01T00:00:00.000Z"),
    });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { format: "jsonl", from: "2024-10-03T00:00:00.000Z", to: "2025-01-01T00:00:00.000Z" },
      }),
    );
  });

  it("accepts the 90 local days a New York client sends across the November fall-back, and not one day more", async () => {
    vi.stubEnv("TZ", "America/New_York");
    const at = (fromDay: string) =>
      GET(
        createRequest("GET", "http://localhost:3000/api/tenant/audit-logs/download", {
          searchParams: { from: parseLocalDate(fromDay)!.toISOString(), to: parseLocalDate("2026-11-02", true)!.toISOString() },
        }),
      );
    // 2026-08-05 .. 2026-11-02 is 90 local days: 90 × 24 h + 1 h − 1 ms.
    expect((await at("2026-08-05")).status).toBe(200);
    expect((await at("2026-08-04")).status).toBe(400);
  });

  it("accepts a span of 90 days + the 2 h DST slack, and not 1 ms more", async () => {
    const at = (to: string) =>
      GET(createRequest("GET", "http://localhost:3000/api/tenant/audit-logs/download", { searchParams: { from: "2026-03-01T00:00:00.000Z", to } }));
    expect((await at("2026-05-30T02:00:00.000Z")).status).toBe(200);
    expect((await at("2026-05-30T02:00:00.001Z")).status).toBe(400);
  });

  it("returns 400 for invalid action filters", async () => {
    const req = createRequest("GET", "http://localhost:3000/api/tenant/audit-logs/download", {
      searchParams: { from: VALID_FROM, actions: "ENTRY_CREATE,NOT_REAL" },
    });
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("streams JSONL format by default", async () => {
    const req = createRequest("GET", "http://localhost:3000/api/tenant/audit-logs/download", {
      searchParams: { from: VALID_FROM },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/x-ndjson");

    const body = await streamToString(res);
    const lines = body.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.id).toBe("log-1");
    expect(parsed.action).toBe("AUTH_LOGIN");
  });

  it("streams CSV format when requested", async () => {
    const req = createRequest("GET", "http://localhost:3000/api/tenant/audit-logs/download", {
      searchParams: { from: VALID_FROM, format: "csv" },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");

    const body = await streamToString(res);
    const lines = body.trim().split("\n");
    // header + 1 data row
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("id,action");
  });

  it("records audit log download event", async () => {
    const req = createRequest("GET", "http://localhost:3000/api/tenant/audit-logs/download", {
      searchParams: { from: VALID_FROM },
    });
    const res = await GET(req);
    await streamToString(res);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "AUDIT_LOG_DOWNLOAD" }),
    );
  });

  it("filters by actorType when provided", async () => {
    const req = createRequest("GET", "http://localhost:3000/api/tenant/audit-logs/download", {
      searchParams: {
        from: VALID_FROM,
        actorType: "SERVICE_ACCOUNT",
      },
    });
    const res = await GET(req);
    await streamToString(res);

    const calledWith = mockPrismaAuditLog.findMany.mock.calls[0][0];
    expect(calledWith.where).toEqual(
      expect.objectContaining({ actorType: "SERVICE_ACCOUNT" }),
    );
  });

  it("omits actorType filter when param absent", async () => {
    const req = createRequest("GET", "http://localhost:3000/api/tenant/audit-logs/download", {
      searchParams: { from: VALID_FROM },
    });
    const res = await GET(req);
    await streamToString(res);

    const calledWith = mockPrismaAuditLog.findMany.mock.calls[0][0];
    expect(calledWith.where).not.toHaveProperty("actorType");
  });

  it("ignores unknown actorType silently", async () => {
    const req = createRequest("GET", "http://localhost:3000/api/tenant/audit-logs/download", {
      searchParams: {
        from: VALID_FROM,
        actorType: "NOT_REAL",
      },
    });
    const res = await GET(req);
    await streamToString(res);

    const calledWith = mockPrismaAuditLog.findMany.mock.calls[0][0];
    expect(calledWith.where).not.toHaveProperty("actorType");
  });

  describe("actor, scope and team filters", () => {
    const MEMBER = "123e4567-e89b-42d3-a456-426614174000";

    it("keeps the recorded filters when the actions list is padded with repeats", async () => {
      const padded = Array.from({ length: 600 }, () => "AUDIT_LOG_DOWNLOAD").join(",");
      const req = createRequest("GET", "http://localhost:3000/api/tenant/audit-logs/download", {
        searchParams: { from: VALID_FROM, userId: MEMBER, actions: padded },
      });
      await streamToString(await GET(req));

      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { format: "jsonl", ...RANGE, actions: ["AUDIT_LOG_DOWNLOAD"], actorUserId: MEMBER },
        }),
      );
    });

    it("narrows to userId and records actorUserId in the download audit row", async () => {
      const req = createRequest("GET", "http://localhost:3000/api/tenant/audit-logs/download", {
        searchParams: { from: VALID_FROM, userId: MEMBER },
      });
      const res = await GET(req);
      await streamToString(res);

      expect(mockPrismaAuditLog.findMany.mock.calls[0][0].where).toMatchObject({
        tenantId: "tenant-1",
        userId: MEMBER,
      });
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: { format: "jsonl", ...RANGE, actorUserId: MEMBER } }),
      );
    });

    it("returns 400 for an invalid userId with no query and no audit row", async () => {
      const req = createRequest("GET", "http://localhost:3000/api/tenant/audit-logs/download", {
        searchParams: { from: VALID_FROM, userId: "x" },
      });
      const res = await GET(req);

      expect(res.status).toBe(400);
      expect(mockPrismaAuditLog.findMany).not.toHaveBeenCalled();
      expect(mockLogAudit).not.toHaveBeenCalled();
    });

    it("honours scope and a tenant-owned teamId", async () => {
      mockPrismaTeam.findFirst.mockResolvedValue({ id: "team-1" });
      const req = createRequest("GET", "http://localhost:3000/api/tenant/audit-logs/download", {
        searchParams: { from: VALID_FROM, scope: "TEAM", teamId: "team-1" },
      });
      const res = await GET(req);
      await streamToString(res);

      expect(mockPrismaAuditLog.findMany.mock.calls[0][0].where).toMatchObject({
        scope: "TEAM",
        teamId: "team-1",
      });
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: { format: "jsonl", ...RANGE, scope: "TEAM", teamId: "team-1" } }),
      );
    });

    it("records the exact range, actions and actor type it applied", async () => {
      const req = createRequest("GET", "http://localhost:3000/api/tenant/audit-logs/download", {
        searchParams: {
          from: "2026-03-01T00:00:00.000Z",
          to: "2026-03-31T00:00:00.000Z",
          actions: "AUDIT_LOG_DOWNLOAD,POLICY_UPDATE",
          actorType: "HUMAN",
        },
      });
      await streamToString(await GET(req));

      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: {
            format: "jsonl",
            from: "2026-03-01T00:00:00.000Z",
            to: "2026-03-31T00:00:00.000Z",
            actions: ["AUDIT_LOG_DOWNLOAD", "POLICY_UPDATE"],
            actorType: "HUMAN",
          },
        }),
      );
    });

    it("orders ascending by createdAt then id", async () => {
      const req = createRequest("GET", "http://localhost:3000/api/tenant/audit-logs/download", {
        searchParams: { from: VALID_FROM },
      });
      await streamToString(await GET(req));

      expect(mockPrismaAuditLog.findMany.mock.calls[0][0].orderBy).toEqual([
        { createdAt: "asc" },
        { id: "asc" },
      ]);
    });

    it("records no teamId under TENANT scope, where the team is not applied", async () => {
      mockPrismaTeam.findFirst.mockResolvedValue({ id: "team-1" });
      const req = createRequest("GET", "http://localhost:3000/api/tenant/audit-logs/download", {
        searchParams: { from: VALID_FROM, scope: "TENANT", teamId: "team-1" },
      });
      const res = await GET(req);
      await streamToString(res);

      expect(mockPrismaAuditLog.findMany.mock.calls[0][0].where.teamId).toBeUndefined();
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: { format: "jsonl", ...RANGE, scope: "TENANT" } }),
      );
    });

    it("returns 400 for another tenant's team with no query and no audit row", async () => {
      mockPrismaTeam.findFirst.mockResolvedValue(null);
      const req = createRequest("GET", "http://localhost:3000/api/tenant/audit-logs/download", {
        searchParams: { from: VALID_FROM, teamId: "foreign" },
      });
      const res = await GET(req);

      expect(res.status).toBe(400);
      expect(mockPrismaAuditLog.findMany).not.toHaveBeenCalled();
      expect(mockLogAudit).not.toHaveBeenCalled();
    });
  });
});
