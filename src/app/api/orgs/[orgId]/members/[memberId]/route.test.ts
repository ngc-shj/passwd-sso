import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaOrgMember, mockRequireOrgPermission, mockIsRoleAbove, OrgAuthError } = vi.hoisted(() => {
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
    mockRequireOrgPermission: vi.fn(),
    mockIsRoleAbove: vi.fn(),
    OrgAuthError: _OrgAuthError,
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { orgMember: mockPrismaOrgMember, auditLog: { create: vi.fn().mockResolvedValue({}) } },
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
    });
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/orgs/${ORG_ID}/members/${MEMBER_ID}`),
      createParams({ orgId: ORG_ID, memberId: MEMBER_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("removes member successfully", async () => {
    mockPrismaOrgMember.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      orgId: ORG_ID,
      role: ORG_ROLE.MEMBER,
    });
    mockPrismaOrgMember.delete.mockResolvedValue({});

    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/orgs/${ORG_ID}/members/${MEMBER_ID}`),
      createParams({ orgId: ORG_ID, memberId: MEMBER_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
  });
});