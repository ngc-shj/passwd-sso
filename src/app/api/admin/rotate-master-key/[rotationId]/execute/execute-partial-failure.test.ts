/**
 * Unit test: master-key rotation execute partial-failure (C9b,
 * security-control-verification plan, VE2).
 *
 * Real-DB fault injection for a mid-transaction passwordShare.updateMany
 * failure would require a fault seam (statement_timeout / revoked-permission
 * role) that distorts the code path (VE2). This branch is pinned at unit
 * level with a mocked share-revocation step, matching the existing mock-test
 * idiom for this route (see ./route.test.ts). The CAS-committed-first
 * ordering is separately asserted against the real DB in
 * master-key-rotation-races.integration.test.ts's C9a double-execute case.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockVerifyAdminToken,
  mockFindFirst,
  mockUpdateMany,
  mockUpdate,
  mockShareUpdateMany,
  mockRequireMaintenanceOperator,
  mockRateLimitCheck,
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
  mockRateLimitCheck: vi.fn(),
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
  createRateLimiter: () => ({ check: mockRateLimitCheck, clear: vi.fn() }),
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  tenantAuditBase: (_req: unknown, userId: string, tenantId: string) => ({
    scope: "TENANT", userId, tenantId, ip: "10.0.0.1", userAgent: "Test",
  }),
}));
vi.mock("@/lib/crypto/crypto-server", () => ({
  getCurrentMasterKeyVersion: mockGetCurrentMasterKeyVersion,
  getMasterKeyByVersion: mockGetMasterKeyByVersion,
}));
vi.mock("@/lib/tenant-rls", () => ({
  withTenantRls: async (_p: unknown, _t: unknown, fn: (tx: unknown) => unknown) =>
    fn({ masterKeyRotation: { findFirst: mockFindFirst, updateMany: mockUpdateMany, update: mockUpdate } }),
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
  initiatedAt: new Date("2030-01-01T09:00:00Z"),
  targetVersion: 2,
  revokeShares: true,
  approvedById: BOB,
  approvedAt: new Date("2030-01-01T09:05:00Z"),
  executedAt: null,
  executedById: null,
  expiresAt: new Date("2030-01-01T10:05:00Z"),
  revokedAt: null,
  revokedById: null,
  reason: null,
  revokedShares: null,
  createdAt: new Date("2030-01-01T09:00:00Z"),
};

function makeRequest(): NextRequest {
  return new NextRequest(
    `http://localhost/api/admin/rotate-master-key/${ROTATION_ID}/execute`,
    { method: "POST", headers: { authorization: "Bearer op_test" } },
  );
}

describe("POST /api/admin/rotate-master-key/[rotationId]/execute — partial-failure (C9b)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Limiter-layer mock: default allowed:true keeps the production
    // checkRateLimitOrFail mapping in path.
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
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
  });

  it("share-revocation throws AFTER CAS commits: row stays executed, audit carries shareRevocationError, 500 returned", async () => {
    mockShareUpdateMany.mockRejectedValueOnce(new Error("transient db error"));

    const res = await POST(makeRequest(), { params: Promise.resolve({ rotationId: ROTATION_ID }) });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("INTERNAL_ERROR");

    // CAS still committed — the row transitions to executed BEFORE the
    // share-revocation attempt, so a downstream throw cannot roll it back.
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
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
