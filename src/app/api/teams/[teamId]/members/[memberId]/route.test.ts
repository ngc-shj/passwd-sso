import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaOrgMember, mockPrismaOrgMemberKey, mockPrismaScimExternalMapping, mockTransaction, mockRequireTeamPermission, mockIsRoleAbove, TeamAuthError } = vi.hoisted(() => {
  class _TeamAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "TeamAuthError";
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
    mockPrismaScimExternalMapping: {
      deleteMany: vi.fn(),
    },
    mockTransaction: vi.fn(),
    mockRequireTeamPermission: vi.fn(),
    mockIsRoleAbove: vi.fn(),
    TeamAuthError: _TeamAuthError,
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    orgMember: mockPrismaOrgMember,
    orgMemberKey: mockPrismaOrgMemberKey,
    scimExternalMapping: mockPrismaScimExternalMapping,
    $transaction: mockTransaction,
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));
vi.mock("@/lib/team-auth", () => ({
  requireTeamPermission: mockRequireTeamPermission,
  isRoleAbove: mockIsRoleAbove,
  TeamAuthError,
}));

import { PUT, DELETE } from "./route";
import { TEAM_ROLE } from "@/lib/constants";

const TEAM_ID = "org-123";
const MEMBER_ID = "member-target";

const ownerMembership = { id: "member-owner", orgId: TEAM_ID, userId: "test-user-id", role: TEAM_ROLE.OWNER };

