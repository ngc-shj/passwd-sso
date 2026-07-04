import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockVerifyAdminToken,
  mockDeleteMany,
  mockCount,
  mockTenantFindUnique,
  mockRequireMaintenanceOperator,
  mockCheck,
  mockLogAudit,
  mockWithBypassRls,
} = vi.hoisted(() => ({
  mockVerifyAdminToken: vi.fn(),
  mockDeleteMany: vi.fn(),
  mockCount: vi.fn(),
  mockTenantFindUnique: vi.fn(),
  mockRequireMaintenanceOperator: vi.fn(),
  mockCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockLogAudit: vi.fn(),
  mockWithBypassRls: vi.fn(
    async (prisma: unknown, fn: (tx: unknown) => unknown, _purpose?: unknown) => fn(prisma),
  ),
}));

vi.mock("@/lib/auth/tokens/admin-token", () => ({
  verifyAdminToken: mockVerifyAdminToken,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordEntryHistory: { deleteMany: mockDeleteMany, count: mockCount },
    tenant: { findUnique: mockTenantFindUnique },
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
  return new NextRequest("http://localhost/api/maintenance/purge-history", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/maintenance/purge-history", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheck.mockResolvedValue({ allowed: true });
    mockVerifyAdminToken.mockResolvedValue({ ok: false, reason: "MISSING_OR_MALFORMED" });
    mockRequireMaintenanceOperator.mockResolvedValue({
      ok: true,
      operator: { tenantId: TENANT_ID, role: "ADMIN" },
    });
    // Default: a non-null tenant retention of 1 day so existing cutoff-date
    // cases exercise the normal path with no clamp (max(requested, 1) ===
    // requested). RETENTION_INDEFINITE / clamp cases override this.
    mockTenantFindUnique.mockResolvedValue({ historyRetentionDays: 1 });
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

  it("returns 503 when the rate limiter fails closed on a Redis error", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockCheck.mockResolvedValue({ redisErrored: true });
    const req = createRequest({}, VALID_OP_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(503);
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  it("keys the rate limiter on the operator-token's tenantId (tenant-scoped, exact key)", async () => {
    // #629 headline property: the maintenance rate-limit key is tenant-scoped
    // so one tenant's operator cannot 429 another tenant's purge. A regression
    // that drops `${auth.tenantId}` (global key) or swaps in subjectUserId
    // would still pass the 429/503 behavior tests — only an exact-key assertion
    // on the discriminator segment catches it.
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockDeleteMany.mockResolvedValue({ count: 0 });

    const req = createRequest({}, VALID_OP_TOKEN);
    await POST(req);

    expect(mockCheck).toHaveBeenCalledWith(`rl:maintenance:purge-history:${TENANT_ID}`);
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

  it("purges history entries and returns count", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockDeleteMany.mockResolvedValue({ count: 42 });

    const req = createRequest({}, VALID_OP_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.purged).toBe(42);
  });

  it("scopes deletion to the operator-token's tenantId only", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockDeleteMany.mockResolvedValue({ count: 0 });

    const req = createRequest({}, VALID_OP_TOKEN);
    await POST(req);

    const where = mockDeleteMany.mock.calls[0][0].where;
    expect(where).not.toHaveProperty("entry");
    expect(where).toHaveProperty("changedAt");
    expect(where).toHaveProperty("tenantId", TENANT_ID);
  });

  it("scopes dryRun count to the operator-token's tenantId only", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockCount.mockResolvedValue(7);

    const req = createRequest({ dryRun: true }, VALID_OP_TOKEN);
    await POST(req);

    const where = mockCount.mock.calls[0][0].where;
    expect(where).toHaveProperty("tenantId", TENANT_ID);
  });

  it("uses default retentionDays of 90", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockDeleteMany.mockResolvedValue({ count: 0 });

    const req = createRequest({}, VALID_OP_TOKEN);
    await POST(req);

    const cutoff = mockDeleteMany.mock.calls[0][0].where.changedAt.lt as Date;
    const expectedDate = new Date(Date.now() - 90 * MS_PER_DAY);
    expect(Math.abs(cutoff.getTime() - expectedDate.getTime())).toBeLessThan(5000);
  });

  it("respects custom retentionDays parameter", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockDeleteMany.mockResolvedValue({ count: 10 });

    const req = createRequest({ retentionDays: 30 }, VALID_OP_TOKEN);
    await POST(req);

    const cutoff = mockDeleteMany.mock.calls[0][0].where.changedAt.lt as Date;
    const expectedDate = new Date(Date.now() - 30 * MS_PER_DAY);
    expect(Math.abs(cutoff.getTime() - expectedDate.getTime())).toBeLessThan(5000);
  });

  // ─── Tenant retention floor (C4-S1 lateral fix) ───────────

  it("respects tenant-level retention floor: uses max(requested, tenantRetention)", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockDeleteMany.mockResolvedValue({ count: 3 });
    // Tenant floor 730d exceeds the requested 30d — the stricter (longer) wins.
    mockTenantFindUnique.mockResolvedValue({ historyRetentionDays: 730 });

    const req = createRequest({ retentionDays: 30 }, VALID_OP_TOKEN);
    await POST(req);

    const cutoff = mockDeleteMany.mock.calls[0][0].where.changedAt.lt as Date;
    const expectedDate = new Date(Date.now() - 730 * MS_PER_DAY);
    expect(Math.abs(cutoff.getTime() - expectedDate.getTime())).toBeLessThan(5000);
  });

  it("treats a tenant floor of 0 as a real floor (not 'no floor'): clamps to max(requested, 0)", async () => {
    // Regression for the retention-floor bypass: a truthy check on
    // historyRetentionDays would treat 0 as falsy and fall back to the raw
    // requested retentionDays. With the floor helper, max(90, 0) === 90 is
    // applied — 0 does not short-circuit to an unfloored purge.
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockDeleteMany.mockResolvedValue({ count: 2 });
    mockTenantFindUnique.mockResolvedValue({ historyRetentionDays: 0 });

    const req = createRequest({ retentionDays: 90 }, VALID_OP_TOKEN);
    await POST(req);

    const cutoff = mockDeleteMany.mock.calls[0][0].where.changedAt.lt as Date;
    const expectedDate = new Date(Date.now() - 90 * MS_PER_DAY);
    expect(Math.abs(cutoff.getTime() - expectedDate.getTime())).toBeLessThan(5000);
  });

  it("rejects with 409 HISTORY_RETENTION_INDEFINITE when tenant retention is NULL, and issues no purge", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockTenantFindUnique.mockResolvedValue({ historyRetentionDays: null });

    const req = createRequest({}, VALID_OP_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.error).toBe("HISTORY_RETENTION_INDEFINITE");

    // RT8: denial AND no mutation — deleteMany must never be called.
    expect(mockDeleteMany).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("returns 0 and issues no purge when the bound tenant no longer exists", async () => {
    // Mirror of purge-audit-logs's "tenant no longer exists" case: a null
    // tenant lookup must no-op, NOT fall through to an unfloored delete with
    // the raw request retentionDays.
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockTenantFindUnique.mockResolvedValue(null);

    const req = createRequest({ retentionDays: 1 }, VALID_OP_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ purged: 0 });

    expect(mockDeleteMany).not.toHaveBeenCalled();
    expect(mockCount).not.toHaveBeenCalled();
  });

  it("rejects with 409 on dryRun too when tenant retention is NULL, and does not count matches", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockTenantFindUnique.mockResolvedValue({ historyRetentionDays: null });

    const req = createRequest({ dryRun: true }, VALID_OP_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.error).toBe("HISTORY_RETENTION_INDEFINITE");
    expect(mockCount).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  // ─── Dry Run ──────────────────────────────────────────────

  it("returns matched count without deleting when dryRun is true", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockCount.mockResolvedValue(15);

    const req = createRequest({ dryRun: true }, VALID_OP_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.purged).toBe(0);
    expect(body.matched).toBe(15);
    expect(body.dryRun).toBe(true);

    expect(mockDeleteMany).not.toHaveBeenCalled();
    expect(mockCount).toHaveBeenCalled();

    const cutoff = mockCount.mock.calls[0][0].where.changedAt.lt as Date;
    const expectedDate = new Date(Date.now() - 90 * MS_PER_DAY);
    expect(Math.abs(cutoff.getTime() - expectedDate.getTime())).toBeLessThan(5000);
  });

  // ─── Audit ────────────────────────────────────────────────

  it("logs audit with HUMAN actorType and token fields on successful purge", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockDeleteMany.mockResolvedValue({ count: 5 });

    const req = createRequest({}, VALID_OP_TOKEN);
    await POST(req);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "TENANT",
        action: "HISTORY_PURGE",
        userId: SUBJECT_USER_ID,
        actorType: "HUMAN",
        tenantId: TENANT_ID,
        metadata: expect.objectContaining({
          tokenSubjectUserId: SUBJECT_USER_ID,
          tokenId: TOKEN_ID,
          purgedCount: 5,
          retentionDays: 90,
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
    mockCount.mockResolvedValue(3);

    const req = createRequest({ dryRun: true }, VALID_OP_TOKEN);
    await POST(req);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "TENANT",
        action: "HISTORY_PURGE",
        actorType: "HUMAN",
        metadata: expect.objectContaining({
          tokenSubjectUserId: SUBJECT_USER_ID,
          tokenId: TOKEN_ID,
          purgedCount: 0,
          matched: 3,
          retentionDays: 90,
          scopedTenantId: TENANT_ID,
          dryRun: true,
        }),
      }),
    );

    const metadata = mockLogAudit.mock.calls[0][0].metadata;
    expect(metadata.operatorId).toBeUndefined();
    expect(metadata.authPath).toBeUndefined();
    expect(metadata.systemWide).toBeUndefined();
  });

  // ─── Tenant Isolation ─────────────────────────────────────

  it("a tenant-A operator token cannot delete tenant-B history rows", async () => {
    const TENANT_A = "550e8400-e29b-41d4-a716-44665544000a";
    mockVerifyAdminToken.mockResolvedValue({
      ok: true,
      auth: { ...VALID_AUTH, tenantId: TENANT_A },
    });
    mockRequireMaintenanceOperator.mockResolvedValue({
      ok: true,
      operator: { tenantId: TENANT_A, role: "ADMIN" },
    });
    mockDeleteMany.mockResolvedValue({ count: 0 });

    const req = createRequest({}, VALID_OP_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(200);

    // The deleteMany must include tenantId = TENANT_A. Without that, a
    // tenant-A admin's token would erase history rows in every tenant.
    const where = mockDeleteMany.mock.calls[0][0].where;
    expect(where.tenantId).toBe(TENANT_A);
  });
});
