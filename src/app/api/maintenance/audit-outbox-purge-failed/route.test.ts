import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockVerifyAdminToken,
  mockQueryRaw,
  mockRequireMaintenanceOperator,
  mockCheck,
  mockLogAudit,
  mockWithBypassRls,
} = vi.hoisted(() => ({
  mockVerifyAdminToken: vi.fn(),
  mockQueryRaw: vi.fn(),
  mockRequireMaintenanceOperator: vi.fn(),
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
    $queryRaw: mockQueryRaw,
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
import { OPERATOR_TOKEN_PREFIX } from "@/lib/constants/auth/operator-token";

const SUBJECT_USER_ID = "660e8400-e29b-41d4-a716-446655440001";
const TOKEN_ID = "op-token-id-1";
const TENANT_ID = "550e8400-e29b-41d4-a716-446655440001";
const FILTER_TENANT_ID = "550e8400-e29b-41d4-a716-446655440002";

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
  return new NextRequest("http://localhost/api/maintenance/audit-outbox-purge-failed", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/maintenance/audit-outbox-purge-failed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheck.mockResolvedValue({ allowed: true });
    mockVerifyAdminToken.mockResolvedValue({ ok: false, reason: "MISSING_OR_MALFORMED" });
    mockRequireMaintenanceOperator.mockResolvedValue({
      ok: true,
      operator: { tenantId: TENANT_ID, role: "ADMIN" },
    });
    mockQueryRaw.mockResolvedValue([{ purged: BigInt(0) }]);
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

  it("empty body purges all FAILED rows and returns purged count", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockQueryRaw.mockResolvedValue([{ purged: BigInt(12) }]);

    const req = createRequest({}, VALID_OP_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.purged).toBe(12);
  });

  it("returns purged=0 when no FAILED rows match", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockQueryRaw.mockResolvedValue([{ purged: BigInt(0) }]);

    const req = createRequest({}, VALID_OP_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.purged).toBe(0);
  });

  it("accepts body.tenantId only when it matches the auth token's tenantId", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockQueryRaw.mockResolvedValue([{ purged: BigInt(4) }]);

    const req = createRequest({ tenantId: TENANT_ID }, VALID_OP_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.purged).toBe(4);
  });

  it("rejects body.tenantId that does not match the auth token's tenantId with 403", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });

    const req = createRequest({ tenantId: FILTER_TENANT_ID }, VALID_OP_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(403);

    // Cross-tenant attempts must NOT reach the delete query or audit log.
    expect(mockQueryRaw).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("accepts body with olderThanDays filter and returns 200", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockQueryRaw.mockResolvedValue([{ purged: BigInt(2) }]);

    const req = createRequest({ olderThanDays: 30 }, VALID_OP_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.purged).toBe(2);
  });

  it("accepts body with matching tenantId and olderThanDays filters and returns 200", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockQueryRaw.mockResolvedValue([{ purged: BigInt(1) }]);

    const req = createRequest({ tenantId: TENANT_ID, olderThanDays: 7 }, VALID_OP_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.purged).toBe(1);
  });

  // ─── Audit ────────────────────────────────────────────────

  it("logs audit with HUMAN actorType and filter metadata on successful purge", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockQueryRaw.mockResolvedValue([{ purged: BigInt(6) }]);

    const req = createRequest({ tenantId: TENANT_ID, olderThanDays: 14 }, VALID_OP_TOKEN);
    await POST(req);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "TENANT",
        action: "AUDIT_OUTBOX_PURGE_EXECUTED",
        userId: SUBJECT_USER_ID,
        actorType: "HUMAN",
        tenantId: TENANT_ID,
        metadata: expect.objectContaining({
          tokenSubjectUserId: SUBJECT_USER_ID,
          tokenId: TOKEN_ID,
          purgedCount: 6,
          scopedTenantId: TENANT_ID,
          olderThanDays: 14,
        }),
      }),
    );

    // Strict shape: legacy / mis-implying fields must not appear
    const metadata = mockLogAudit.mock.calls[0][0].metadata;
    expect(metadata.operatorId).toBeUndefined();
    expect(metadata.authPath).toBeUndefined();
    expect(metadata.filterTenantId).toBeUndefined();
  });

  it("logs audit with scopedTenantId when no body filters provided", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockQueryRaw.mockResolvedValue([{ purged: BigInt(0) }]);

    const req = createRequest({}, VALID_OP_TOKEN);
    await POST(req);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          scopedTenantId: TENANT_ID,
          olderThanDays: null,
        }),
      }),
    );
  });

  // ─── Tenant Isolation ─────────────────────────────────────

  it("a tenant-A operator token cannot purge another tenant's FAILED rows even via empty body", async () => {
    const TENANT_A = "550e8400-e29b-41d4-a716-44665544000a";
    mockVerifyAdminToken.mockResolvedValue({
      ok: true,
      auth: { ...VALID_AUTH, tenantId: TENANT_A },
    });
    mockRequireMaintenanceOperator.mockResolvedValue({
      ok: true,
      operator: { tenantId: TENANT_A, role: "ADMIN" },
    });
    mockQueryRaw.mockResolvedValue([{ purged: BigInt(0) }]);

    const req = createRequest({}, VALID_OP_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(200);

    // The raw SQL DELETE must be parameterized with TENANT_A as the tenant
    // filter — never null/all-tenant. Inspect the tagged template values.
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    const queryArgs = mockQueryRaw.mock.calls[0];
    // Tagged template: [strings, ...values]
    expect(queryArgs.slice(1)).toContain(TENANT_A);
  });
});
