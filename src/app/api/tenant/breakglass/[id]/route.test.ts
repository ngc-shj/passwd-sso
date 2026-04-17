import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams, parseResponse } from "@/__tests__/helpers/request-builder";
import { DEFAULT_SESSION } from "@/__tests__/helpers/mock-auth";

const {
  mockAuth,
  mockRequireTenantPermission,
  mockWithTenantRls,
  mockLogAudit,
  mockAssertOrigin,
  mockGrantFindFirst,
  mockGrantUpdateMany,
  mockDispatchTenantWebhook,
  TenantAuthError,
} = vi.hoisted(() => {
  class _TenantAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "TenantAuthError";
      this.status = status;
    }
  }
  return {
    mockAuth: vi.fn(),
    mockRequireTenantPermission: vi.fn(),
    mockWithTenantRls: vi.fn(async (_p: unknown, _t: unknown, fn: () => unknown) => fn()),
    mockLogAudit: vi.fn(),
    mockAssertOrigin: vi.fn().mockReturnValue(null),
    mockGrantFindFirst: vi.fn(),
    mockGrantUpdateMany: vi.fn(),
    mockDispatchTenantWebhook: vi.fn(),
    TenantAuthError: _TenantAuthError,
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/tenant-auth", () => ({
  requireTenantPermission: mockRequireTenantPermission,
  TenantAuthError,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    personalLogAccessGrant: {
      findFirst: mockGrantFindFirst,
      updateMany: mockGrantUpdateMany,
    },
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: mockWithTenantRls,
}));
vi.mock("@/lib/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "test-agent" }),
  tenantAuditBase: (_req: unknown, userId: string, tenantId: string) => ({
    scope: "TENANT",
    userId,
    tenantId,
    ip: "127.0.0.1",
    userAgent: "test-agent",
  }),
}));
vi.mock("@/lib/csrf", () => ({
  assertOrigin: mockAssertOrigin,
}));
vi.mock("@/lib/with-request-log", () => ({
  withRequestLog: (handler: (...args: unknown[]) => unknown) => handler,
}));
vi.mock("@/lib/webhook-dispatcher", () => ({
  dispatchTenantWebhook: mockDispatchTenantWebhook,
}));

import { DELETE } from "./route";

const TENANT_ID = "tenant-1";
const ACTOR_USER_ID = "test-user-id";
const TARGET_USER_ID = "user-target-99";
const GRANT_ID = "grant-abc-123";

const ACTOR = {
  id: "membership-1",
  tenantId: TENANT_ID,
  userId: ACTOR_USER_ID,
  role: "OWNER",
};

const NOW = new Date();
const FUTURE = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);

const makeGrant = (overrides: Record<string, unknown> = {}) => ({
  id: GRANT_ID,
  tenantId: TENANT_ID,
  requesterId: ACTOR_USER_ID,
  targetUserId: TARGET_USER_ID,
  reason: "Security incident investigation",
  incidentRef: "INC-001",
  expiresAt: FUTURE,
  revokedAt: null,
  createdAt: NOW,
  ...overrides,
});

describe("DELETE /api/tenant/breakglass/[id]", () => {
  const makeReq = () =>
    createRequest("DELETE", `http://localhost/api/tenant/breakglass/${GRANT_ID}`, {
      headers: { origin: "http://localhost" },
    });

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockGrantFindFirst.mockResolvedValue(makeGrant());
    mockGrantUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("returns 403 when CSRF assertOrigin fails", async () => {
    mockAssertOrigin.mockReturnValueOnce(
      new Response(JSON.stringify({ error: "INVALID_ORIGIN" }), { status: 403 }),
    );
    const res = await DELETE(makeReq(), createParams({ id: GRANT_ID }));
    const { status } = await parseResponse(res);
    expect(status).toBe(403);
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await DELETE(makeReq(), createParams({ id: GRANT_ID }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 403 when lacking BREAKGLASS_REQUEST permission", async () => {
    mockRequireTenantPermission.mockRejectedValue(new TenantAuthError("FORBIDDEN", 403));
    const res = await DELETE(makeReq(), createParams({ id: GRANT_ID }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
  });

  it("rethrows non-TenantAuthError from permission check", async () => {
    mockRequireTenantPermission.mockRejectedValue(new Error("db crash"));
    await expect(
      DELETE(makeReq(), createParams({ id: GRANT_ID })),
    ).rejects.toThrow("db crash");
  });

  it("returns 404 when grant does not exist", async () => {
    mockGrantFindFirst.mockResolvedValue(null);
    const res = await DELETE(makeReq(), createParams({ id: GRANT_ID }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(404);
    expect(json.error).toBe("NOT_FOUND");
  });

  it("returns 403 when non-owner tries to revoke another user's grant", async () => {
    // Actor is ADMIN but not the requester (grant was made by someone else)
    mockRequireTenantPermission.mockResolvedValue({ ...ACTOR, role: "ADMIN" });
    mockGrantFindFirst.mockResolvedValue(makeGrant({ requesterId: "other-user-id" }));
    const res = await DELETE(makeReq(), createParams({ id: GRANT_ID }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
  });

  it("returns 409 when grant is already revoked", async () => {
    mockGrantFindFirst.mockResolvedValue(makeGrant({ revokedAt: NOW }));
    const res = await DELETE(makeReq(), createParams({ id: GRANT_ID }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(409);
    expect(json.error).toBe("CONFLICT");
    expect(json.details.status).toBe("already_revoked");
  });

  it("returns 409 when grant has already expired", async () => {
    const pastDate = new Date(Date.now() - 1000);
    mockGrantFindFirst.mockResolvedValue(makeGrant({ expiresAt: pastDate }));
    const res = await DELETE(makeReq(), createParams({ id: GRANT_ID }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(409);
    expect(json.error).toBe("CONFLICT");
    expect(json.details.status).toBe("already_expired");
  });

  it("returns 409 when updateMany race yields count 0", async () => {
    mockGrantUpdateMany.mockResolvedValue({ count: 0 });
    const res = await DELETE(makeReq(), createParams({ id: GRANT_ID }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(409);
    expect(json.error).toBe("CONFLICT");
  });

  it("returns 200 with ok:true on successful revoke", async () => {
    const res = await DELETE(makeReq(), createParams({ id: GRANT_ID }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
  });

  it("fires audit log after successful revoke", async () => {
    await DELETE(makeReq(), createParams({ id: GRANT_ID }));
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "PERSONAL_LOG_ACCESS_REVOKE",
        userId: ACTOR_USER_ID,
        tenantId: TENANT_ID,
        targetType: "User",
        targetId: TARGET_USER_ID,
        metadata: expect.objectContaining({
          grantId: GRANT_ID,
          revokedById: ACTOR_USER_ID,
        }),
      }),
    );
  });

  it("allows OWNER to revoke a grant made by another user", async () => {
    // Grant was made by a different user, but actor is OWNER
    mockGrantFindFirst.mockResolvedValue(makeGrant({ requesterId: "another-admin-id" }));
    const res = await DELETE(makeReq(), createParams({ id: GRANT_ID }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
  });

  it("calls requireTenantPermission with BREAKGLASS_REQUEST permission", async () => {
    await DELETE(makeReq(), createParams({ id: GRANT_ID }));
    expect(mockRequireTenantPermission).toHaveBeenCalledWith(
      ACTOR_USER_ID,
      "tenant:breakglass:request",
    );
  });
});
