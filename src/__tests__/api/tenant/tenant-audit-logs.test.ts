import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import { createRequest, parseResponse } from "../../helpers/request-builder";

const {
  mockAuth,
  mockRequireTenantPermission,
  mockAuditLogFindMany,
  mockWithTenantRls,
  mockLogAudit,
  mockRateLimiterCheck,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTenantPermission: vi.fn(),
  mockAuditLogFindMany: vi.fn(),
  mockWithTenantRls: vi.fn(async (_prisma: unknown, _tenantId: unknown, fn: () => unknown) => fn()),
  mockLogAudit: vi.fn(),
  mockRateLimiterCheck: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/tenant-auth", () => {
  class TenantAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
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
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: mockWithTenantRls,
}));
vi.mock("@/lib/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "test" }),
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateLimiterCheck }),
}));
vi.mock("@/lib/with-request-log", () => ({
  withRequestLog: (handler: (...args: unknown[]) => unknown) => handler,
}));
vi.mock("@/lib/constants/tenant-permission", () => ({
  TENANT_PERMISSION: {
    AUDIT_LOG_VIEW: "tenant:auditLog:view",
  },
}));

import { GET } from "@/app/api/tenant/audit-logs/route";
import { GET as GET_DOWNLOAD } from "@/app/api/tenant/audit-logs/download/route";
import { TenantAuthError } from "@/lib/tenant-auth";

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
});
