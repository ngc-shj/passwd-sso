import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OPERATOR_TOKEN_PREFIX } from "@/lib/constants/auth/operator-token";

const VALID_OP_TOKEN = `${OPERATOR_TOKEN_PREFIX}${"a".repeat(43)}`;

const {
  mockVerifyAdminToken,
  mockFindFirst,
  mockUpdateMany,
  mockUpdate,
  mockShareUpdateMany,
  mockRequireMaintenanceOperator,
  mockCheckRateLimitOrFail,
  mockLogAudit,
  mockGetCurrentMasterKeyVersion,
  mockGetMasterKeyByVersion,
} = vi.hoisted(() => ({
  mockVerifyAdminToken: vi.fn(),
  mockFindFirst: vi.fn(),
  mockUpdateMany: vi.fn(),
  mockUpdate: vi.fn(),
  mockShareUpdateMany: vi.fn(),
  mockRequireMaintenanceOperator: vi.fn(),
  mockCheckRateLimitOrFail: vi.fn().mockResolvedValue(null),
  mockLogAudit: vi.fn(),
  mockGetCurrentMasterKeyVersion: vi.fn(),
  mockGetMasterKeyByVersion: vi.fn(),
}));

vi.mock("@/lib/auth/tokens/admin-token", () => ({ verifyAdminToken: mockVerifyAdminToken }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    masterKeyRotation: { findFirst: mockFindFirst, updateMany: mockUpdateMany, update: mockUpdate },
    passwordShare: { updateMany: mockShareUpdateMany },
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
      masterKeyRotation: { findFirst: mockFindFirst, updateMany: mockUpdateMany, update: mockUpdate },
    }),
  withBypassRls: async (_p: unknown, fn: (tx: unknown) => unknown) =>
    fn({ passwordShare: { updateMany: mockShareUpdateMany } }),
  BYPASS_PURPOSE: { SYSTEM_MAINTENANCE: "system_maintenance" },
}));
vi.mock("@/lib/auth/access/maintenance-auth", () => ({
  requireMaintenanceOperator: mockRequireMaintenanceOperator,
}));
vi.mock("@/lib/logger", () => ({
  default: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { POST } from "./route";

const TENANT = "11111111-1111-1111-1111-111111111111";
const ALICE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ROTATION_ID = "11111111-2222-3333-4444-555555555555";

const APPROVED_ROW = {
  id: ROTATION_ID,
  tenantId: TENANT,
  initiatedById: ALICE,
  initiatedAt: new Date("2026-05-23T09:00:00Z"),
  targetVersion: 2,
  revokeShares: true,
  approvedById: BOB,
  approvedAt: new Date("2026-05-23T09:05:00Z"),
  executedAt: null,
  executedById: null,
  expiresAt: new Date("2026-05-23T10:05:00Z"),
  revokedAt: null,
  revokedById: null,
  reason: null,
  revokedShares: null,
  createdAt: new Date("2026-05-23T09:00:00Z"),
};

function makeRequest(): NextRequest {
  return new NextRequest(
    `http://localhost/api/admin/rotate-master-key/${ROTATION_ID}/execute`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${VALID_OP_TOKEN}` },
    },
  );
}

describe("POST /api/admin/rotate-master-key/[rotationId]/execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimitOrFail.mockResolvedValue(null);
    mockRequireMaintenanceOperator.mockResolvedValue({ ok: true });
    mockGetCurrentMasterKeyVersion.mockReturnValue(2);
    mockGetMasterKeyByVersion.mockReturnValue("hexkey");
    mockVerifyAdminToken.mockResolvedValue({
      ok: true,
      auth: { subjectUserId: ALICE, tenantId: TENANT, tokenId: "tok-1", scopes: ["MAINTENANCE"] },
    });
    mockFindFirst.mockResolvedValue(APPROVED_ROW);
    mockUpdateMany.mockResolvedValue({ count: 1 });
    mockUpdate.mockResolvedValue(APPROVED_ROW);
    mockShareUpdateMany.mockResolvedValue({ count: 7 });
  });

  const callPOST = () =>
    POST(makeRequest(), { params: Promise.resolve({ rotationId: ROTATION_ID }) });

  it("returns 401 when auth fails", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: false, reason: "INVALID" });
    const res = await callPOST();
    expect(res.status).toBe(401);
  });

  it("returns 404 when rotation not found", async () => {
    mockFindFirst.mockResolvedValue(null);
    const res = await callPOST();
    expect(res.status).toBe(404);
    expect(mockShareUpdateMany).not.toHaveBeenCalled();
  });

  it("returns 409 (NOT_EXECUTABLE) when row is not yet approved", async () => {
    mockFindFirst.mockResolvedValue({ ...APPROVED_ROW, approvedAt: null });
    const res = await callPOST();
    expect(res.status).toBe(409);
    expect(mockShareUpdateMany).not.toHaveBeenCalled();
  });

  it("returns 400 when targetVersion no longer matches current env", async () => {
    mockGetCurrentMasterKeyVersion.mockReturnValue(3);
    const res = await callPOST();
    expect(res.status).toBe(400);
    expect(mockShareUpdateMany).not.toHaveBeenCalled();
  });

  it("returns 400 when getMasterKeyByVersion throws (env reconfigured)", async () => {
    mockGetMasterKeyByVersion.mockImplementation(() => {
      throw new Error("missing");
    });
    const res = await callPOST();
    expect(res.status).toBe(400);
    expect(mockShareUpdateMany).not.toHaveBeenCalled();
  });

  it("returns 409 + does not revoke shares when CAS count===0", async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });
    const res = await callPOST();
    expect(res.status).toBe(409);
    expect(mockShareUpdateMany).not.toHaveBeenCalled();
  });

  it("returns 200; CAS WHERE includes load-bearing state-machine guards", async () => {
    const res = await callPOST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("executed");
    expect(body.revokedShares).toBe(7);

    // T11: exact-key-set assertion to catch CAS WHERE drift.
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    const callArg = mockUpdateMany.mock.calls[0][0];
    expect(Object.keys(callArg.where).sort()).toEqual(
      [
        "approvedAt",
        "executedAt",
        "expiresAt",
        "id",
        "revokedAt",
        "tenantId",
      ].sort(),
    );
    expect(callArg.where).toMatchObject({
      id: ROTATION_ID,
      tenantId: TENANT,
      approvedAt: { not: null },
      executedAt: null,
      revokedAt: null,
    });
    expect(callArg.where.expiresAt).toMatchObject({ gt: expect.any(Date) });

    expect(mockShareUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "MASTER_KEY_ROTATION_EXECUTE",
        metadata: expect.objectContaining({
          rotationId: ROTATION_ID,
          targetVersion: 2,
          revokedShares: 7,
        }),
      }),
    );
  });

  it("skips share revocation when row.revokeShares is false", async () => {
    mockFindFirst.mockResolvedValue({ ...APPROVED_ROW, revokeShares: false });
    const res = await callPOST();
    expect(res.status).toBe(200);
    expect(mockShareUpdateMany).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          revokedShares: 0,
          shareRevocationSkipped: true,
        }),
      }),
    );
  });

  describe("redisErrored fail-closed (rate-limiter Redis unavailable)", () => {
    it("returns 503 without writing PasswordShare", async () => {
      const { NextResponse } = await import("next/server");
      mockCheckRateLimitOrFail.mockResolvedValueOnce(
        NextResponse.json(
          { error: "RATE_LIMITER_UNAVAILABLE" },
          { status: 503, headers: { "Retry-After": "30" } },
        ),
      );
      const res = await callPOST();
      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBe("30");
      expect(mockShareUpdateMany).not.toHaveBeenCalled();
      expect(mockUpdateMany).not.toHaveBeenCalled();
    });
  });

  // T-CT: cross-tenant branch — actor in tenant B, row in tenant A. Even
  // though RLS would normally filter the row at findFirst, this test
  // explicitly returns it (defense-in-depth path) to verify the eligibility
  // helper emits the forensic audit + 403.
  it("returns 403 + FORBIDDEN_CROSS_TENANT audit when actor.tenantId !== row.tenantId", async () => {
    const TENANT_B = "22222222-2222-2222-2222-222222222222";
    mockVerifyAdminToken.mockResolvedValue({
      ok: true,
      auth: { subjectUserId: ALICE, tenantId: TENANT_B, tokenId: "tok-1", scopes: ["MAINTENANCE"] },
    });
    // Row is in TENANT (T1); actor authed in TENANT_B (T2).
    mockFindFirst.mockResolvedValue(APPROVED_ROW);
    const res = await callPOST();
    expect(res.status).toBe(403);
    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(mockShareUpdateMany).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "MASTER_KEY_ROTATION_EXECUTE",
        metadata: expect.objectContaining({ cause: "FORBIDDEN_CROSS_TENANT" }),
      }),
    );
  });

  // T-EX-UP: assert that the post-revocation row update is called with
  // exactly the revokedShares count from the share-revocation step.
  it("records revokedShares on the rotation row after successful execute", async () => {
    await callPOST();
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: ROTATION_ID },
      data: { revokedShares: 7 },
    });
  });

  // S2: if passwordShare.updateMany throws AFTER the CAS commits, the route
  // MUST still emit MASTER_KEY_ROTATION_EXECUTE audit (with shareRevocationError
  // metadata) and return INTERNAL_ERROR telling the client the operation was
  // partial.
  it("emits EXECUTE audit + returns INTERNAL_ERROR when share-revocation throws after CAS commit", async () => {
    mockShareUpdateMany.mockRejectedValueOnce(new Error("transient db error"));
    const res = await callPOST();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("INTERNAL_ERROR");
    expect(mockUpdateMany).toHaveBeenCalledTimes(1); // CAS still committed
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "MASTER_KEY_ROTATION_EXECUTE",
        metadata: expect.objectContaining({
          rotationId: ROTATION_ID,
          revokedShares: 0,
          shareRevocationError: expect.stringContaining("transient db error"),
        }),
      }),
    );
  });
});
