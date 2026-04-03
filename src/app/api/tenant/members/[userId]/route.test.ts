import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaTenantMember, mockRequireTenantPermission, mockWithTenantRls, TenantAuthError, mockLogAudit } = vi.hoisted(() => {
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
    mockPrismaTenantMember: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    mockRequireTenantPermission: vi.fn(),
    mockWithTenantRls: vi.fn((_p: unknown, _t: unknown, fn: () => unknown) => fn()),
    TenantAuthError: _TenantAuthError,
    mockLogAudit: vi.fn(),
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantMember: mockPrismaTenantMember,
  },
}));
vi.mock("@/lib/tenant-auth", () => ({
  requireTenantPermission: mockRequireTenantPermission,
  TenantAuthError,
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: mockWithTenantRls,
  withBypassRls: vi.fn((_p: unknown, fn: () => unknown) => fn()),
}));
vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
  extractRequestMeta: vi.fn().mockReturnValue({ ip: "127.0.0.1", userAgent: "test" }),
}));
vi.mock("@/lib/logger", () => ({
  default: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { PUT } from "./route";

const TENANT_ID = "tenant-1";
const ACTOR_USER_ID = "owner-user-id";
const TARGET_USER_ID = "target-user-id";

const ACTOR = { id: "membership-owner", tenantId: TENANT_ID, userId: ACTOR_USER_ID, role: "OWNER" };

const TARGET_ADMIN = {
  id: "membership-admin",
  tenantId: TENANT_ID,
  userId: TARGET_USER_ID,
  role: "ADMIN",
  deactivatedAt: null,
  scimManaged: false,
};

const UPDATED_MEMBER = {
  id: "membership-admin",
  userId: TARGET_USER_ID,
  role: "MEMBER",
  user: { id: TARGET_USER_ID, name: "Bob Admin", email: "bob@example.com", image: null },
};

function putRequest(userId: string, body?: unknown) {
  return PUT(
    createRequest("PUT", `http://localhost:3000/api/tenant/members/${userId}`, {
      body: body ?? { role: "MEMBER" },
    }),
    createParams({ userId }),
  );
}

describe("PUT /api/tenant/members/[userId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: ACTOR_USER_ID } });
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockPrismaTenantMember.findFirst.mockResolvedValue(TARGET_ADMIN);
    mockPrismaTenantMember.update.mockResolvedValue(UPDATED_MEMBER);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await putRequest(TARGET_USER_ID);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 403 when lacking MEMBER_MANAGE permission", async () => {
    mockRequireTenantPermission.mockRejectedValue(new TenantAuthError("FORBIDDEN", 403));
    const res = await putRequest(TARGET_USER_ID);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("FORBIDDEN");
  });

  it("rethrows non-TenantAuthError errors", async () => {
    mockRequireTenantPermission.mockRejectedValue(new Error("unexpected"));
    await expect(putRequest(TARGET_USER_ID)).rejects.toThrow("unexpected");
  });

  it("returns 403 when ADMIN calls endpoint (OWNER-only)", async () => {
    mockRequireTenantPermission.mockResolvedValue({ ...ACTOR, role: "ADMIN" });
    const res = await putRequest(TARGET_USER_ID);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("OWNER_ONLY");
  });

  it("returns 400 when trying to change own role", async () => {
    const res = await putRequest(ACTOR_USER_ID);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("CANNOT_CHANGE_OWN_ROLE");
  });

  it("returns 400 for invalid JSON body", async () => {
    const res = await PUT(
      new Request("http://localhost:3000/api/tenant/members/" + TARGET_USER_ID, {
        method: "PUT",
        body: "not json",
        headers: { "Content-Type": "application/json" },
      }),
      createParams({ userId: TARGET_USER_ID }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("INVALID_JSON");
  });

  it("returns 400 for invalid role value", async () => {
    const res = await putRequest(TARGET_USER_ID, { role: "SUPERADMIN" });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 404 when target member not found", async () => {
    mockPrismaTenantMember.findFirst.mockResolvedValue(null);
    const res = await putRequest(TARGET_USER_ID);
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("MEMBER_NOT_FOUND");
  });

  it("returns 409 when target is SCIM-managed", async () => {
    mockPrismaTenantMember.findFirst.mockResolvedValue({ ...TARGET_ADMIN, scimManaged: true });
    const res = await putRequest(TARGET_USER_ID);
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("SCIM_MANAGED_MEMBER");
  });

  it("returns 403 when trying to change OWNER role (non-transfer)", async () => {
    mockPrismaTenantMember.findFirst.mockResolvedValue({ ...TARGET_ADMIN, role: "OWNER" });
    const res = await putRequest(TARGET_USER_ID);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("CANNOT_CHANGE_OWNER_ROLE");
  });

  it("successfully changes ADMIN to MEMBER", async () => {
    const res = await putRequest(TARGET_USER_ID, { role: "MEMBER" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.role).toBe("MEMBER");
    expect(json.userId).toBe(TARGET_USER_ID);
    expect(mockPrismaTenantMember.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: TARGET_ADMIN.id },
        data: { role: "MEMBER" },
      }),
    );
  });

  it("successfully changes MEMBER to ADMIN", async () => {
    mockPrismaTenantMember.findFirst.mockResolvedValue({ ...TARGET_ADMIN, role: "MEMBER" });
    mockPrismaTenantMember.update.mockResolvedValue({ ...UPDATED_MEMBER, role: "ADMIN" });
    const res = await putRequest(TARGET_USER_ID, { role: "ADMIN" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.role).toBe("ADMIN");
  });

  it("logs audit with previousRole and newRole", async () => {
    await putRequest(TARGET_USER_ID, { role: "MEMBER" });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "TENANT_ROLE_UPDATE",
        metadata: expect.objectContaining({
          previousRole: "ADMIN",
          newRole: "MEMBER",
        }),
      }),
    );
  });

  describe("ownership transfer", () => {
    const TRANSFERRED_MEMBER = {
      id: TARGET_ADMIN.id,
      userId: TARGET_USER_ID,
      role: "OWNER",
      user: { id: TARGET_USER_ID, name: "Bob Admin", email: "bob@example.com", image: null },
    };

    beforeEach(() => {
      // First findFirst: target lookup (outside transfer scope)
      // Second findFirst: actor re-verification inside transfer scope
      mockPrismaTenantMember.findFirst
        .mockResolvedValueOnce(TARGET_ADMIN) // target lookup
        .mockResolvedValueOnce(ACTOR); // actor re-verify
      // First update: demote actor, second update: promote target
      mockPrismaTenantMember.update
        .mockResolvedValueOnce({ ...ACTOR, role: "ADMIN" }) // demote actor
        .mockResolvedValueOnce(TRANSFERRED_MEMBER); // promote target
    });

    it("transfers ownership: demotes actor to ADMIN, promotes target to OWNER", async () => {
      const res = await putRequest(TARGET_USER_ID, { role: "OWNER" });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.role).toBe("OWNER");
      expect(json.userId).toBe(TARGET_USER_ID);

      // Verify demote happened first, then promote
      expect(mockPrismaTenantMember.update).toHaveBeenCalledTimes(2);
      const calls = mockPrismaTenantMember.update.mock.calls;
      expect(calls[0][0]).toMatchObject({ data: { role: "ADMIN" } }); // demote actor
      expect(calls[1][0]).toMatchObject({ data: { role: "OWNER" } }); // promote target
    });

    it("logs audit with transfer flag", async () => {
      await putRequest(TARGET_USER_ID, { role: "OWNER" });
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "TENANT_ROLE_UPDATE",
          metadata: expect.objectContaining({
            previousRole: "ADMIN",
            newRole: "OWNER",
            transfer: true,
          }),
        }),
      );
    });

    it("returns 403 if actor lost OWNER during re-verification", async () => {
      mockPrismaTenantMember.findFirst
        .mockReset()
        .mockResolvedValueOnce(TARGET_ADMIN) // target lookup
        .mockResolvedValueOnce(null); // actor re-verify fails
      const res = await putRequest(TARGET_USER_ID, { role: "OWNER" });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toBe("OWNER_ONLY");
    });
  });

});
