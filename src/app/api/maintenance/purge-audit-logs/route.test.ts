import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { assertRedisFailClosed, snapshotFactory } from "@/__tests__/helpers/fail-closed";

const {
  mockVerifyAdminToken,
  mockDeleteMany,
  mockCount,
  mockQueryRaw,
  mockRequireMaintenanceOperator,
  mockTenantFindUnique,
  mockCheck,
  mockCreateRateLimiter,
  mockLogAudit,
  mockWithBypassRls,
} = vi.hoisted(() => {
  const mockCheck = vi.fn().mockResolvedValue({ allowed: true });
  return {
    mockVerifyAdminToken: vi.fn(),
    mockDeleteMany: vi.fn(),
    mockCount: vi.fn(),
    // C13: purge route now calls audit_log_purge() SECURITY DEFINER via
    // $queryRaw. Stub returns the same shape the function emits.
    mockQueryRaw: vi.fn(),
    mockRequireMaintenanceOperator: vi.fn(),
    mockTenantFindUnique: vi.fn(),
    mockCheck,
    mockCreateRateLimiter: vi.fn(() => ({ check: mockCheck, clear: vi.fn() })),
    mockLogAudit: vi.fn(),
    mockWithBypassRls: vi.fn(
      async (prisma: unknown, fn: (tx: unknown) => unknown, _purpose?: unknown) => fn(prisma),
    ),
  };
});

