import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaOrgMember, mockPrismaOrgMemberKey, mockTransaction, mockRequireOrgPermission, mockIsRoleAbove, OrgAuthError } = vi.hoisted(() => {
  class _OrgAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "OrgAuthError";
      this.status = status;
    }
  }
  return {
    mockAuth: vi.fn(),
    mockPrismaOrgMember: {
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    mockPrismaOrgMemberKey: {
      deleteMany: vi.fn(),
    },
    mockTransaction: vi.fn(),
    mockRequireOrgPermission: vi.fn(),
    mockIsRoleAbove: vi.fn(),
    OrgAuthError: _OrgAuthError,
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    orgMember: mockPrismaOrgMember,
    orgMemberKey: mockPrismaOrgMemberKey,
    $transaction: mockTransaction,
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));
vi.mock("@/lib/org-auth", () => ({
  requireOrgPermission: mockRequireOrgPermission,
  isRoleAbove: mockIsRoleAbove,
  OrgAuthError,
}));

import { PUT, DELETE } from "./route";
import { ORG_ROLE } from "@/lib/constants";

const ORG_ID = "org-123";
const MEMBER_ID = "member-target";

const ownerMembership = { id: "member-owner", orgId: ORG_ID, userId: "test-user-id", role: ORG_ROLE.OWNER };

