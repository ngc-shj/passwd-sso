import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";
import { AUDIT_LOG_MAX_ROWS, AUDIT_LOG_BATCH_SIZE } from "@/lib/validations/common.server";

const {
  mockAuth,
  mockPrismaAuditLog,
  mockWithUserTenantRls,
  mockLogAudit,
  mockDownloadLimiterCheck,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaAuditLog: {
    findMany: vi.fn(),
  },
  mockWithUserTenantRls: vi.fn(
    async (_userId: string, fn: () => unknown) => fn(),
  ),
  mockLogAudit: vi.fn(),
  mockDownloadLimiterCheck: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: mockPrismaAuditLog,
  },
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: vi.fn(() => ({ ip: "127.0.0.1", userAgent: "test" })),
  personalAuditBase: vi.fn((_, userId) => ({ scope: "PERSONAL", userId })),
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({
    check: mockDownloadLimiterCheck,
    clear: vi.fn(),
  }),
}));
vi.mock("@/lib/logger", () => ({
  default: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { GET } from "./route";

async function parseStreamResponse(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let result = "";
  let done = false;
  while (!done) {
    const chunk = await reader.read();
    done = chunk.done;
    if (chunk.value) {
      result += decoder.decode(chunk.value, { stream: !done });
    }
  }
  return result;
}

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
  {
    id: "log-2",
    action: "ENTRY_CREATE",
    targetType: "PASSWORD_ENTRY",
    targetId: "entry-1",
    metadata: { source: "manual" },
    ip: "1.2.3.4",
    userAgent: "Chrome/120",
    createdAt: new Date("2026-01-15T11:00:00Z"),
    user: { id: "user-1", name: "Test User", email: "test@example.com" },
  },
];

describe("GET /api/audit-logs/download", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({
      user: { id: "user-1" },
    });
    mockPrismaAuditLog.findMany.mockResolvedValue(MOCK_LOGS);
    mockDownloadLimiterCheck.mockResolvedValue({ allowed: true });
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const req = createRequest("GET", "http://localhost:3000/api/audit-logs/download");
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("returns 429 when rate limited", async () => {
    mockDownloadLimiterCheck.mockResolvedValue({ allowed: false });
    const req = createRequest("GET", "http://localhost:3000/api/audit-logs/download");
    const res = await GET(req);
    expect(res.status).toBe(429);
  });

  it("returns JSONL format by default", async () => {
    const req = createRequest("GET", "http://localhost:3000/api/audit-logs/download");
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/x-ndjson");

    const body = await parseStreamResponse(res);
    const lines = body.trim().split("\n");
    expect(lines.length).toBe(2);

    const first = JSON.parse(lines[0]);
    expect(first.id).toBe("log-1");
    expect(first.action).toBe("AUTH_LOGIN");
  });

  it("returns CSV format when requested", async () => {
    const req = createRequest("GET", "http://localhost:3000/api/audit-logs/download", {
      searchParams: { format: "csv" },
    });
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");

    const body = await parseStreamResponse(res);
    const lines = body.trim().split("\n");
    // Header + 2 data rows
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain("id,action,targetType");
  });

  it("returns 400 when date range exceeds 90 days", async () => {
    const req = createRequest("GET", "http://localhost:3000/api/audit-logs/download", {
      searchParams: {
        from: "2026-01-01T00:00:00Z",
        to: "2026-06-01T00:00:00Z",
      },
    });
    const res = await GET(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.details.range).toContain("90");
  });

  it("returns 400 for invalid date format", async () => {
    const req = createRequest("GET", "http://localhost:3000/api/audit-logs/download", {
      searchParams: { from: "bad-date" },
    });
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 when from is after to", async () => {
    const req = createRequest("GET", "http://localhost:3000/api/audit-logs/download", {
      searchParams: { from: "2026-06-02T00:00:00Z", to: "2026-06-01T00:00:00Z" },
    });
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid action filters", async () => {
    const req = createRequest("GET", "http://localhost:3000/api/audit-logs/download", {
      searchParams: { actions: "ENTRY_CREATE,NOT_REAL" },
    });
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("escapes CSV injection characters in output", async () => {
    mockPrismaAuditLog.findMany.mockResolvedValue([
      {
        ...MOCK_LOGS[0],
        userAgent: "=cmd|'/C calc'!A0",
      },
    ]);
    const req = createRequest("GET", "http://localhost:3000/api/audit-logs/download", {
      searchParams: { format: "csv" },
    });
    const res = await GET(req);
    const body = await parseStreamResponse(res);
    // Single quote prefix should be added before the '=' character
    expect(body).toContain("\"'=cmd");
  });

  it("includes metadata column in CSV output", async () => {
    const req = createRequest("GET", "http://localhost:3000/api/audit-logs/download", {
      searchParams: { format: "csv" },
    });
    const res = await GET(req);
    const body = await parseStreamResponse(res);
    const lines = body.trim().split("\n");
    expect(lines[0]).toContain("metadata");
  });

  it("paginates when a full batch is returned", async () => {
    const batch = Array.from({ length: 500 }, (_, index) => ({
      id: `log-${index}`,
      action: "ENTRY_CREATE",
      targetType: "PASSWORD_ENTRY",
      targetId: `entry-${index}`,
      metadata: null,
      ip: null,
      userAgent: null,
      createdAt: new Date("2026-01-15T10:00:00Z"),
      user: { id: "user-1", name: "Test User", email: "test@example.com" },
    }));
    mockPrismaAuditLog.findMany
      .mockResolvedValueOnce(batch)
      .mockResolvedValueOnce([]);

    const req = createRequest("GET", "http://localhost:3000/api/audit-logs/download");
    const res = await GET(req);
    await parseStreamResponse(res);

    expect(mockPrismaAuditLog.findMany).toHaveBeenCalledTimes(2);
    expect(mockPrismaAuditLog.findMany.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        cursor: { id: "log-499" },
        skip: 1,
      }),
    );
  });

  it("stops fetching after AUDIT_LOG_MAX_ROWS are reached", async () => {
    const maxBatches = AUDIT_LOG_MAX_ROWS / AUDIT_LOG_BATCH_SIZE;
    const fullBatch = Array.from({ length: AUDIT_LOG_BATCH_SIZE }, (_, index) => ({
      id: `log-${index}`,
      action: "ENTRY_CREATE",
      targetType: null,
      targetId: null,
      metadata: null,
      ip: null,
      userAgent: null,
      createdAt: new Date("2026-01-15T10:00:00Z"),
      user: { id: "user-1", name: "Test User", email: "test@example.com" },
    }));

    let callCount = 0;
    mockPrismaAuditLog.findMany.mockImplementation(async () => {
      callCount++;
      return fullBatch;
    });

    const req = createRequest("GET", "http://localhost:3000/api/audit-logs/download");
    const res = await GET(req);
    await parseStreamResponse(res);

    expect(callCount).toBe(maxBatches);
    expect(mockPrismaAuditLog.findMany).toHaveBeenCalledTimes(maxBatches);
  });

  it("records audit log download event", async () => {
    const req = createRequest("GET", "http://localhost:3000/api/audit-logs/download");
    await GET(req);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "AUDIT_LOG_DOWNLOAD",
      }),
    );
  });
});
