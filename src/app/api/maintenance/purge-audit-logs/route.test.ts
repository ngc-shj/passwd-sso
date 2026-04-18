import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";

const ADMIN_TOKEN = randomBytes(32).toString("hex");

const {
  mockDeleteMany,
  mockCount,
  mockTenantMemberFindFirst,
  mockTenantFindMany,
  mockCheck,
  mockLogAudit,
  mockWithBypassRls,
} = vi.hoisted(() => ({
  mockDeleteMany: vi.fn(),
  mockCount: vi.fn(),
  mockTenantMemberFindFirst: vi.fn(),
  mockTenantFindMany: vi.fn(),
  mockCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockLogAudit: vi.fn(),
  mockWithBypassRls: vi.fn(async (_prisma: unknown, fn: () => unknown) => fn()),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: { deleteMany: mockDeleteMany, count: mockCount },
    tenantMember: { findFirst: mockTenantMemberFindFirst },
    tenant: { findMany: mockTenantFindMany },
  },
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockCheck, clear: vi.fn() }),
}));
vi.mock("@/lib/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({ ip: "10.0.0.1", userAgent: "Test" }),
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));

// Set up env before importing route
const savedEnv: Record<string, string | undefined> = {};

function setEnv(vars: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(vars)) {
    savedEnv[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function restoreEnv() {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

import { POST } from "./route";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";
import { MS_PER_DAY } from "@/lib/constants/time";

function createRequest(
  body: unknown,
  token?: string,
): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": "10.0.0.1",
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return new NextRequest("http://localhost/api/maintenance/purge-audit-logs", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/maintenance/purge-audit-logs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheck.mockResolvedValue({ allowed: true });
    setEnv({ ADMIN_API_TOKEN: ADMIN_TOKEN });
    // Default: one tenant with no retention policy, no null-tenantId rows
    mockTenantFindMany.mockResolvedValue([{ id: "tenant-1", auditLogRetentionDays: null }]);
    mockDeleteMany.mockResolvedValue({ count: 0 });
    mockCount.mockResolvedValue(0);
  });

  afterEach(() => {
    restoreEnv();
  });

  // ─── Auth ──────────────────────────────────────────────────

  it("returns 401 without authorization header", async () => {
    const req = createRequest({ operatorId: "660e8400-e29b-41d4-a716-446655440001" });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 401 with invalid (non-hex) token", async () => {
    const req = createRequest(
      { operatorId: "660e8400-e29b-41d4-a716-446655440001" },
      "not-a-hex-token-at-all-should-fail!!",
    );
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 401 when ADMIN_API_TOKEN is not set", async () => {
    setEnv({ ADMIN_API_TOKEN: undefined });
    const req = createRequest({ operatorId: "660e8400-e29b-41d4-a716-446655440001" }, ADMIN_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  // ─── Rate Limit ────────────────────────────────────────────

  it("returns 429 when rate limited", async () => {
    mockCheck.mockResolvedValue({ allowed: false });
    const req = createRequest({ operatorId: "660e8400-e29b-41d4-a716-446655440001" }, ADMIN_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(429);
  });

  // ─── Body Validation ──────────────────────────────────────

  it("returns 400 when operatorId is missing", async () => {
    const req = createRequest({}, ADMIN_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 when operatorId does not match an active admin", async () => {
    mockTenantMemberFindFirst.mockResolvedValue(null);
    const req = createRequest({ operatorId: "660e8400-e29b-41d4-a716-446655440099" }, ADMIN_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("operatorId");
  });

  // ─── Purge Success ────────────────────────────────────────

  it("purges audit log entries per-tenant and returns total count", async () => {
    mockTenantMemberFindFirst.mockResolvedValue({ tenantId: "tenant-1", role: "ADMIN" });
    mockTenantFindMany.mockResolvedValue([
      { id: "tenant-1", auditLogRetentionDays: null },
      { id: "tenant-2", auditLogRetentionDays: null },
    ]);
    // tenant-1 deletes 20, tenant-2 deletes 10
    mockDeleteMany
      .mockResolvedValueOnce({ count: 20 })
      .mockResolvedValueOnce({ count: 10 });

    const req = createRequest({ operatorId: "660e8400-e29b-41d4-a716-446655440010" }, ADMIN_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.purged).toBe(30);
  });

  it("uses default retentionDays of 365", async () => {
    mockTenantMemberFindFirst.mockResolvedValue({ tenantId: "tenant-1", role: "ADMIN" });
    mockTenantFindMany.mockResolvedValue([{ id: "tenant-1", auditLogRetentionDays: null }]);
    mockDeleteMany.mockResolvedValue({ count: 0 });

    const req = createRequest({ operatorId: "660e8400-e29b-41d4-a716-446655440010" }, ADMIN_TOKEN);
    await POST(req);

    // First deleteMany call is for tenant-1; check the cutoff date
    const cutoff = mockDeleteMany.mock.calls[0][0].where.createdAt.lt as Date;
    const expectedMs = 365 * MS_PER_DAY;
    const expectedDate = new Date(Date.now() - expectedMs);
    expect(Math.abs(cutoff.getTime() - expectedDate.getTime())).toBeLessThan(5000);
  });

  it("respects tenant-level retention floor: uses max(requested, tenantRetention)", async () => {
    mockTenantMemberFindFirst.mockResolvedValue({ tenantId: "tenant-1", role: "ADMIN" });
    // tenant has 730 days retention, requested is 365 → effective should be 730
    mockTenantFindMany.mockResolvedValue([{ id: "tenant-1", auditLogRetentionDays: 730 }]);
    mockDeleteMany.mockResolvedValue({ count: 0 });

    const req = createRequest(
      { operatorId: "660e8400-e29b-41d4-a716-446655440010", retentionDays: 365 },
      ADMIN_TOKEN,
    );
    await POST(req);

    // First deleteMany for tenant-1: cutoff should be 730 days ago
    const tenantCutoff = mockDeleteMany.mock.calls[0][0].where.createdAt.lt as Date;
    const expected730 = new Date(Date.now() - 730 * MS_PER_DAY);
    expect(Math.abs(tenantCutoff.getTime() - expected730.getTime())).toBeLessThan(5000);

  });

  it("uses requested retentionDays when it exceeds tenant retention", async () => {
    mockTenantMemberFindFirst.mockResolvedValue({ tenantId: "tenant-1", role: "ADMIN" });
    // requested 730, tenant only requires 90 → effective should be 730
    mockTenantFindMany.mockResolvedValue([{ id: "tenant-1", auditLogRetentionDays: 90 }]);
    mockDeleteMany.mockResolvedValue({ count: 0 });

    const req = createRequest(
      { operatorId: "660e8400-e29b-41d4-a716-446655440010", retentionDays: 730 },
      ADMIN_TOKEN,
    );
    await POST(req);

    const tenantCutoff = mockDeleteMany.mock.calls[0][0].where.createdAt.lt as Date;
    const expected730 = new Date(Date.now() - 730 * MS_PER_DAY);
    expect(Math.abs(tenantCutoff.getTime() - expected730.getTime())).toBeLessThan(5000);
  });


  // ─── Dry Run ──────────────────────────────────────────────

  it("returns matched count without deleting when dryRun is true", async () => {
    mockTenantMemberFindFirst.mockResolvedValue({ tenantId: "tenant-1", role: "ADMIN" });
    mockTenantFindMany.mockResolvedValue([
      { id: "tenant-1", auditLogRetentionDays: null },
    ]);
    // count for tenant-1 = 8
    mockCount.mockResolvedValueOnce(8);

    const req = createRequest(
      { operatorId: "660e8400-e29b-41d4-a716-446655440010", dryRun: true },
      ADMIN_TOKEN,
    );
    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.purged).toBe(0);
    expect(body.matched).toBe(8);
    expect(body.dryRun).toBe(true);

    expect(mockDeleteMany).not.toHaveBeenCalled();
    expect(mockCount).toHaveBeenCalledTimes(1);
  });

  it("dry run respects tenant retention floor for count", async () => {
    mockTenantMemberFindFirst.mockResolvedValue({ tenantId: "tenant-1", role: "ADMIN" });
    mockTenantFindMany.mockResolvedValue([{ id: "tenant-1", auditLogRetentionDays: 730 }]);
    mockCount.mockResolvedValueOnce(5);

    const req = createRequest(
      { operatorId: "660e8400-e29b-41d4-a716-446655440010", retentionDays: 365, dryRun: true },
      ADMIN_TOKEN,
    );
    await POST(req);

    // Count for tenant-1 should use 730-day cutoff (tenant floor wins)
    const tenantCountCall = mockCount.mock.calls[0];
    const tenantCutoff = tenantCountCall[0].where.createdAt.lt as Date;
    const expected730 = new Date(Date.now() - 730 * MS_PER_DAY);
    expect(Math.abs(tenantCutoff.getTime() - expected730.getTime())).toBeLessThan(5000);
  });

  // ─── Auth Order ───────────────────────────────────────────

  it("checks rate limit after auth (429 only for authenticated requests)", async () => {
    mockCheck.mockResolvedValue({ allowed: false });
    // Unauthenticated request should get 401, not 429
    const unauthReq = createRequest({ operatorId: "660e8400-e29b-41d4-a716-446655440010" });
    const unauthRes = await POST(unauthReq);
    expect(unauthRes.status).toBe(401);

    // Authenticated request should get 429
    const authReq = createRequest({ operatorId: "660e8400-e29b-41d4-a716-446655440010" }, ADMIN_TOKEN);
    const authRes = await POST(authReq);
    expect(authRes.status).toBe(429);
  });

  // ─── Audit ────────────────────────────────────────────────

  it("logs audit with scope TENANT on successful purge", async () => {
    mockTenantMemberFindFirst.mockResolvedValue({ tenantId: "tenant-1", role: "ADMIN" });
    mockTenantFindMany.mockResolvedValue([{ id: "tenant-1", auditLogRetentionDays: null }]);
    mockDeleteMany
      .mockResolvedValueOnce({ count: 5 });

    const req = createRequest({ operatorId: "660e8400-e29b-41d4-a716-446655440010" }, ADMIN_TOKEN);
    await POST(req);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "TENANT",
        action: "HISTORY_PURGE",
        userId: SYSTEM_ACTOR_ID,
        actorType: "SYSTEM",
        tenantId: "tenant-1",
        metadata: expect.objectContaining({
          operatorId: "660e8400-e29b-41d4-a716-446655440010",
          purgedCount: 5,
          retentionDays: 365,
          systemWide: true,
        }),
      }),
    );
  });

  it("does not log audit on dryRun", async () => {
    mockTenantMemberFindFirst.mockResolvedValue({ tenantId: "tenant-1", role: "ADMIN" });
    mockTenantFindMany.mockResolvedValue([{ id: "tenant-1", auditLogRetentionDays: null }]);
    mockCount.mockResolvedValue(3);

    const req = createRequest(
      { operatorId: "660e8400-e29b-41d4-a716-446655440010", dryRun: true },
      ADMIN_TOKEN,
    );
    await POST(req);

    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});