describe("PUT /api/orgs/[orgId]/members/[memberId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireOrgPermission.mockResolvedValue(ownerMembership);
    mockIsRoleAbove.mockReturnValue(true);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/members/${MEMBER_ID}`, {
        body: { role: ORG_ROLE.ADMIN },
      }),
      createParams({ orgId: ORG_ID, memberId: MEMBER_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when lacking permission", async () => {
    mockRequireOrgPermission.mockRejectedValue(new OrgAuthError("FORBIDDEN", 403));
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/members/${MEMBER_ID}`, {
        body: { role: ORG_ROLE.ADMIN },
      }),
      createParams({ orgId: ORG_ID, memberId: MEMBER_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("rethrows non-OrgAuthError from PUT", async () => {
    mockRequireOrgPermission.mockRejectedValue(new Error("unexpected"));
    await expect(
      PUT(
        createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/members/${MEMBER_ID}`, {
          body: { role: ORG_ROLE.ADMIN },
        }),
        createParams({ orgId: ORG_ID, memberId: MEMBER_ID }),
      ),
    ).rejects.toThrow("unexpected");
  });

  it("returns 400 on malformed JSON", async () => {
    const { NextRequest } = await import("next/server");
    const req = new NextRequest(`http://localhost:3000/api/orgs/${ORG_ID}/members/${MEMBER_ID}`, {
      method: "PUT",
      body: "not-json",
      headers: { "Content-Type": "application/json" },
    });
    mockPrismaOrgMember.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      orgId: ORG_ID,
      userId: "target-user",
      role: ORG_ROLE.MEMBER,
      deactivatedAt: null,
    });
    const res = await PUT(req, createParams({ orgId: ORG_ID, memberId: MEMBER_ID }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("INVALID_JSON");
  });

  it("returns 400 on validation error", async () => {
    mockPrismaOrgMember.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      orgId: ORG_ID,
      userId: "target-user",
      role: ORG_ROLE.MEMBER,
      deactivatedAt: null,
    });
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/members/${MEMBER_ID}`, {
        body: { role: "INVALID_ROLE" },
      }),
      createParams({ orgId: ORG_ID, memberId: MEMBER_ID }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 404 when member not found", async () => {
    mockPrismaOrgMember.findUnique.mockResolvedValue(null);
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/members/${MEMBER_ID}`, {
        body: { role: ORG_ROLE.ADMIN },
      }),
      createParams({ orgId: ORG_ID, memberId: MEMBER_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("changes member role (OWNER changes MEMBER to ADMIN)", async () => {
    mockPrismaOrgMember.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      orgId: ORG_ID,
      userId: "target-user",
      role: ORG_ROLE.MEMBER,
      deactivatedAt: null,
    });
    mockPrismaOrgMember.update.mockResolvedValue({
      id: MEMBER_ID,
      userId: "target-user",
      role: ORG_ROLE.ADMIN,
      user: { id: "target-user", name: "Target", email: "t@test.com", image: null },
    });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/members/${MEMBER_ID}`, {
        body: { role: ORG_ROLE.ADMIN },
      }),
      createParams({ orgId: ORG_ID, memberId: MEMBER_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.role).toBe(ORG_ROLE.ADMIN);
  });

  it("transfers ownership: promotes target to OWNER, demotes self to ADMIN", async () => {
    mockPrismaOrgMember.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      orgId: ORG_ID,
      userId: "target-user",
      role: ORG_ROLE.ADMIN,
      deactivatedAt: null,
    });
    mockPrismaOrgMember.update.mockResolvedValue({
      id: MEMBER_ID,
      userId: "target-user",
      role: ORG_ROLE.OWNER,
      user: { id: "target-user", name: "New Owner", email: "new@test.com", image: null },
    });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/members/${MEMBER_ID}`, {
        body: { role: ORG_ROLE.OWNER },
      }),
      createParams({ orgId: ORG_ID, memberId: MEMBER_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.role).toBe(ORG_ROLE.OWNER);
    // Actor should be demoted to ADMIN
    expect(mockPrismaOrgMember.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ownerMembership.id }, data: { role: ORG_ROLE.ADMIN } }),
    );
  });

  it("returns 403 when non-OWNER tries to transfer ownership", async () => {
    mockRequireOrgPermission.mockResolvedValue({ ...ownerMembership, role: ORG_ROLE.ADMIN });
    mockPrismaOrgMember.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      orgId: ORG_ID,
      userId: "target-user",
      role: ORG_ROLE.MEMBER,
      deactivatedAt: null,
    });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/members/${MEMBER_ID}`, {
        body: { role: ORG_ROLE.OWNER },
      }),
      createParams({ orgId: ORG_ID, memberId: MEMBER_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 403 when trying to change OWNER's role", async () => {
    mockPrismaOrgMember.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      orgId: ORG_ID,
      userId: "owner-user",
      role: ORG_ROLE.OWNER,
      deactivatedAt: null,
    });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/members/${MEMBER_ID}`, {
        body: { role: ORG_ROLE.ADMIN },
      }),
      createParams({ orgId: ORG_ID, memberId: MEMBER_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 403 when ADMIN tries to change role of equal-level member", async () => {
    mockRequireOrgPermission.mockResolvedValue({ ...ownerMembership, role: ORG_ROLE.ADMIN });
    mockIsRoleAbove.mockReturnValue(false);
    mockPrismaOrgMember.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      orgId: ORG_ID,
      userId: "other-admin",
      role: ORG_ROLE.ADMIN,
      deactivatedAt: null,
    });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/members/${MEMBER_ID}`, {
        body: { role: ORG_ROLE.MEMBER },
      }),
      createParams({ orgId: ORG_ID, memberId: MEMBER_ID }),
    );
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/orgs/[orgId]/members/[memberId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireOrgPermission.mockResolvedValue(ownerMembership);
    mockIsRoleAbove.mockReturnValue(true);
  });

  it("returns OrgAuthError status when DELETE permission denied", async () => {
    mockRequireOrgPermission.mockRejectedValue(new OrgAuthError("INSUFFICIENT_PERMISSION", 403));
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/orgs/${ORG_ID}/members/${MEMBER_ID}`),
      createParams({ orgId: ORG_ID, memberId: MEMBER_ID }),
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("INSUFFICIENT_PERMISSION");
  });

  it("rethrows non-OrgAuthError from DELETE", async () => {
    mockRequireOrgPermission.mockRejectedValue(new Error("unexpected"));
    await expect(
      DELETE(
        createRequest("DELETE", `http://localhost:3000/api/orgs/${ORG_ID}/members/${MEMBER_ID}`),
        createParams({ orgId: ORG_ID, memberId: MEMBER_ID }),
      ),
    ).rejects.toThrow("unexpected");
  });

  it("returns 403 when ADMIN tries to remove equal-level member", async () => {
    mockRequireOrgPermission.mockResolvedValue({ ...ownerMembership, role: ORG_ROLE.ADMIN });
    mockIsRoleAbove.mockReturnValue(false);
    mockPrismaOrgMember.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      orgId: ORG_ID,
      userId: "other-admin",
      role: ORG_ROLE.ADMIN,
      deactivatedAt: null,
    });
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/orgs/${ORG_ID}/members/${MEMBER_ID}`),
      createParams({ orgId: ORG_ID, memberId: MEMBER_ID }),
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("CANNOT_REMOVE_HIGHER_ROLE");
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/orgs/${ORG_ID}/members/${MEMBER_ID}`),
      createParams({ orgId: ORG_ID, memberId: MEMBER_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when member not found", async () => {
    mockPrismaOrgMember.findUnique.mockResolvedValue(null);
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/orgs/${ORG_ID}/members/${MEMBER_ID}`),
      createParams({ orgId: ORG_ID, memberId: MEMBER_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 when trying to remove OWNER", async () => {
    mockPrismaOrgMember.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      orgId: ORG_ID,
      role: ORG_ROLE.OWNER,
      deactivatedAt: null,
    });
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/orgs/${ORG_ID}/members/${MEMBER_ID}`),
      createParams({ orgId: ORG_ID, memberId: MEMBER_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("removes member successfully and deletes OrgMemberKeys", async () => {
    mockPrismaOrgMember.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      orgId: ORG_ID,
      userId: "target-user",
      role: ORG_ROLE.MEMBER,
      deactivatedAt: null,
    });
    mockTransaction.mockResolvedValue([]);

    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/orgs/${ORG_ID}/members/${MEMBER_ID}`),
      createParams({ orgId: ORG_ID, memberId: MEMBER_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockTransaction).toHaveBeenCalledWith([
      mockPrismaOrgMemberKey.deleteMany({ where: { orgId: ORG_ID, userId: "target-user" } }),
      mockPrismaOrgMember.delete({ where: { id: MEMBER_ID } }),
    ]);
  });
});