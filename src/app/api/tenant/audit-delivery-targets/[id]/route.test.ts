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
  mockAssertOrigin,
  mockAuditDeliveryTargetFindFirst,
  mockAuditDeliveryTargetUpdate,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTenantPermission: vi.fn(),
  mockWithTenantRls: vi.fn(async (_prisma: unknown, _tenantId: unknown, fn: () => unknown) => fn()),
  mockLogAudit: vi.fn(),
  mockAssertOrigin: vi.fn().mockReturnValue(null),
  mockAuditDeliveryTargetFindFirst: vi.fn(),
  mockAuditDeliveryTargetUpdate: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/tenant-auth", () => {
  class TenantAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
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
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: mockWithTenantRls,
}));
vi.mock("@/lib/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "test", acceptLanguage: null }),
}));
vi.mock("@/lib/csrf", () => ({
  assertOrigin: mockAssertOrigin,
}));
vi.mock("@/lib/with-request-log", () => ({
  withRequestLog: (handler: (...args: unknown[]) => unknown) => handler,
}));

import { PATCH } from "@/app/api/tenant/audit-delivery-targets/[id]/route";
import { TenantAuthError } from "@/lib/tenant-auth";
import { AUDIT_ACTION } from "@/lib/constants";

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

  it("blocks request when CSRF fails", async () => {
    mockAssertOrigin.mockReturnValueOnce(
      new Response(JSON.stringify({ error: "INVALID_ORIGIN" }), { status: 403 }),
    );

    const req = createRequest("PATCH", `http://localhost/api/tenant/audit-delivery-targets/${TARGET_ID}`, {
      body: { isActive: false },
    });
    const res = await PATCH(req, createParams({ id: TARGET_ID }));
    const { status } = await parseResponse(res);

    expect(status).toBe(403);
    expect(mockAuth).not.toHaveBeenCalled();
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

  it("deactivates target and logs AUDIT_DELIVERY_TARGET_DEACTIVATE", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAuditDeliveryTargetFindFirst.mockResolvedValue(makeTarget({ isActive: true }));
    mockAuditDeliveryTargetUpdate.mockResolvedValue(makeTarget({ isActive: false }));

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
      }),
    );
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
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("reactivates target and logs AUDIT_DELIVERY_TARGET_REACTIVATE", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAuditDeliveryTargetFindFirst.mockResolvedValue(makeTarget({ isActive: false }));
    mockAuditDeliveryTargetUpdate.mockResolvedValue(makeTarget({ isActive: true }));

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
      }),
    );
  });
});
