import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const {
  mockAuth,
  mockPrismaAuditLog,
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
    mockRequireTenantPermission: vi.fn(),
    TenantAuthError: _TenantAuthError,
    mockWithTenantRls: vi.fn(
      async (_prisma: unknown, _tenantId: unknown, fn: () => unknown) => fn(),
    ),
    mockLogAudit: vi.fn(),
    mockDownloadLimiterCheck: vi.fn().mockResolvedValue({ allowed: true }),
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { auditLog: mockPrismaAuditLog },
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
});
