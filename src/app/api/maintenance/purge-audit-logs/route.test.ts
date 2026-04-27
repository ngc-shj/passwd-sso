import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockVerifyAdminToken,
  mockDeleteMany,
  mockCount,
  mockRequireMaintenanceOperator,
  mockTenantFindMany,
  mockCheck,
  mockLogAudit,
  mockWithBypassRls,
} = vi.hoisted(() => ({
  mockVerifyAdminToken: vi.fn(),
  mockDeleteMany: vi.fn(),
  mockCount: vi.fn(),
  mockRequireMaintenanceOperator: vi.fn(),
  mockTenantFindMany: vi.fn(),
  mockCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockLogAudit: vi.fn(),
  mockWithBypassRls: vi.fn(
    async (_prisma: unknown, fn: () => unknown, _purpose?: unknown) => fn(),
  ),
}));

vi.mock("@/lib/auth/tokens/admin-token", () => ({
  verifyAdminToken: mockVerifyAdminToken,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: { deleteMany: mockDeleteMany, count: mockCount },
    tenant: { findMany: mockTenantFindMany },
  },
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockCheck, clear: vi.fn() }),
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  tenantAuditBase: (_req: unknown, userId: string, tenantId: string) => ({
    scope: "TENANT",
    userId,
    tenantId,
    ip: "10.0.0.1",
    userAgent: "Test",
    acceptLanguage: null,
  }),
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));
vi.mock("@/lib/auth/access/maintenance-auth", () => ({
  requireMaintenanceOperator: mockRequireMaintenanceOperator,
}));

import { POST } from "./route";
import { MS_PER_DAY } from "@/lib/constants/time";

const SUBJECT_USER_ID = "660e8400-e29b-41d4-a716-446655440001";
const TOKEN_ID = "op-token-id-1";
const TENANT_ID = "tenant-1";
import { OPERATOR_TOKEN_PREFIX } from "@/lib/constants/auth/operator-token";

const VALID_OP_TOKEN = `${OPERATOR_TOKEN_PREFIX}${"a".repeat(43)}`;

const VALID_AUTH = {
  subjectUserId: SUBJECT_USER_ID,
  tenantId: TENANT_ID,
  tokenId: TOKEN_ID,
  scopes: ["maintenance"] as const,
};

