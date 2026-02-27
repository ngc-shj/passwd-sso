import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaTeamMember, mockPrismaTeamMemberKey, mockPrismaScimExternalMapping, mockTransaction, mockRequireTeamPermission, mockIsRoleAbove, TeamAuthError, mockWithUserTenantRls } = vi.hoisted(() => {
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
    mockPrismaTeamMember: {
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    mockPrismaTeamMemberKey: {
      deleteMany: vi.fn(),
    },
    mockPrismaScimExternalMapping: {
      deleteMany: vi.fn(),
    },
    mockTransaction: vi.fn(),
    mockRequireTeamPermission: vi.fn(),
    mockIsRoleAbove: vi.fn(),
    TeamAuthError: _TeamAuthError,
    mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamMember: mockPrismaTeamMember,
    teamMemberKey: mockPrismaTeamMemberKey,
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
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));

import { PUT, DELETE } from "./route";
import { TEAM_ROLE } from "@/lib/constants";

const TEAM_ID = "team-123";
const MEMBER_ID = "member-target";

const ownerMembership = { id: "member-owner", teamId: TEAM_ID, userId: "test-user-id", role: TEAM_ROLE.OWNER };

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
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      teamId: TEAM_ID,
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
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      teamId: TEAM_ID,
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
    mockPrismaTeamMember.findUnique.mockResolvedValue(null);
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`, {
        body: { role: TEAM_ROLE.ADMIN },
      }),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("changes member role (OWNER changes MEMBER to ADMIN)", async () => {
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      teamId: TEAM_ID,
      userId: "target-user",
      role: TEAM_ROLE.MEMBER,
      deactivatedAt: null,
    });
    mockPrismaTeamMember.update.mockResolvedValue({
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
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      teamId: TEAM_ID,
      userId: "target-user",
      role: TEAM_ROLE.ADMIN,
      deactivatedAt: null,
    });
    mockPrismaTeamMember.update.mockResolvedValue({
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
    expect(mockPrismaTeamMember.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ownerMembership.id }, data: { role: TEAM_ROLE.ADMIN } }),
    );
  });

  it("returns 403 when non-OWNER tries to transfer ownership", async () => {
    mockRequireTeamPermission.mockResolvedValue({ ...ownerMembership, role: TEAM_ROLE.ADMIN });
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      teamId: TEAM_ID,
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
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      teamId: TEAM_ID,
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
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      teamId: TEAM_ID,
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
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      teamId: TEAM_ID,
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
    mockPrismaTeamMember.findUnique.mockResolvedValue(null);
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 when trying to remove OWNER", async () => {
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      teamId: TEAM_ID,
      role: TEAM_ROLE.OWNER,
      deactivatedAt: null,
    });
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("removes member successfully and deletes TeamMemberKeys", async () => {
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      teamId: TEAM_ID,
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
      mockPrismaTeamMemberKey.deleteMany({ where: { teamId: TEAM_ID, userId: "target-user" } }),
      mockPrismaScimExternalMapping.deleteMany({ where: { teamId: TEAM_ID, internalId: "target-user", resourceType: "User" } }),
      mockPrismaTeamMember.delete({ where: { id: MEMBER_ID } }),
    ]);
  });
});
