import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import { createRequest, parseResponse } from "../../helpers/request-builder";

const {
  mockAuth,
  mockRequireTenantPermission,
  mockAuditLogFindMany,
  mockTeamFindFirst,
  mockWithTenantRls,
  mockLogAudit,
  mockRateLimiterCheck,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTenantPermission: vi.fn(),
  mockAuditLogFindMany: vi.fn(),
  mockTeamFindFirst: vi.fn(),
  mockWithTenantRls: vi.fn(async (prisma: unknown, _tenantId: unknown, fn: (tx: unknown) => unknown) => fn(prisma)),
  mockLogAudit: vi.fn(),
  mockRateLimiterCheck: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/auth/access/tenant-auth", () => {
  class TenantAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "TenantAuthError";
      this.status = status;
    }
  }
  return {
    requireTenantPermission: mockRequireTenantPermission,
    TenantAuthError,
  };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: { findMany: mockAuditLogFindMany },
    team: { findFirst: mockTeamFindFirst },
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: mockWithTenantRls,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "test" }),
  tenantAuditBase: (_req: unknown, userId: string, tenantId: string) => ({
    scope: "TENANT", userId, tenantId, ip: "127.0.0.1", userAgent: "test",
  }),
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateLimiterCheck }),
}));
vi.mock("@/lib/http/with-request-log", () => ({
  withRequestLog: (handler: (...args: unknown[]) => unknown) => handler,
}));
vi.mock("@/lib/constants/auth/tenant-permission", () => ({
  TENANT_PERMISSION: {
    AUDIT_LOG_VIEW: "tenant:auditLog:view",
  },
}));

import { GET } from "@/app/api/tenant/audit-logs/route";
import { GET as GET_DOWNLOAD } from "@/app/api/tenant/audit-logs/download/route";
import { TenantAuthError } from "@/lib/auth/access/tenant-auth";
import { parseLocalDate } from "@/lib/format/format-datetime";

