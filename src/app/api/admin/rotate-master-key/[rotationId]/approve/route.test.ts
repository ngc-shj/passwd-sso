import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OPERATOR_TOKEN_PREFIX } from "@/lib/constants/auth/operator-token";
import { MS_PER_DAY } from "@/lib/constants/time";

const VALID_OP_TOKEN = `${OPERATOR_TOKEN_PREFIX}${"a".repeat(43)}`;

const {
  mockVerifyAdminToken,
  mockFindFirst,
  mockUpdateMany,
  mockRequireMaintenanceOperator,
  mockCheckRateLimitOrFail,
  mockLogAudit,
} = vi.hoisted(() => ({
  mockVerifyAdminToken: vi.fn(),
  mockFindFirst: vi.fn(),
  mockUpdateMany: vi.fn(),
  mockRequireMaintenanceOperator: vi.fn(),
  mockCheckRateLimitOrFail: vi.fn().mockResolvedValue(null),
  mockLogAudit: vi.fn(),
}));

vi.mock("@/lib/auth/tokens/admin-token", () => ({ verifyAdminToken: mockVerifyAdminToken }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    masterKeyRotation: { findFirst: mockFindFirst, updateMany: mockUpdateMany },
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

const TENANT = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const ALICE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ROTATION_ID = "11111111-2222-3333-4444-555555555555";

function makeRequest(): NextRequest {
  return new NextRequest(
    `http://localhost/api/admin/rotate-master-key/${ROTATION_ID}/approve`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${VALID_OP_TOKEN}` },
    },
  );
}

const ROW_PENDING = {
  id: ROTATION_ID,
  tenantId: TENANT,
  initiatedById: ALICE,
  initiatedAt: new Date("2026-05-23T09:00:00Z"),
  targetVersion: 2,
  revokeShares: true,
  approvedById: null,
  approvedAt: null,
  executedAt: null,
  executedById: null,
  expiresAt: new Date("2026-05-24T09:00:00Z"),
  revokedAt: null,
  revokedById: null,
  reason: null,
  revokedShares: null,
  createdAt: new Date("2026-05-23T09:00:00Z"),
};

describe("POST /api/admin/rotate-master-key/[rotationId]/approve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimitOrFail.mockResolvedValue(null);
    mockRequireMaintenanceOperator.mockResolvedValue({ ok: true });
    mockVerifyAdminToken.mockResolvedValue({
      ok: true,
      auth: { subjectUserId: BOB, tenantId: TENANT, tokenId: "tok-1", scopes: ["MAINTENANCE"] },
    });
    mockFindFirst.mockResolvedValue(ROW_PENDING);
    mockUpdateMany.mockResolvedValue({ count: 1 });
  });

  const callPOST = () =>
    POST(makeRequest(), { params: Promise.resolve({ rotationId: ROTATION_ID }) });

  it("returns 401 when auth fails", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: false, reason: "INVALID" });
    const res = await callPOST();
    expect(res.status).toBe(401);
  });

  it("returns 404 when rotation does not exist in this tenant", async () => {
    mockFindFirst.mockResolvedValue(null);
    const res = await callPOST();
    expect(res.status).toBe(404);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("returns 403 + FORBIDDEN_SELF_APPROVAL audit when actor is the initiator", async () => {
    mockVerifyAdminToken.mockResolvedValue({
      ok: true,
      auth: { subjectUserId: ALICE, tenantId: TENANT, tokenId: "tok-1", scopes: ["MAINTENANCE"] },
    });
    const res = await callPOST();
    expect(res.status).toBe(403);
    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "MASTER_KEY_ROTATION_APPROVE",
        metadata: expect.objectContaining({ cause: "FORBIDDEN_SELF_APPROVAL" }),
      }),
    );
  });

  it("returns 403 + FORBIDDEN_CROSS_TENANT audit when actor tenant differs", async () => {
    mockVerifyAdminToken.mockResolvedValue({
      ok: true,
      auth: { subjectUserId: BOB, tenantId: TENANT_B, tokenId: "tok-1", scopes: ["MAINTENANCE"] },
    });
    // Row is in TENANT but actor is in TENANT_B. findFirst won't return null
    // in this mock — we override it explicitly so eligibility fires.
    mockFindFirst.mockResolvedValue({ ...ROW_PENDING, tenantId: TENANT });
    const res = await callPOST();
    expect(res.status).toBe(403);
    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "MASTER_KEY_ROTATION_APPROVE",
        metadata: expect.objectContaining({ cause: "FORBIDDEN_CROSS_TENANT" }),
      }),
    );
  });

  it("returns 409 when row already approved (ALREADY_TERMINAL)", async () => {
    mockFindFirst.mockResolvedValue({ ...ROW_PENDING, approvedAt: new Date("2026-05-23T08:00:00Z") });
    const res = await callPOST();
    expect(res.status).toBe(409);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("returns 409 when CAS count===0 (race-lost) and emits RACE_LOST_OR_TERMINAL audit", async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });
    const res = await callPOST();
    expect(res.status).toBe(409);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "MASTER_KEY_ROTATION_APPROVE",
        metadata: expect.objectContaining({ cause: "RACE_LOST_OR_TERMINAL" }),
      }),
    );
  });

  it("returns 200 on happy path; CAS WHERE includes load-bearing fields", async () => {
    const res = await callPOST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("approved");
    expect(body.expiresAt).toBeTruthy();

    // T11: exact-key-set assertion + value matching to catch CAS WHERE drift.
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    const callArg = mockUpdateMany.mock.calls[0][0];
    expect(Object.keys(callArg.where).sort()).toEqual(
      [
        "approvedAt",
        "executedAt",
        "expiresAt",
        "id",
        "initiatedById",
        "revokedAt",
        "tenantId",
      ].sort(),
    );
    expect(callArg.where).toMatchObject({
      id: ROTATION_ID,
      tenantId: TENANT,
      approvedAt: null,
      executedAt: null,
      revokedAt: null,
      initiatedById: { not: BOB },
    });
    expect(callArg.where.expiresAt).toMatchObject({ gt: expect.any(Date) });
    expect(callArg.data.approvedById).toBe(BOB);
    expect(callArg.data.approvedAt).toBeInstanceOf(Date);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "MASTER_KEY_ROTATION_APPROVE",
        metadata: expect.objectContaining({
          rotationId: ROTATION_ID,
          targetVersion: 2,
          initiatedById: ALICE,
        }),
      }),
    );
  });

  it("narrows expiresAt to min(originalExpiresAt, now + EXECUTE_TTL_MS)", async () => {
    await callPOST();
    const callArg = mockUpdateMany.mock.calls[0][0];
    const newExpiresAt: Date = callArg.data.expiresAt;
    // Original expires at 2026-05-24T09:00:00Z (24h after initiate). The 60-min
    // execute window means the narrowed expiresAt is much sooner than the
    // initiate-time expiresAt — we just check the relation, not absolute time.
    expect(newExpiresAt.getTime()).toBeLessThan(
      ROW_PENDING.expiresAt.getTime(),
    );
  });

  describe("redisErrored fail-closed (rate-limiter Redis unavailable)", () => {
    it("returns 503 when checkRateLimitOrFail hands back the canonical 503 envelope", async () => {
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
      expect(mockUpdateMany).not.toHaveBeenCalled();
    });
  });

  // F5 (Scenario D — expiry): approval attempt after expiresAt elapses is
  // rejected by the eligibility helper as ALREADY_TERMINAL. Use a definitively-
  // past timestamp (1 year ago) so the test is robust to system clock.
  it("returns 409 ALREADY_TERMINAL when expiresAt has elapsed", async () => {
    const past = new Date(Date.now() - 365 * MS_PER_DAY);
    mockFindFirst.mockResolvedValue({
      ...ROW_PENDING,
      expiresAt: past,
    });
    const res = await callPOST();
    expect(res.status).toBe(409);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  // F5: .strict() rejection on approve. NextRequest in test env does NOT
  // auto-set Content-Length; the route gates parseBody on Content-Length so
  // the test must set it explicitly to exercise the .strict() path.
  it("rejects unknown body fields (.strict())", async () => {
    const { NextRequest } = await import("next/server");
    const body = JSON.stringify({ reason: "ok", malicious: "field" });
    const req = new NextRequest(
      `http://localhost/api/admin/rotate-master-key/${ROTATION_ID}/approve`,
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
