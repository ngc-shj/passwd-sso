import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OPERATOR_TOKEN_PREFIX } from "@/lib/constants/auth/operator-token";

const VALID_OP_TOKEN = `${OPERATOR_TOKEN_PREFIX}${"a".repeat(43)}`;

const {
  mockVerifyAdminToken,
  mockCreate,
  mockTenantMemberFindMany,
  mockRequireMaintenanceOperator,
  mockCheckRateLimitOrFail,
  mockLogAudit,
  mockGetCurrentMasterKeyVersion,
  mockGetMasterKeyByVersion,
  mockCreateNotification,
} = vi.hoisted(() => ({
  mockVerifyAdminToken: vi.fn(),
  mockCreate: vi.fn(),
  mockTenantMemberFindMany: vi.fn(),
  mockRequireMaintenanceOperator: vi.fn(),
  mockCheckRateLimitOrFail: vi.fn().mockResolvedValue(null),
  mockLogAudit: vi.fn(),
  mockGetCurrentMasterKeyVersion: vi.fn(),
  mockGetMasterKeyByVersion: vi.fn(),
  mockCreateNotification: vi.fn(),
}));

vi.mock("@/lib/auth/tokens/admin-token", () => ({ verifyAdminToken: mockVerifyAdminToken }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    masterKeyRotation: { create: mockCreate },
    tenantMember: { findMany: mockTenantMemberFindMany },
  },
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({ check: vi.fn().mockResolvedValue({ allowed: true }) }),
}));
vi.mock("@/lib/security/rate-limit-audit", () => ({
  checkRateLimitOrFail: mockCheckRateLimitOrFail,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  tenantAuditBase: (_req: unknown, userId: string, tenantId: string) => ({
    scope: "TENANT",
    userId,
    tenantId,
    ip: "10.0.0.1",
    userAgent: "Test",
  }),
}));
vi.mock("@/lib/crypto/crypto-server", () => ({
  getCurrentMasterKeyVersion: mockGetCurrentMasterKeyVersion,
  getMasterKeyByVersion: mockGetMasterKeyByVersion,
}));
vi.mock("@/lib/tenant-rls", () => ({
  withTenantRls: async (_p: unknown, _t: unknown, fn: (tx: unknown) => unknown) =>
    fn({
      masterKeyRotation: { create: mockCreate },
      tenantMember: { findMany: mockTenantMemberFindMany },
    }),
  withBypassRls: async (_p: unknown, fn: (tx: unknown) => unknown) => fn({}),
  BYPASS_PURPOSE: { SYSTEM_MAINTENANCE: "system_maintenance", CROSS_TENANT_LOOKUP: "cross_tenant_lookup" },
}));
vi.mock("@/lib/auth/access/maintenance-auth", () => ({
  requireMaintenanceOperator: mockRequireMaintenanceOperator,
}));
vi.mock("@/lib/notification", () => ({ createNotification: mockCreateNotification }));
vi.mock("@/lib/locale", () => ({ resolveUserLocale: (l: string | null) => l ?? "en" }));
vi.mock("@/lib/logger", () => ({
  default: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { POST } from "./route";

const TENANT = "11111111-1111-1111-1111-111111111111";
const SUBJECT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/admin/rotate-master-key/initiate", {
    method: "POST",
    headers: { authorization: `Bearer ${VALID_OP_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/admin/rotate-master-key/initiate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimitOrFail.mockResolvedValue(null);
    mockGetCurrentMasterKeyVersion.mockReturnValue(2);
    mockGetMasterKeyByVersion.mockReturnValue("hexkey");
    mockRequireMaintenanceOperator.mockResolvedValue({ ok: true });
    mockTenantMemberFindMany.mockResolvedValue([]);
    mockVerifyAdminToken.mockResolvedValue({
      ok: true,
      auth: { subjectUserId: SUBJECT, tenantId: TENANT, tokenId: "tok-1", scopes: ["MAINTENANCE"] },
    });
    mockCreate.mockResolvedValue({
      id: "rot-1",
      targetVersion: 2,
      expiresAt: new Date("2026-05-24T10:00:00Z"),
    });
  });

  it("returns 401 when verifyAdminToken rejects", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: false, reason: "MISSING_OR_MALFORMED" });
    const res = await POST(makeRequest({ targetVersion: 2 }));
    expect(res.status).toBe(401);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limit exhausted", async () => {
    const { NextResponse } = await import("next/server");
    mockCheckRateLimitOrFail.mockResolvedValueOnce(
      NextResponse.json({ error: "RATE_LIMIT_EXCEEDED" }, { status: 429 }),
    );
    const res = await POST(makeRequest({ targetVersion: 2 }));
    expect(res.status).toBe(429);
  });

  // redisErrored fail-closed: when the rate-limiter signals Redis is down,
  // the route MUST surface a 503 (not 429) so operators can distinguish
  // backend-down from over-budget. The route delegates to
  // checkRateLimitOrFail which owns the emit + envelope.
  describe("redisErrored fail-closed (rate-limiter Redis unavailable)", () => {
    it("returns 503 when checkRateLimitOrFail hands back the canonical 503 envelope", async () => {
      const { NextResponse } = await import("next/server");
      mockCheckRateLimitOrFail.mockResolvedValueOnce(
        NextResponse.json(
          { error: "RATE_LIMITER_UNAVAILABLE" },
          { status: 503, headers: { "Retry-After": "30" } },
        ),
      );
      const res = await POST(makeRequest({ targetVersion: 2 }));
      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBe("30");
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  it("returns 400 when targetVersion mismatches current configured version", async () => {
    mockGetCurrentMasterKeyVersion.mockReturnValue(3);
    const res = await POST(makeRequest({ targetVersion: 2 }));
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns 400 when getMasterKeyByVersion throws (missing env)", async () => {
    mockGetMasterKeyByVersion.mockImplementation(() => {
      throw new Error("not configured");
    });
    const res = await POST(makeRequest({ targetVersion: 2 }));
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns 403 when maintenance scope check fails", async () => {
    const forbid = new Response(null, { status: 403 });
    mockRequireMaintenanceOperator.mockResolvedValue({ ok: false, response: forbid });
    const res = await POST(makeRequest({ targetVersion: 2 }));
    expect(res.status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns 201 with rotationId on happy path and emits INITIATE audit", async () => {
    const res = await POST(makeRequest({ targetVersion: 2, reason: "compromise response" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.rotationId).toBe("rot-1");
    expect(body.status).toBe("pending");
    expect(body.targetVersion).toBe(2);
    expect(body.expiresAt).toBeTruthy();

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const createArg = mockCreate.mock.calls[0][0];
    expect(createArg.data.tenantId).toBe(TENANT);
    expect(createArg.data.initiatedById).toBe(SUBJECT);
    expect(createArg.data.targetVersion).toBe(2);
    expect(createArg.data.revokeShares).toBe(true);
    expect(createArg.data.reason).toBe("compromise response");

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "MASTER_KEY_ROTATION_INITIATE",
        metadata: expect.objectContaining({
          rotationId: "rot-1",
          targetVersion: 2,
          revokeShares: true,
          shareRevocationSkipped: false,
        }),
      }),
    );
  });

  it("flags shareRevocationSkipped when revokeShares=false", async () => {
    await POST(makeRequest({ targetVersion: 2, revokeShares: false }));
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ shareRevocationSkipped: true }),
      }),
    );
  });

  it("notifies every active OWNER/ADMIN excluding the initiator", async () => {
    mockTenantMemberFindMany.mockResolvedValue([
      { userId: "bob", user: { locale: "en" } },
      { userId: "carol", user: { locale: "ja" } },
    ]);
    await POST(makeRequest({ targetVersion: 2 }));
    expect(mockTenantMemberFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: TENANT,
          deactivatedAt: null,
          userId: { not: SUBJECT },
          role: { in: ["OWNER", "ADMIN"] },
        }),
      }),
    );
    expect(mockCreateNotification).toHaveBeenCalledTimes(2);
    const calls = mockCreateNotification.mock.calls.map((c) => c[0].userId);
    expect(calls).toContain("bob");
    expect(calls).toContain("carol");
    expect(calls).not.toContain(SUBJECT);
  });

  it("succeeds even when the tenant has no other OWNER/ADMIN (single-operator)", async () => {
    mockTenantMemberFindMany.mockResolvedValue([]);
    const res = await POST(makeRequest({ targetVersion: 2 }));
    expect(res.status).toBe(201);
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it("rejects unknown body fields (.strict())", async () => {
    const res = await POST(makeRequest({ targetVersion: 2, extra: "nope" }));
    expect(res.status).toBe(400);
  });

  it("rejects reason longer than 500 chars", async () => {
    const res = await POST(
      makeRequest({ targetVersion: 2, reason: "x".repeat(501) }),
    );
    expect(res.status).toBe(400);
  });

  // T11-FU: notification recipient-enumeration failure (tenantMember.findMany
  // rejects) must NOT fail the initiate response. The route's try/catch must
  // log a warn and proceed with the 201 — the rotation row was already
  // created. A regression that removes the try/catch would silently break
  // R9 fire-and-forget-after-create contract.
  it("returns 201 even when recipient enumeration fails (tenantMember.findMany rejects)", async () => {
    mockTenantMemberFindMany.mockRejectedValueOnce(new Error("rls denied"));
    const res = await POST(makeRequest({ targetVersion: 2 }));
    expect(res.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });
});