function makeLog(overrides: Record<string, unknown> = {}) {
  return {
    id: "log-1",
    action: "AUTH_LOGIN",
    targetType: null,
    targetId: null,
    metadata: {},
    ip: "127.0.0.1",
    userAgent: "Mozilla",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    user: {
      id: "user-1",
      name: "Test User",
      email: "user@example.com",
      image: null,
    },
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// GET /api/tenant/audit-logs
// ────────────────────────────────────────────────────────────────────────────
describe("GET /api/tenant/audit-logs", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 without session", async () => {
    mockAuth.mockResolvedValue(null);
    const req = createRequest("GET", "http://localhost/api/tenant/audit-logs");
    const res = await GET(req);
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 403 without AUDIT_LOG_VIEW permission", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockRejectedValue(new TenantAuthError("FORBIDDEN", 403));
    const req = createRequest("GET", "http://localhost/api/tenant/audit-logs");
    const res = await GET(req);
    const { status } = await parseResponse(res);
    expect(status).toBe(403);
  });

  it("returns 200 with items and nextCursor when there are more results", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });

    // Return limit+1 items to trigger pagination (default limit=50, so return 51)
    const logs = Array.from({ length: 51 }, (_, i) => makeLog({ id: `log-${i}` }));
    mockAuditLogFindMany.mockResolvedValue(logs);

    const req = createRequest("GET", "http://localhost/api/tenant/audit-logs");
    const res = await GET(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.items).toHaveLength(50);
    expect(json.nextCursor).toBe("log-49");
  });

  it("returns 200 with null nextCursor when no more results", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
    mockAuditLogFindMany.mockResolvedValue([makeLog()]);

    const req = createRequest("GET", "http://localhost/api/tenant/audit-logs");
    const res = await GET(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.items).toHaveLength(1);
    expect(json.nextCursor).toBeNull();
  });

  it("filters by action parameter", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
    mockAuditLogFindMany.mockResolvedValue([makeLog({ action: "AUTH_LOGIN" })]);

    const req = createRequest("GET", "http://localhost/api/tenant/audit-logs", {
      searchParams: { action: "AUTH_LOGIN" },
    });
    const res = await GET(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(200);
    expect(mockAuditLogFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ action: "AUTH_LOGIN" }),
      }),
    );
  });

  it("filters by date range (from/to)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
    mockAuditLogFindMany.mockResolvedValue([makeLog()]);

    const req = createRequest("GET", "http://localhost/api/tenant/audit-logs", {
      searchParams: {
        from: "2026-01-01T00:00:00Z",
        to: "2026-01-31T23:59:59Z",
      },
    });
    const res = await GET(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(200);
    expect(mockAuditLogFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: {
            gte: new Date("2026-01-01T00:00:00Z"),
            lte: new Date("2026-01-31T23:59:59Z"),
          },
        }),
      }),
    );
  });

  describe("userId actor filter", () => {
    const MEMBER = "123e4567-e89b-42d3-a456-426614174000";

    it("narrows the query to the member's rows", async () => {
      mockAuth.mockResolvedValue(DEFAULT_SESSION);
      mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
      mockAuditLogFindMany.mockResolvedValue([makeLog()]);

      const res = await GET(
        createRequest("GET", "http://localhost/api/tenant/audit-logs", {
          searchParams: { userId: MEMBER },
        }),
      );
      const { status, json } = await parseResponse(res);

      expect(status).toBe(200);
      expect(json.items).toHaveLength(1);
      expect(mockAuditLogFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tenantId: "tenant1", userId: MEMBER }),
        }),
      );
    });

    it("does not add a userId predicate when the param is absent", async () => {
      mockAuth.mockResolvedValue(DEFAULT_SESSION);
      mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
      mockAuditLogFindMany.mockResolvedValue([]);

      await GET(createRequest("GET", "http://localhost/api/tenant/audit-logs"));

      expect(mockAuditLogFindMany.mock.calls[0][0].where).not.toHaveProperty("userId");
    });

    it("returns 400 for a non-uuid userId without querying", async () => {
      mockAuth.mockResolvedValue(DEFAULT_SESSION);
      mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });

      const res = await GET(
        createRequest("GET", "http://localhost/api/tenant/audit-logs", {
          searchParams: { userId: "not-a-uuid" },
        }),
      );
      const { status, json } = await parseResponse(res);

      expect(status).toBe(400);
      expect(json.details).toHaveProperty("userId");
      expect(mockAuditLogFindMany).not.toHaveBeenCalled();
    });

    it("orders by createdAt then id so equal timestamps page stably", async () => {
      mockAuth.mockResolvedValue(DEFAULT_SESSION);
      mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
      mockAuditLogFindMany.mockResolvedValue([]);

      await GET(createRequest("GET", "http://localhost/api/tenant/audit-logs"));

      expect(mockAuditLogFindMany.mock.calls[0][0].orderBy).toEqual([
        { createdAt: "desc" },
        { id: "desc" },
      ]);
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/tenant/audit-logs/download
// ────────────────────────────────────────────────────────────────────────────
describe("GET /api/tenant/audit-logs/download", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 without session", async () => {
    mockAuth.mockResolvedValue(null);
    const req = createRequest("GET", "http://localhost/api/tenant/audit-logs/download");
    const res = await GET_DOWNLOAD(req);
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 400 when no date range provided", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });

    const req = createRequest("GET", "http://localhost/api/tenant/audit-logs/download");
    const res = await GET_DOWNLOAD(req);
    const { status } = await parseResponse(res);
    expect(status).toBe(400);
  });

  it("returns 429 when rate limited", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
    mockRateLimiterCheck.mockResolvedValueOnce({ allowed: false });

    const req = createRequest("GET", "http://localhost/api/tenant/audit-logs/download", {
      searchParams: { from: "2026-01-01T00:00:00Z" },
    });
    const res = await GET_DOWNLOAD(req);
    const { status } = await parseResponse(res);
    expect(status).toBe(429);
  });

  it("returns 200 with CSV content-type for format=csv", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
    mockAuditLogFindMany.mockResolvedValue([]);

    const req = createRequest("GET", "http://localhost/api/tenant/audit-logs/download", {
      searchParams: { from: new Date(Date.now() - 7 * 86400000).toISOString(), format: "csv" },
    });
    const res = await GET_DOWNLOAD(req);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/csv/);
  });

  it("returns 200 with JSONL content-type for format=jsonl", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
    mockAuditLogFindMany.mockResolvedValue([]);

    const req = createRequest("GET", "http://localhost/api/tenant/audit-logs/download", {
      searchParams: { from: new Date(Date.now() - 7 * 86400000).toISOString(), format: "jsonl" },
    });
    const res = await GET_DOWNLOAD(req);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/application\/x-ndjson/);
  });

  describe("filters shared with the list", () => {
    const MEMBER = "123e4567-e89b-42d3-a456-426614174000";
    const FROM = new Date(Date.now() - 7 * 86400000).toISOString();
    // The tenant download always applies a date range (to defaults to now).
    const RANGE = { from: FROM, to: expect.any(String) };

    async function download(searchParams: Record<string, string>) {
      mockAuth.mockResolvedValue(DEFAULT_SESSION);
      mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
      mockRateLimiterCheck.mockResolvedValue({ allowed: true });
      mockAuditLogFindMany.mockResolvedValue([]);
      const res = await GET_DOWNLOAD(
        createRequest("GET", "http://localhost/api/tenant/audit-logs/download", {
          searchParams: { from: FROM, ...searchParams },
        }),
      );
      if (res.status === 200) await res.text();
      return res;
    }

    it("narrows to the member and records actorUserId in the download audit row", async () => {
      const res = await download({ userId: MEMBER });

      expect(res.status).toBe(200);
      expect(mockAuditLogFindMany.mock.calls[0][0].where).toMatchObject({
        tenantId: "tenant1",
        userId: MEMBER,
      });
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "AUDIT_LOG_DOWNLOAD",
          metadata: { format: "jsonl", ...RANGE, actorUserId: MEMBER },
        }),
      );
    });

    it("records only the date range when no other filter is applied", async () => {
      await download({ scope: "BOGUS" });

      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: { format: "jsonl", ...RANGE } }),
      );
    });

    it("reads a to-only download as the 90 days ending at to, queried and recorded", async () => {
      // Not through download(): it always adds a `from`.
      mockAuth.mockResolvedValue(DEFAULT_SESSION);
      mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
      mockRateLimiterCheck.mockResolvedValue({ allowed: true });
      mockAuditLogFindMany.mockResolvedValue([]);
      const res = await GET_DOWNLOAD(
        createRequest("GET", "http://localhost/api/tenant/audit-logs/download", { searchParams: { to: "2025-01-01T00:00:00.000Z" } }),
      );
      if (res.status === 200) await res.text();

      expect(res.status).toBe(200);
      expect(mockAuditLogFindMany.mock.calls[0][0].where.createdAt).toEqual({
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
      const to = parseLocalDate("2026-11-02", true)!.toISOString();
      // 2026-08-05 .. 2026-11-02 is 90 local days: 90 × 24 h + 1 h − 1 ms.
      expect((await download({ from: parseLocalDate("2026-08-05")!.toISOString(), to })).status).toBe(200);
      expect((await download({ from: parseLocalDate("2026-08-04")!.toISOString(), to })).status).toBe(400);
    });

    it("accepts a span of 90 days + the 2 h DST slack, and not 1 ms more", async () => {
      expect((await download({ from: "2026-03-01T00:00:00.000Z", to: "2026-05-30T02:00:00.000Z" })).status).toBe(200);
      expect((await download({ from: "2026-03-01T00:00:00.000Z", to: "2026-05-30T02:00:00.001Z" })).status).toBe(400);
    });

    it("records the exact to it applied", async () => {
      await download({ to: "2026-03-31T00:00:00.000Z", from: "2026-03-01T00:00:00.000Z" });

      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { format: "jsonl", from: "2026-03-01T00:00:00.000Z", to: "2026-03-31T00:00:00.000Z" },
        }),
      );
    });

    it("records the actions and actor type it applied", async () => {
      await download({ actions: "AUDIT_LOG_DOWNLOAD,POLICY_UPDATE", actorType: "HUMAN" });

      expect(mockAuditLogFindMany.mock.calls[0][0].where).toMatchObject({
        action: { in: ["AUDIT_LOG_DOWNLOAD", "POLICY_UPDATE"] },
        actorType: "HUMAN",
      });
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { format: "jsonl", ...RANGE, actions: ["AUDIT_LOG_DOWNLOAD", "POLICY_UPDATE"], actorType: "HUMAN" },
        }),
      );
    });

    it("keeps the recorded filters when the actions list is padded with repeats", async () => {
      const padded = Array.from({ length: 600 }, () => "AUDIT_LOG_DOWNLOAD").join(",");

      await download({ userId: MEMBER, actions: padded });

      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { format: "jsonl", ...RANGE, actions: ["AUDIT_LOG_DOWNLOAD"], actorUserId: MEMBER },
        }),
      );
    });

    it("records no teamId under TENANT scope, where the team is not applied", async () => {
      mockTeamFindFirst.mockResolvedValue({ id: "team-1" });

      await download({ scope: "TENANT", teamId: "team-1" });

      expect(mockAuditLogFindMany.mock.calls[0][0].where.teamId).toBeUndefined();
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: { format: "jsonl", ...RANGE, scope: "TENANT" } }),
      );
    });

    it("returns 400 for a non-uuid userId before any query or audit row", async () => {
      const res = await download({ userId: "nope" });

      expect(res.status).toBe(400);
      expect(mockAuditLogFindMany).not.toHaveBeenCalled();
      expect(mockLogAudit).not.toHaveBeenCalled();
    });

    it("honours scope and teamId and records them", async () => {
      mockTeamFindFirst.mockResolvedValue({ id: "team-1" });

      const res = await download({ scope: "TEAM", teamId: "team-1" });

      expect(res.status).toBe(200);
      expect(mockTeamFindFirst).toHaveBeenCalledWith({
        where: { id: "team-1", tenantId: "tenant1" },
        select: { id: true },
      });
      expect(mockAuditLogFindMany.mock.calls[0][0].where).toMatchObject({
        scope: "TEAM",
        teamId: "team-1",
      });
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { format: "jsonl", ...RANGE, scope: "TEAM", teamId: "team-1" },
        }),
      );
    });

    it("returns 400 for a team outside the tenant with no log query and no audit row", async () => {
      mockTeamFindFirst.mockResolvedValue(null);

      const res = await download({ teamId: "foreign-team" });

      expect(res.status).toBe(400);
      expect(mockAuditLogFindMany).not.toHaveBeenCalled();
      expect(mockLogAudit).not.toHaveBeenCalled();
    });

    it("orders ascending by createdAt then id", async () => {
      await download({});

      expect(mockAuditLogFindMany.mock.calls[0][0].orderBy).toEqual([
        { createdAt: "asc" },
        { id: "asc" },
      ]);
    });
  });
});