function createRequest(body: unknown, token?: string): NextRequest {
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
    mockVerifyAdminToken.mockResolvedValue({ ok: false, reason: "MISSING_OR_MALFORMED" });
    mockRequireMaintenanceOperator.mockResolvedValue({
      ok: true,
      operator: { tenantId: TENANT_ID, role: "ADMIN" },
    });
    mockTenantFindMany.mockResolvedValue([{ id: TENANT_ID, auditLogRetentionDays: null }]);
    mockDeleteMany.mockResolvedValue({ count: 0 });
    mockCount.mockResolvedValue(0);
  });

  // ─── Auth ──────────────────────────────────────────────────

  it("returns 401 without authorization header", async () => {
    const req = createRequest({});
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 401 when verifyAdminToken returns INVALID", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: false, reason: "INVALID" });
    const req = createRequest({}, VALID_OP_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  // ─── Rate Limit ────────────────────────────────────────────

  it("returns 429 when rate limited", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockCheck.mockResolvedValue({ allowed: false, retryAfterMs: 30_000 });
    const req = createRequest({}, VALID_OP_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(429);
  });

  it("checks rate limit after auth (401 before 429 for unauthenticated requests)", async () => {
    mockCheck.mockResolvedValue({ allowed: false, retryAfterMs: 30_000 });

    const unauthReq = createRequest({});
    const unauthRes = await POST(unauthReq);
    expect(unauthRes.status).toBe(401);

    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    const authReq = createRequest({}, VALID_OP_TOKEN);
    const authRes = await POST(authReq);
    expect(authRes.status).toBe(429);
  });

  // ─── Operator Membership Check ────────────────────────────

  it("returns 400 when operator is not an active admin", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockRequireMaintenanceOperator.mockResolvedValue({
      ok: false,
      response: new Response(
        JSON.stringify({ error: "operatorId is not an active tenant admin" }),
        { status: 400 },
      ),
    });

    const req = createRequest({}, VALID_OP_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  // ─── Purge Success ────────────────────────────────────────

  it("purges audit log entries per-tenant and returns total count", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockTenantFindMany.mockResolvedValue([
      { id: "tenant-1", auditLogRetentionDays: null },
      { id: "tenant-2", auditLogRetentionDays: null },
    ]);
    mockDeleteMany
      .mockResolvedValueOnce({ count: 20 })
      .mockResolvedValueOnce({ count: 10 });

    const req = createRequest({}, VALID_OP_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.purged).toBe(30);
  });

  it("uses default retentionDays of 365", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockTenantFindMany.mockResolvedValue([{ id: TENANT_ID, auditLogRetentionDays: null }]);
    mockDeleteMany.mockResolvedValue({ count: 0 });

    const req = createRequest({}, VALID_OP_TOKEN);
    await POST(req);

    const cutoff = mockDeleteMany.mock.calls[0][0].where.createdAt.lt as Date;
    const expectedDate = new Date(Date.now() - 365 * MS_PER_DAY);
    expect(Math.abs(cutoff.getTime() - expectedDate.getTime())).toBeLessThan(5000);
  });

  it("respects tenant-level retention floor: uses max(requested, tenantRetention)", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockTenantFindMany.mockResolvedValue([{ id: TENANT_ID, auditLogRetentionDays: 730 }]);
    mockDeleteMany.mockResolvedValue({ count: 0 });

    const req = createRequest({ retentionDays: 365 }, VALID_OP_TOKEN);
    await POST(req);

    const cutoff = mockDeleteMany.mock.calls[0][0].where.createdAt.lt as Date;
    const expected730 = new Date(Date.now() - 730 * MS_PER_DAY);
    expect(Math.abs(cutoff.getTime() - expected730.getTime())).toBeLessThan(5000);
  });

  it("uses requested retentionDays when it exceeds tenant retention", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockTenantFindMany.mockResolvedValue([{ id: TENANT_ID, auditLogRetentionDays: 90 }]);
    mockDeleteMany.mockResolvedValue({ count: 0 });

    const req = createRequest({ retentionDays: 730 }, VALID_OP_TOKEN);
    await POST(req);

    const cutoff = mockDeleteMany.mock.calls[0][0].where.createdAt.lt as Date;
    const expected730 = new Date(Date.now() - 730 * MS_PER_DAY);
    expect(Math.abs(cutoff.getTime() - expected730.getTime())).toBeLessThan(5000);
  });

  // ─── Dry Run ──────────────────────────────────────────────

  it("returns matched count without deleting when dryRun is true", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockTenantFindMany.mockResolvedValue([{ id: TENANT_ID, auditLogRetentionDays: null }]);
    mockCount.mockResolvedValueOnce(8);

    const req = createRequest({ dryRun: true }, VALID_OP_TOKEN);
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
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockTenantFindMany.mockResolvedValue([{ id: TENANT_ID, auditLogRetentionDays: 730 }]);
    mockCount.mockResolvedValueOnce(5);

    const req = createRequest({ retentionDays: 365, dryRun: true }, VALID_OP_TOKEN);
    await POST(req);

    const tenantCutoff = mockCount.mock.calls[0][0].where.createdAt.lt as Date;
    const expected730 = new Date(Date.now() - 730 * MS_PER_DAY);
    expect(Math.abs(tenantCutoff.getTime() - expected730.getTime())).toBeLessThan(5000);
  });

  // ─── Audit ────────────────────────────────────────────────

  it("logs audit with HUMAN actorType and token fields on successful purge", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockTenantFindMany.mockResolvedValue([{ id: TENANT_ID, auditLogRetentionDays: null }]);
    mockDeleteMany.mockResolvedValueOnce({ count: 5 });

    const req = createRequest({}, VALID_OP_TOKEN);
    await POST(req);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "TENANT",
        action: "AUDIT_LOG_PURGE",
        userId: SUBJECT_USER_ID,
        actorType: "HUMAN",
        tenantId: TENANT_ID,
        metadata: expect.objectContaining({
          tokenSubjectUserId: SUBJECT_USER_ID,
          tokenId: TOKEN_ID,
          purgedCount: 5,
          retentionDays: 365,
          targetTable: "auditLog",
          systemWide: true,
        }),
      }),
    );

    // Strict shape: legacy fields must not appear
    const metadata = mockLogAudit.mock.calls[0][0].metadata;
    expect(metadata.operatorId).toBeUndefined();
    expect(metadata.authPath).toBeUndefined();
  });

  it("emits audit with dryRun metadata on dryRun", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockTenantFindMany.mockResolvedValue([{ id: TENANT_ID, auditLogRetentionDays: null }]);
    mockCount.mockResolvedValue(3);

    const req = createRequest({ dryRun: true }, VALID_OP_TOKEN);
    await POST(req);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "TENANT",
        action: "AUDIT_LOG_PURGE",
        actorType: "HUMAN",
        metadata: expect.objectContaining({
          tokenSubjectUserId: SUBJECT_USER_ID,
          tokenId: TOKEN_ID,
          purgedCount: 0,
          matched: 3,
          retentionDays: 365,
          systemWide: true,
          dryRun: true,
          targetTable: "auditLog",
        }),
      }),
    );

    const metadata = mockLogAudit.mock.calls[0][0].metadata;
    expect(metadata.operatorId).toBeUndefined();
    expect(metadata.authPath).toBeUndefined();
  });
});
