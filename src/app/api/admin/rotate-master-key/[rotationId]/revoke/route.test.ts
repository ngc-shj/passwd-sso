import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OPERATOR_TOKEN_PREFIX } from "@/lib/constants/auth/operator-token";
import { assertRedisFailClosed, snapshotFactory } from "@/__tests__/helpers/fail-closed";

const VALID_OP_TOKEN = `${OPERATOR_TOKEN_PREFIX}${"a".repeat(43)}`;

const {
  mockVerifyAdminToken,
  mockFindFirst,
  mockUpdateMany,
  mockRequireMaintenanceOperator,
  mockCheck,
  mockCreateRateLimiter,
  mockLogAudit,
} = vi.hoisted(() => {
  const mockCheck = vi.fn().mockResolvedValue({ allowed: true });
  return {
    mockVerifyAdminToken: vi.fn(),
    mockFindFirst: vi.fn(),
    mockUpdateMany: vi.fn(),
    mockRequireMaintenanceOperator: vi.fn(),
    mockCheck,
    mockCreateRateLimiter: vi.fn((_opts: unknown) => ({ check: mockCheck, clear: vi.fn() })),
    mockLogAudit: vi.fn(),
  };
});

vi.mock("@/lib/auth/tokens/admin-token", () => ({ verifyAdminToken: mockVerifyAdminToken }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    masterKeyRotation: { findFirst: mockFindFirst, updateMany: mockUpdateMany },
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
  }),
}));
vi.mock("@/lib/tenant-rls", () => ({
  withTenantRls: async (_p: unknown, _t: unknown, fn: (tx: unknown) => unknown) =>
    fn({
      masterKeyRotation: { findFirst: mockFindFirst, updateMany: mockUpdateMany },
    }),
  withBypassRls: async (_p: unknown, fn: (tx: unknown) => unknown) => fn({}),
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

const rateLimiterFactorySnapshot = snapshotFactory(mockCreateRateLimiter);
const rateLimiter = mockCreateRateLimiter.mock.results[0]!.value as {
  check: typeof mockCheck;
};

const TENANT = "11111111-1111-1111-1111-111111111111";
const ALICE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ROTATION_ID = "11111111-2222-3333-4444-555555555555";

const PENDING_ROW = {
  id: ROTATION_ID,
  tenantId: TENANT,
  initiatedById: ALICE,
  initiatedAt: new Date("2030-01-01T09:00:00Z"),
  targetVersion: 2,
  revokeShares: true,
  approvedById: null,
  approvedAt: null,
  executedAt: null,
  executedById: null,
  expiresAt: new Date("2030-01-02T09:00:00Z"),
  revokedAt: null,
  revokedById: null,
  reason: null,
  revokedShares: null,
  createdAt: new Date("2030-01-01T09:00:00Z"),
};

function makeRequest(): NextRequest {
  return new NextRequest(
    `http://localhost/api/admin/rotate-master-key/${ROTATION_ID}/revoke`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${VALID_OP_TOKEN}` },
    },
  );
}

describe("POST /api/admin/rotate-master-key/[rotationId]/revoke", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheck.mockResolvedValue({ allowed: true });
    mockRequireMaintenanceOperator.mockResolvedValue({ ok: true });
    mockVerifyAdminToken.mockResolvedValue({
      ok: true,
      auth: { subjectUserId: BOB, tenantId: TENANT, tokenId: "tok-1", scopes: ["MAINTENANCE"] },
    });
    mockFindFirst.mockResolvedValue(PENDING_ROW);
    mockUpdateMany.mockResolvedValue({ count: 1 });
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
  });

  it("returns 409 (ALREADY_TERMINAL) when row already executed", async () => {
    mockFindFirst.mockResolvedValue({
      ...PENDING_ROW,
      executedAt: new Date("2030-01-01T09:30:00Z"),
    });
    const res = await callPOST();
    expect(res.status).toBe(409);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("returns 409 when CAS count===0", async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });
    const res = await callPOST();
    expect(res.status).toBe(409);
  });

  it("returns 200 with SECOND_ACTOR_REVOKE audit when actor != initiator", async () => {
    const res = await callPOST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("revoked");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "MASTER_KEY_ROTATION_REVOKE",
        metadata: expect.objectContaining({
          cause: "SECOND_ACTOR_REVOKE",
        }),
      }),
    );
  });

  it("returns 200 with INITIATOR_SELF_REVOKE audit when actor == initiator", async () => {
    mockVerifyAdminToken.mockResolvedValue({
      ok: true,
      auth: { subjectUserId: ALICE, tenantId: TENANT, tokenId: "tok-1", scopes: ["MAINTENANCE"] },
    });
    const res = await callPOST();
    expect(res.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "MASTER_KEY_ROTATION_REVOKE",
        metadata: expect.objectContaining({
          cause: "INITIATOR_SELF_REVOKE",
        }),
      }),
    );
  });

  it("CAS WHERE locks revokes against terminal states", async () => {
    await callPOST();
    const callArg = mockUpdateMany.mock.calls[0][0];
    expect(Object.keys(callArg.where).sort()).toEqual(
      ["executedAt", "id", "revokedAt", "tenantId"].sort(),
    );
    expect(callArg.where).toMatchObject({
      id: ROTATION_ID,
      tenantId: TENANT,
      executedAt: null,
      revokedAt: null,
    });
    expect(callArg.data.revokedById).toBe(BOB);
  });

  it("fails closed (503, no mutation) when Redis is unavailable", async () => {
    await assertRedisFailClosed({
      invoke: callPOST,
      limiter: rateLimiter,
      expectation: { envelope: "canonical" },
      assertNoMutation: [mockUpdateMany],
      limiterFactory: rateLimiterFactorySnapshot.replay(),
      failure: { allowed: false, redisErrored: true },
    });
  });

  // T-CT: cross-tenant branch — emits FORBIDDEN_CROSS_TENANT audit row.
  it("returns 403 + FORBIDDEN_CROSS_TENANT audit when actor.tenantId !== row.tenantId", async () => {
    const TENANT_B = "22222222-2222-2222-2222-222222222222";
    mockVerifyAdminToken.mockResolvedValue({
      ok: true,
      auth: { subjectUserId: BOB, tenantId: TENANT_B, tokenId: "tok-1", scopes: ["MAINTENANCE"] },
    });
    mockFindFirst.mockResolvedValue(PENDING_ROW);
    const res = await callPOST();
    expect(res.status).toBe(403);
    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "MASTER_KEY_ROTATION_REVOKE",
        metadata: expect.objectContaining({ cause: "FORBIDDEN_CROSS_TENANT" }),
      }),
    );
  });

  // F5 (C scenario): approved-then-revoke — Bob approves, then revokes
  // before execute. CAS WHERE allows approvedAt != null as long as
  // executedAt == null && revokedAt == null.
  it("transitions approved → revoked (Scenario C approved-then-revoke)", async () => {
    mockFindFirst.mockResolvedValue({
      ...PENDING_ROW,
      approvedAt: new Date("2030-01-01T09:30:00Z"),
      approvedById: BOB,
    });
    const res = await callPOST();
    expect(res.status).toBe(200);
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "MASTER_KEY_ROTATION_REVOKE",
        metadata: expect.objectContaining({ cause: "SECOND_ACTOR_REVOKE" }),
      }),
    );
  });

  // F5: .strict() rejection on revoke — unknown fields fail validation.
  // NextRequest does not auto-set Content-Length in test env; set explicitly
  // so the route's body-parse gate fires.
  it("rejects unknown body fields (.strict())", async () => {
    const body = JSON.stringify({ reason: "ok", foo: "nope" });
    const req = new NextRequest(
      `http://localhost/api/admin/rotate-master-key/${ROTATION_ID}/revoke`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${VALID_OP_TOKEN}`,
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        },
        body,
      },
    );
    const res = await POST(req, { params: Promise.resolve({ rotationId: ROTATION_ID }) });
    expect(res.status).toBe(400);
  });
});
