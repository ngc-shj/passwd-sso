import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../../../../__tests__/helpers/mock-auth";
import {
  createRequest,
  parseResponse,
  createParams,
} from "../../../../../__tests__/helpers/request-builder";

const {
  mockAuth,
  mockRequireTenantPermission,
  mockWithTenantRls,
  mockLogAudit,
  mockAuditDeliveryTargetFindFirst,
  mockAuditDeliveryTargetUpdate,
  mockAuditDeliveryCount,
  mockRequireRecentSession,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTenantPermission: vi.fn(),
  mockWithTenantRls: vi.fn(async (prisma: unknown, _tenantId: unknown, fn: (tx: unknown) => unknown) => fn(prisma)),
  mockLogAudit: vi.fn(),
  mockAuditDeliveryTargetFindFirst: vi.fn(),
  mockAuditDeliveryTargetUpdate: vi.fn(),
  mockAuditDeliveryCount: vi.fn().mockResolvedValue(0),
  mockRequireRecentSession: vi.fn().mockResolvedValue(null),
}));

const { mockLockFootholdWriter } = vi.hoisted(() => ({
  mockLockFootholdWriter: vi.fn(async () => new Map()),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/tenant/foothold-write-gate", () => ({ lockFootholdWriter: mockLockFootholdWriter }));
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: mockRequireRecentSession,
}));
vi.mock("@/lib/auth/access/tenant-auth", () => {
  class TenantAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "TenantAuthError";
      this.status = status;
    }
  }
  return {
    requireTenantPermission: mockRequireTenantPermission,
    TenantAuthError,
  };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditDeliveryTarget: {
      findFirst: mockAuditDeliveryTargetFindFirst,
      update: mockAuditDeliveryTargetUpdate,
    },
    auditDelivery: { count: mockAuditDeliveryCount },
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: mockWithTenantRls,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "test", acceptLanguage: null }),
  tenantAuditBase: (_req: unknown, userId: string, tenantId: string) => ({
    scope: "TENANT",
    userId,
    tenantId,
    ip: "127.0.0.1",
    userAgent: "test",
  }),
}));
vi.mock("@/lib/http/with-request-log", () => ({
  withRequestLog: (handler: (...args: unknown[]) => unknown) => handler,
}));

import { PATCH } from "@/app/api/tenant/audit-delivery-targets/[id]/route";
import { TenantAuthError } from "@/lib/auth/access/tenant-auth";
import { AUDIT_ACTION, TENANT_PERMISSION } from "@/lib/constants";
import { footholdGateCells } from "@/__tests__/helpers/foothold-gate-cells";

const ACTOR = { tenantId: "tenant-1", role: "ADMIN" };
const TARGET_ID = "adt-1";

const makeTarget = (overrides: Record<string, unknown> = {}) => ({
  id: TARGET_ID,
  kind: "WEBHOOK",
  isActive: true,
  tenantId: "tenant-1",
  ...overrides,
});