describe("PUT /api/teams/[teamId]/members/[memberId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireTeamPermission.mockResolvedValue(ownerMembership);
    mockIsRoleAbove.mockReturnValue(true);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`, {
        body: { role: TEAM_ROLE.ADMIN },
      }),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when lacking permission", async () => {
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("FORBIDDEN", 403));
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`, {
        body: { role: TEAM_ROLE.ADMIN },
      }),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("rethrows non-TeamAuthError from PUT", async () => {
    mockRequireTeamPermission.mockRejectedValue(new Error("unexpected"));
    await expect(
      PUT(
        createRequest("PUT", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`, {
          body: { role: TEAM_ROLE.ADMIN },
        }),
        createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
      ),
    ).rejects.toThrow("unexpected");
  });

  it("returns 400 on malformed JSON", async () => {
    const { NextRequest } = await import("next/server");
    const req = new NextRequest(`http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`, {
      method: "PUT",
      body: "not-json",
      headers: { "Content-Type": "application/json" },
    });
    mockPrismaOrgMember.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      orgId: TEAM_ID,
      userId: "target-user",
      role: TEAM_ROLE.MEMBER,
      deactivatedAt: null,
    });
    const res = await PUT(req, createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("INVALID_JSON");
  });

  it("returns 400 on validation error", async () => {
    mockPrismaOrgMember.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      orgId: TEAM_ID,
      userId: "target-user",
      role: TEAM_ROLE.MEMBER,
      deactivatedAt: null,
    });
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`, {
        body: { role: "INVALID_ROLE" },
      }),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 404 when member not found", async () => {
    mockPrismaOrgMember.findUnique.mockResolvedValue(null);
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`, {
        body: { role: TEAM_ROLE.ADMIN },
      }),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("changes member role (OWNER changes MEMBER to ADMIN)", async () => {
    mockPrismaOrgMember.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      orgId: TEAM_ID,
      userId: "target-user",
      role: TEAM_ROLE.MEMBER,
      deactivatedAt: null,
    });
    mockPrismaOrgMember.update.mockResolvedValue({
      id: MEMBER_ID,
      userId: "target-user",
      role: TEAM_ROLE.ADMIN,
      user: { id: "target-user", name: "Target", email: "t@test.com", image: null },
    });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`, {
        body: { role: TEAM_ROLE.ADMIN },
      }),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.role).toBe(TEAM_ROLE.ADMIN);
  });

  it("transfers ownership: promotes target to OWNER, demotes self to ADMIN", async () => {
    mockPrismaOrgMember.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      orgId: TEAM_ID,
      userId: "target-user",
      role: TEAM_ROLE.ADMIN,
      deactivatedAt: null,
    });
    mockPrismaOrgMember.update.mockResolvedValue({
      id: MEMBER_ID,
      userId: "target-user",
      role: TEAM_ROLE.OWNER,
      user: { id: "target-user", name: "New Owner", email: "new@test.com", image: null },
    });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`, {
        body: { role: TEAM_ROLE.OWNER },
      }),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.role).toBe(TEAM_ROLE.OWNER);
    // Actor should be demoted to ADMIN
    expect(mockPrismaOrgMember.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ownerMembership.id }, data: { role: TEAM_ROLE.ADMIN } }),
    );
  });

  it("returns 403 when non-OWNER tries to transfer ownership", async () => {
    mockRequireTeamPermission.mockResolvedValue({ ...ownerMembership, role: TEAM_ROLE.ADMIN });
    mockPrismaOrgMember.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      orgId: TEAM_ID,
      userId: "target-user",
      role: TEAM_ROLE.MEMBER,
      deactivatedAt: null,
    });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`, {
        body: { role: TEAM_ROLE.OWNER },
      }),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 403 when trying to change OWNER's role", async () => {
    mockPrismaOrgMember.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      orgId: TEAM_ID,
      userId: "owner-user",
      role: TEAM_ROLE.OWNER,
      deactivatedAt: null,
    });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`, {
        body: { role: TEAM_ROLE.ADMIN },
      }),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 403 when ADMIN tries to change role of equal-level member", async () => {
    mockRequireTeamPermission.mockResolvedValue({ ...ownerMembership, role: TEAM_ROLE.ADMIN });
    mockIsRoleAbove.mockReturnValue(false);
    mockPrismaOrgMember.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      orgId: TEAM_ID,
      userId: "other-admin",
      role: TEAM_ROLE.ADMIN,
      deactivatedAt: null,
    });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`, {
        body: { role: TEAM_ROLE.MEMBER },
      }),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/teams/[teamId]/members/[memberId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireTeamPermission.mockResolvedValue(ownerMembership);
    mockIsRoleAbove.mockReturnValue(true);
  });

  it("returns TeamAuthError status when DELETE permission denied", async () => {
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("INSUFFICIENT_PERMISSION", 403));
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("INSUFFICIENT_PERMISSION");
  });

  it("rethrows non-TeamAuthError from DELETE", async () => {
    mockRequireTeamPermission.mockRejectedValue(new Error("unexpected"));
    await expect(
      DELETE(
        createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`),
        createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
      ),
    ).rejects.toThrow("unexpected");
  });

  it("returns 403 when ADMIN tries to remove equal-level member", async () => {
    mockRequireTeamPermission.mockResolvedValue({ ...ownerMembership, role: TEAM_ROLE.ADMIN });
    mockIsRoleAbove.mockReturnValue(false);
    mockPrismaOrgMember.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      orgId: TEAM_ID,
      userId: "other-admin",
      role: TEAM_ROLE.ADMIN,
      deactivatedAt: null,
    });
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("CANNOT_REMOVE_HIGHER_ROLE");
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when member not found", async () => {
    mockPrismaOrgMember.findUnique.mockResolvedValue(null);
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 when trying to remove OWNER", async () => {
    mockPrismaOrgMember.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      orgId: TEAM_ID,
      role: TEAM_ROLE.OWNER,
      deactivatedAt: null,
    });
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("removes member successfully and deletes OrgMemberKeys", async () => {
    mockPrismaOrgMember.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      orgId: TEAM_ID,
      userId: "target-user",
      role: TEAM_ROLE.MEMBER,
      deactivatedAt: null,
    });
    mockTransaction.mockResolvedValue([]);

    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockTransaction).toHaveBeenCalledWith([
      mockPrismaOrgMemberKey.deleteMany({ where: { orgId: TEAM_ID, userId: "target-user" } }),
      mockPrismaScimExternalMapping.deleteMany({ where: { orgId: TEAM_ID, internalId: "target-user", resourceType: "User" } }),
      mockPrismaOrgMember.delete({ where: { id: MEMBER_ID } }),
    ]);
  });
});