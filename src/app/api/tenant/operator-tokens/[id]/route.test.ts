import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const {
  mockAuth,
  mockRequireTenantPermission,
  mockPrismaOperatorToken,
  mockWithTenantRls,
  mockLogAudit,
  mockRateLimitCheck,
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
    mockPrismaOperatorToken: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    mockWithTenantRls: vi.fn(async (_p: unknown, _t: unknown, fn: () => unknown) => fn()),
    mockLogAudit: vi.fn(),
    mockRateLimitCheck: vi.fn().mockResolvedValue({ allowed: true }),
    TenantAuthError: _TenantAuthError,
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { operatorToken: mockPrismaOperatorToken },
}));
vi.mock("@/lib/auth/access/tenant-auth", () => ({
  requireTenantPermission: mockRequireTenantPermission,
  TenantAuthError,
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: mockWithTenantRls,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({ ip: null, userAgent: null }),
  tenantAuditBase: vi.fn((_req, userId, tenantId) => ({ scope: "TENANT", userId, tenantId })),
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: vi.fn(() => ({
    check: mockRateLimitCheck,
    clear: vi.fn(),
  })),
}));

import { DELETE } from "./route";

const TENANT_ID = "tenant-1";
const USER_ID = "user-1";
const ACTOR = {
  id: "membership-1",
  tenantId: TENANT_ID,
  userId: USER_ID,
  role: "OWNER",
};

function makeParams(id: string) {
  return createParams({ id });
}

describe("DELETE /api/tenant/operator-tokens/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: USER_ID } });
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const res = await DELETE(
      createRequest("DELETE", "http://localhost/api/tenant/operator-tokens/tok-1"),
      makeParams("tok-1"),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when lacking OPERATOR_TOKEN_MANAGE permission", async () => {
    mockRequireTenantPermission.mockRejectedValue(
      new TenantAuthError("FORBIDDEN", 403),
    );

    const res = await DELETE(
      createRequest("DELETE", "http://localhost/api/tenant/operator-tokens/tok-1"),
      makeParams("tok-1"),
    );
    expect(res.status).toBe(403);
  });

  it("returns 404 when token does not exist (IDOR guard)", async () => {
    mockPrismaOperatorToken.findUnique.mockResolvedValue(null);

    const res = await DELETE(
      createRequest("DELETE", "http://localhost/api/tenant/operator-tokens/tok-missing"),
      makeParams("tok-missing"),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 (NOT 403) when token belongs to a different tenant (IDOR guard)", async () => {
    mockPrismaOperatorToken.findUnique.mockResolvedValue({
      id: "tok-1",
      tenantId: "other-tenant",
      revokedAt: null,
      subjectUserId: "user-other",
    });

    const res = await DELETE(
      createRequest("DELETE", "http://localhost/api/tenant/operator-tokens/tok-1"),
      makeParams("tok-1"),
    );
    // Must be 404, not 403, to avoid token-id enumeration
    expect(res.status).toBe(404);
  });

  it("returns 409 with ALREADY_REVOKED when token is already revoked", async () => {
    mockPrismaOperatorToken.findUnique.mockResolvedValue({
      id: "tok-1",
      tenantId: TENANT_ID,
      revokedAt: new Date("2026-01-01"),
      subjectUserId: USER_ID,
    });

    const res = await DELETE(
      createRequest("DELETE", "http://localhost/api/tenant/operator-tokens/tok-1"),
      makeParams("tok-1"),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("ALREADY_REVOKED");
  });

  it("revokes token and returns success with audit OPERATOR_TOKEN_REVOKE", async () => {
    mockPrismaOperatorToken.findUnique.mockResolvedValue({
      id: "tok-1",
      tenantId: TENANT_ID,
      revokedAt: null,
      subjectUserId: USER_ID,
    });
    mockPrismaOperatorToken.update.mockResolvedValue({});

    const res = await DELETE(
      createRequest("DELETE", "http://localhost/api/tenant/operator-tokens/tok-1"),
      makeParams("tok-1"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    expect(mockPrismaOperatorToken.update).toHaveBeenCalledWith({
      where: { id: "tok-1" },
      data: { revokedAt: expect.any(Date) },
    });

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "TENANT",
        action: "OPERATOR_TOKEN_REVOKE",
        metadata: expect.objectContaining({
          tokenId: "tok-1",
          tokenSubjectUserId: USER_ID,
        }),
      }),
    );
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimitCheck.mockResolvedValueOnce({ allowed: false, retryAfterMs: 30_000 });

    const res = await DELETE(
      createRequest("DELETE", "http://localhost/api/tenant/operator-tokens/tok-1"),
      makeParams("tok-1"),
    );
    expect(res.status).toBe(429);
  });
});
