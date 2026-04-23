import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const {
  mockAuth,
  mockPrismaScimToken,
  mockRequireTenantPermission,
  mockWithTenantRls,
  mockLogAudit,
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
    mockPrismaScimToken: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    mockRequireTenantPermission: vi.fn(),
    mockWithTenantRls: vi.fn((_p: unknown, _t: unknown, fn: () => unknown) => fn()),
    mockLogAudit: vi.fn(),
    TenantAuthError: _TenantAuthError,
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { scimToken: mockPrismaScimToken },
}));
vi.mock("@/lib/auth/tenant-auth", () => ({
  requireTenantPermission: mockRequireTenantPermission,
  TenantAuthError,
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: mockWithTenantRls,
}));
vi.mock("@/lib/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({ ip: null, userAgent: null }),
  tenantAuditBase: vi.fn((_, userId, tenantId) => ({ scope: "TENANT", userId, tenantId })),
}));

import { DELETE } from "./route";

const TENANT_ID = "tenant-1";
const ACTOR = { id: "membership-1", tenantId: TENANT_ID, userId: "user-1", role: "OWNER" };

function makeParams(tokenId: string) {
  return { params: Promise.resolve({ tokenId }) };
}

describe("DELETE /api/tenant/scim-tokens/[tokenId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const res = await DELETE(
      createRequest("DELETE", "http://localhost/api/tenant/scim-tokens/tok-1"),
      makeParams("tok-1"),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when lacking SCIM_MANAGE permission", async () => {
    mockRequireTenantPermission.mockRejectedValue(
      new TenantAuthError("FORBIDDEN", 403),
    );

    const res = await DELETE(
      createRequest("DELETE", "http://localhost/api/tenant/scim-tokens/tok-1"),
      makeParams("tok-1"),
    );
    expect(res.status).toBe(403);
  });

  it("rethrows unexpected errors", async () => {
    mockRequireTenantPermission.mockRejectedValue(new Error("boom"));

    await expect(
      DELETE(
        createRequest("DELETE", "http://localhost/api/tenant/scim-tokens/tok-1"),
        makeParams("tok-1"),
      ),
    ).rejects.toThrow("boom");
  });

  it("returns 404 when token not found", async () => {
    mockPrismaScimToken.findUnique.mockResolvedValue(null);

    const res = await DELETE(
      createRequest("DELETE", "http://localhost/api/tenant/scim-tokens/tok-missing"),
      makeParams("tok-missing"),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when token belongs to different tenant (IDOR prevention)", async () => {
    mockPrismaScimToken.findUnique.mockResolvedValue({
      id: "tok-1",
      tenantId: "other-tenant",
      revokedAt: null,
    });

    const res = await DELETE(
      createRequest("DELETE", "http://localhost/api/tenant/scim-tokens/tok-1"),
      makeParams("tok-1"),
    );
    expect(res.status).toBe(404);
  });

  it("returns 409 when token is already revoked", async () => {
    mockPrismaScimToken.findUnique.mockResolvedValue({
      id: "tok-1",
      tenantId: TENANT_ID,
      revokedAt: new Date("2025-01-01"),
    });

    const res = await DELETE(
      createRequest("DELETE", "http://localhost/api/tenant/scim-tokens/tok-1"),
      makeParams("tok-1"),
    );
    expect(res.status).toBe(409);
  });

  it("revokes token and returns success", async () => {
    mockPrismaScimToken.findUnique.mockResolvedValue({
      id: "tok-1",
      tenantId: TENANT_ID,
      revokedAt: null,
    });
    mockPrismaScimToken.update.mockResolvedValue({});

    const res = await DELETE(
      createRequest("DELETE", "http://localhost/api/tenant/scim-tokens/tok-1"),
      makeParams("tok-1"),
    );
    expect(res.status).toBe(200);
    expect(mockPrismaScimToken.update).toHaveBeenCalledWith({
      where: { id: "tok-1" },
      data: { revokedAt: expect.any(Date) },
    });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "TENANT",
        action: "SCIM_TOKEN_REVOKE",
      }),
    );
  });
});