vi.mock("@/lib/auth/tokens/admin-token", () => ({
  verifyAdminToken: mockVerifyAdminToken,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: { deleteMany: mockDeleteMany, count: mockCount },
    tenant: { findUnique: mockTenantFindUnique },
    $queryRaw: mockQueryRaw,
  },
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: mockCreateRateLimiter,
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

// Module-scope snapshot: route.ts's `rateLimiter = createRateLimiter(...)` runs
// at import time above, before any beforeEach's vi.clearAllMocks() can wipe it.
const purgeAuditLogsLimiterFactorySnapshot = snapshotFactory(mockCreateRateLimiter);
const purgeAuditLogsLimiter = mockCreateRateLimiter.mock.results[0]!.value as {
  check: typeof mockCheck;
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
    // Default: a non-null tenant retention (365d) — the RETENTION_INDEFINITE
    // reject path is exercised by its own dedicated tests below, which
    // override this to null.
    mockTenantFindUnique.mockResolvedValue({ auditLogRetentionDays: 365 });
    mockDeleteMany.mockResolvedValue({ count: 0 });
    mockQueryRaw.mockResolvedValue([{ rows_deleted: 0 }]);
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

    // #629 headline property: the maintenance rate-limit key is tenant-scoped
    // so one tenant's operator cannot 429 another tenant's purge. A regression
    // dropping `${auth.tenantId}` (global key) or swapping in subjectUserId
    // would still pass the 429/503 behavior tests — only an exact-key assertion
    // pinning the route discriminator + tenantId segment catches it. The key is
    // passed to check() before the limiter's verdict, so asserting it here
    // needs no route-specific success mocks.
    expect(mockCheck).toHaveBeenCalledWith(`rl:maintenance:purge-audit-logs:${TENANT_ID}`);
  });

  it("fails closed (503, no mutation) when Redis is unavailable", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    await assertRedisFailClosed({
      invoke: () => POST(createRequest({}, VALID_OP_TOKEN)),
      limiter: purgeAuditLogsLimiter,
      expectation: { envelope: "canonical" },
      // C13: the real purge executes via $queryRaw(audit_log_purge); deleteMany
      // is legacy/unused on this path — assert on the primitive that actually runs.
      assertNoMutation: [mockQueryRaw],
      limiterFactory: purgeAuditLogsLimiterFactorySnapshot.replay(),
      failure: { allowed: false, redisErrored: true },
    });
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

  it("purges audit log entries for the operator's tenant only and returns count", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockTenantFindUnique.mockResolvedValue({ auditLogRetentionDays: 365 });
    mockDeleteMany.mockResolvedValueOnce({ count: 20 });
    mockQueryRaw.mockResolvedValueOnce([{ rows_deleted: 20 }]);

    const req = createRequest({}, VALID_OP_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.purged).toBe(20);

    // Tenant lookup must use the auth token's tenantId (not findMany).
    expect(mockTenantFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: TENANT_ID } }),
    );
    // The single deleteMany must include tenantId = auth.tenantId.
    // C13: real purge uses $queryRaw(audit_log_purge) now; deleteMany is not called.
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    // $queryRaw tagged-template: args[0]=strings, args[1]=tenantId, args[2]=cutoff
    expect(mockQueryRaw.mock.calls[0][1]).toBe(TENANT_ID);
  });

  it("returns 0 when the bound tenant no longer exists", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockTenantFindUnique.mockResolvedValue(null);

    const req = createRequest({}, VALID_OP_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.purged).toBe(0);
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  it("uses default retentionDays of 365", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockTenantFindUnique.mockResolvedValue({ auditLogRetentionDays: 365 });
    mockDeleteMany.mockResolvedValue({ count: 0 });
    mockQueryRaw.mockResolvedValue([{ rows_deleted: 0 }]);

    const req = createRequest({}, VALID_OP_TOKEN);
    await POST(req);

    const cutoff = mockQueryRaw.mock.calls[0][2] as Date;
    const expectedDate = new Date(Date.now() - 365 * MS_PER_DAY);
    expect(Math.abs(cutoff.getTime() - expectedDate.getTime())).toBeLessThan(5000);
  });

  it("respects tenant-level retention floor: uses max(requested, tenantRetention)", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockTenantFindUnique.mockResolvedValue({ auditLogRetentionDays: 730 });
    mockDeleteMany.mockResolvedValue({ count: 0 });
    mockQueryRaw.mockResolvedValue([{ rows_deleted: 0 }]);

    const req = createRequest({ retentionDays: 365 }, VALID_OP_TOKEN);
    await POST(req);

    const cutoff = mockQueryRaw.mock.calls[0][2] as Date;
    const expected730 = new Date(Date.now() - 730 * MS_PER_DAY);
    expect(Math.abs(cutoff.getTime() - expected730.getTime())).toBeLessThan(5000);
  });

  it("uses requested retentionDays when it exceeds tenant retention", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockTenantFindUnique.mockResolvedValue({ auditLogRetentionDays: 90 });
    mockDeleteMany.mockResolvedValue({ count: 0 });
    mockQueryRaw.mockResolvedValue([{ rows_deleted: 0 }]);

    const req = createRequest({ retentionDays: 730 }, VALID_OP_TOKEN);
    await POST(req);

    const cutoff = mockQueryRaw.mock.calls[0][2] as Date;
    const expected730 = new Date(Date.now() - 730 * MS_PER_DAY);
    expect(Math.abs(cutoff.getTime() - expected730.getTime())).toBeLessThan(5000);
  });

  // ─── Retention = keep forever (C4-S1) ─────────────────────

  it("rejects with 409 AUDIT_LOG_RETENTION_INDEFINITE when tenant retention is NULL, and issues no purge", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockTenantFindUnique.mockResolvedValue({ auditLogRetentionDays: null });

    const req = createRequest({}, VALID_OP_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.error).toBe("AUDIT_LOG_RETENTION_INDEFINITE");

    // RT8: denial AND no mutation — audit_log_purge() must never be called.
    expect(mockQueryRaw).not.toHaveBeenCalled();
    expect(mockDeleteMany).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("rejects with 409 on dryRun too when tenant retention is NULL, and does not count matches", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockTenantFindUnique.mockResolvedValue({ auditLogRetentionDays: null });

    const req = createRequest({ dryRun: true }, VALID_OP_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.error).toBe("AUDIT_LOG_RETENTION_INDEFINITE");
    expect(mockCount).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  // ─── Dry Run ──────────────────────────────────────────────

  it("returns matched count without deleting when dryRun is true", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockTenantFindUnique.mockResolvedValue({ auditLogRetentionDays: 365 });
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
    expect(mockCount.mock.calls[0][0].where.tenantId).toBe(TENANT_ID);
  });

  it("dry run respects tenant retention floor for count", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockTenantFindUnique.mockResolvedValue({ auditLogRetentionDays: 730 });
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
    mockTenantFindUnique.mockResolvedValue({ auditLogRetentionDays: 365 });
    mockDeleteMany.mockResolvedValueOnce({ count: 5 });
    mockQueryRaw.mockResolvedValueOnce([{ rows_deleted: 5 }]);

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
          scopedTenantId: TENANT_ID,
        }),
      }),
    );

    // Strict shape: legacy / mis-implying fields must not appear
    const metadata = mockLogAudit.mock.calls[0][0].metadata;
    expect(metadata.operatorId).toBeUndefined();
    expect(metadata.authPath).toBeUndefined();
    expect(metadata.systemWide).toBeUndefined();
  });

  it("emits audit with dryRun metadata on dryRun", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockTenantFindUnique.mockResolvedValue({ auditLogRetentionDays: 365 });
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
          scopedTenantId: TENANT_ID,
          dryRun: true,
          targetTable: "auditLog",
        }),
      }),
    );

    const metadata = mockLogAudit.mock.calls[0][0].metadata;
    expect(metadata.operatorId).toBeUndefined();
    expect(metadata.authPath).toBeUndefined();
    expect(metadata.systemWide).toBeUndefined();
  });

  // ─── Tenant Isolation ─────────────────────────────────────

  it("a tenant-A operator token cannot delete tenant-B audit logs", async () => {
    const TENANT_A = "550e8400-e29b-41d4-a716-44665544000a";
    mockVerifyAdminToken.mockResolvedValue({
      ok: true,
      auth: { ...VALID_AUTH, tenantId: TENANT_A },
    });
    mockRequireMaintenanceOperator.mockResolvedValue({
      ok: true,
      operator: { tenantId: TENANT_A, role: "ADMIN" },
    });
    mockTenantFindUnique.mockResolvedValue({ auditLogRetentionDays: 365 });
    mockDeleteMany.mockResolvedValueOnce({ count: 0 });
    mockQueryRaw.mockResolvedValueOnce([{ rows_deleted: 0 }]);

    const req = createRequest({}, VALID_OP_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(200);

    // Tenant lookup must use auth.tenantId; deleteMany must be filtered to it.
    expect(mockTenantFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: TENANT_A } }),
    );
    // C13: real purge uses $queryRaw(audit_log_purge) now; deleteMany is not called.
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    expect(mockQueryRaw.mock.calls[0][1]).toBe(TENANT_A);
  });
});