describe("PATCH /api/tenant/audit-delivery-targets/[id]", () => {
  beforeEach(() => vi.clearAllMocks());

  for (const isActive of [true, false]) {
    describe(`gate for isActive: ${isActive}`, () => {
      footholdGateCells({
        gate: mockLockFootholdWriter,
        permission: TENANT_PERMISSION.AUDIT_DELIVERY_MANAGE,
        actorId: DEFAULT_SESSION.user.id,
        tenantId: ACTOR.tenantId,
        okStatus: 200,
        arrange: () => {
          mockAuth.mockResolvedValue(DEFAULT_SESSION);
          mockRequireTenantPermission.mockResolvedValue(ACTOR);
          mockAuditDeliveryTargetFindFirst.mockResolvedValue(makeTarget({ isActive: !isActive }));
          mockAuditDeliveryTargetUpdate.mockResolvedValue(makeTarget({ isActive }));
        },
        call: () =>
          PATCH(
            createRequest("PATCH", `http://localhost/api/tenant/audit-delivery-targets/${TARGET_ID}`, {
              body: { isActive },
              headers: { origin: "http://localhost" },
            }),
            createParams({ id: TARGET_ID }),
          ),
        assertNoWrite: () => expect(mockAuditDeliveryTargetUpdate).not.toHaveBeenCalled(),
        afterRefusal: () => expect(mockLogAudit).not.toHaveBeenCalled(),
      });
    });
  }

  it("answers a demoted actor 403 before the no-op answer, with the target untouched", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAuditDeliveryTargetFindFirst.mockResolvedValue(makeTarget({ isActive: false }));
    mockLockFootholdWriter.mockRejectedValueOnce(new TenantAuthError("FORBIDDEN", 403));

    const res = await PATCH(
      createRequest("PATCH", `http://localhost/api/tenant/audit-delivery-targets/${TARGET_ID}`, {
        body: { isActive: false },
        headers: { origin: "http://localhost" },
      }),
      createParams({ id: TARGET_ID }),
    );

    expect(res.status).toBe(403);
    // The gate precedes the read, so nothing about the target is revealed.
    expect(mockAuditDeliveryTargetFindFirst).not.toHaveBeenCalled();
    expect(mockAuditDeliveryTargetUpdate).not.toHaveBeenCalled();
  });

  it("answers the step-up error, not 404, for an unknown id", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAuditDeliveryTargetFindFirst.mockResolvedValue(null);
    mockRequireRecentSession.mockResolvedValueOnce(
      Response.json({ error: "SESSION_STEP_UP_REQUIRED" }, { status: 403 }),
    );

    const res = await PATCH(
      createRequest("PATCH", `http://localhost/api/tenant/audit-delivery-targets/nonexistent`, {
        body: { isActive: false },
        headers: { origin: "http://localhost" },
      }),
      createParams({ id: "nonexistent" }),
    );
    const { status, json } = await parseResponse(res);

    expect(status).toBe(403);
    expect(json.error).toBe("SESSION_STEP_UP_REQUIRED");
    expect(mockAuditDeliveryTargetFindFirst).not.toHaveBeenCalled();
  });

  it("answers 400, not 404, for an unparseable body and an unknown id", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAuditDeliveryTargetFindFirst.mockResolvedValue(null);

    const res = await PATCH(
      createRequest("PATCH", `http://localhost/api/tenant/audit-delivery-targets/nonexistent`, {
        body: { isActive: "yes" },
        headers: { origin: "http://localhost" },
      }),
      createParams({ id: "nonexistent" }),
    );

    expect(res.status).toBe(400);
    expect(mockAuditDeliveryTargetFindFirst).not.toHaveBeenCalled();
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("PATCH", `http://localhost/api/tenant/audit-delivery-targets/${TARGET_ID}`, {
      body: { isActive: false },
      headers: { origin: "http://localhost" },
    });
    const res = await PATCH(req, createParams({ id: TARGET_ID }));
    const { status } = await parseResponse(res);

    expect(status).toBe(401);
  });

  it("returns 403 when permission denied", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockRejectedValue(new TenantAuthError("FORBIDDEN", 403));

    const req = createRequest("PATCH", `http://localhost/api/tenant/audit-delivery-targets/${TARGET_ID}`, {
      body: { isActive: false },
      headers: { origin: "http://localhost" },
    });
    const res = await PATCH(req, createParams({ id: TARGET_ID }));
    const { status } = await parseResponse(res);

    expect(status).toBe(403);
  });

  it("returns 404 when target not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAuditDeliveryTargetFindFirst.mockResolvedValue(null);

    const req = createRequest("PATCH", `http://localhost/api/tenant/audit-delivery-targets/nonexistent`, {
      body: { isActive: false },
      headers: { origin: "http://localhost" },
    });
    const res = await PATCH(req, createParams({ id: "nonexistent" }));
    const { status } = await parseResponse(res);

    expect(status).toBe(404);
  });

  it("returns 403 from step-up gate and does not update target", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAuditDeliveryTargetFindFirst.mockResolvedValue(makeTarget({ isActive: true }));
    mockRequireRecentSession.mockResolvedValueOnce(
      Response.json({ error: "SESSION_STEP_UP_REQUIRED" }, { status: 403 }),
    );

    const req = createRequest("PATCH", `http://localhost/api/tenant/audit-delivery-targets/${TARGET_ID}`, {
      body: { isActive: false },
      headers: { origin: "http://localhost" },
    });
    const res = await PATCH(req, createParams({ id: TARGET_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(403);
    expect(json.error).toBe("SESSION_STEP_UP_REQUIRED");
    expect(mockAuditDeliveryTargetUpdate).not.toHaveBeenCalled();
  });

  it("deactivates target and logs AUDIT_DELIVERY_TARGET_DEACTIVATE", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAuditDeliveryTargetFindFirst.mockResolvedValue(makeTarget({ isActive: true }));
    mockAuditDeliveryTargetUpdate.mockResolvedValue(makeTarget({ isActive: false }));
    mockAuditDeliveryCount.mockResolvedValueOnce(4);

    const req = createRequest("PATCH", `http://localhost/api/tenant/audit-delivery-targets/${TARGET_ID}`, {
      body: { isActive: false },
      headers: { origin: "http://localhost" },
    });
    const res = await PATCH(req, createParams({ id: TARGET_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.target.isActive).toBe(false);
    expect(mockAuditDeliveryTargetUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: TARGET_ID }),
        data: { isActive: false },
      }),
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AUDIT_ACTION.AUDIT_DELIVERY_TARGET_DEACTIVATE,
        tenantId: "tenant-1",
        scope: "TENANT",
        metadata: { targetId: TARGET_ID, kind: expect.any(String), pendingDeliveries: 4 },
      }),
    );
    // The deliveries it parks: this tenant's, this target's, still PENDING.
    expect(mockAuditDeliveryCount).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1", targetId: TARGET_ID, status: "PENDING" },
    });
  });

  it("returns success without update when isActive is already the requested value", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAuditDeliveryTargetFindFirst.mockResolvedValue(makeTarget({ isActive: true }));

    const req = createRequest("PATCH", `http://localhost/api/tenant/audit-delivery-targets/${TARGET_ID}`, {
      body: { isActive: true },
      headers: { origin: "http://localhost" },
    });
    const res = await PATCH(req, createParams({ id: TARGET_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockAuditDeliveryTargetUpdate).not.toHaveBeenCalled();
    expect(mockAuditDeliveryCount).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("reactivates target and logs AUDIT_DELIVERY_TARGET_REACTIVATE", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAuditDeliveryTargetFindFirst.mockResolvedValue(makeTarget({ isActive: false }));
    mockAuditDeliveryTargetUpdate.mockResolvedValue(makeTarget({ isActive: true }));
    mockAuditDeliveryCount.mockResolvedValueOnce(2);

    const req = createRequest("PATCH", `http://localhost/api/tenant/audit-delivery-targets/${TARGET_ID}`, {
      body: { isActive: true },
      headers: { origin: "http://localhost" },
    });
    const res = await PATCH(req, createParams({ id: TARGET_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.target.isActive).toBe(true);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AUDIT_ACTION.AUDIT_DELIVERY_TARGET_REACTIVATE,
        tenantId: "tenant-1",
        scope: "TENANT",
        metadata: { targetId: TARGET_ID, kind: expect.any(String), pendingDeliveries: 2 },
      }),
    );
  });
});
