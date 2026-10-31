import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaTeamInvitation, mockPrismaUser, mockPrismaTeam, mockPrismaTeamMember, mockRequireTeamPermission, TeamAuthError, mockWithTeamTenantRls, mockWithBypassRls } = vi.hoisted(() => {
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
    mockPrismaTeamInvitation: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    mockPrismaUser: { findUnique: vi.fn(), findMany: vi.fn() },
    mockPrismaTeam: { findUnique: vi.fn() },
    mockPrismaTeamMember: { findUnique: vi.fn(), findMany: vi.fn() },
    mockRequireTeamPermission: vi.fn(),
    TeamAuthError: _TeamAuthError,
    // The issuing transaction runs as fn(tenantId, tx); tx is the prisma mock.
    mockWithTeamTenantRls: vi.fn(async (_teamId: string, fn: (tenantId: string, tx: unknown) => unknown) =>
      fn("tenant-1", (await import("@/lib/prisma")).prisma)),
    mockWithBypassRls: vi.fn(async (prisma: unknown, fn: (tx: unknown) => unknown) => fn(prisma)),
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamInvitation: mockPrismaTeamInvitation,
    user: mockPrismaUser,
    team: mockPrismaTeam,
    teamMember: mockPrismaTeamMember,
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));
vi.mock("@/lib/auth/access/team-auth", () => ({
  requireTeamPermission: mockRequireTeamPermission,
  TeamAuthError,
}));
const { mockLockTenantRows } = vi.hoisted(() => ({ mockLockTenantRows: vi.fn() }));
vi.mock("@/lib/team/tenant-row-lock", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  lockTenantRows: mockLockTenantRows,
}));
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: mockWithTeamTenantRls,
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));

import { GET, POST } from "./route";
import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import { TEAM_ROLE, INVITATION_STATUS } from "@/lib/constants";

const TEAM_ID = "team-123";
const now = new Date("2025-01-01T00:00:00Z");

describe("GET /api/teams/[teamId]/invitations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireTeamPermission.mockResolvedValue({ role: TEAM_ROLE.ADMIN });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/invitations`),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when lacking invite permission", async () => {
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("FORBIDDEN", 403));
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/invitations`),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("returns list of pending invitations", async () => {
    mockPrismaTeamInvitation.findMany.mockResolvedValue([
      {
        id: "inv-1",
        email: "user@test.com",
        role: TEAM_ROLE.MEMBER,
        token: "abc123",
        status: INVITATION_STATUS.PENDING,
        expiresAt: now,
        createdAt: now,
        invitedById: "u1",
      },
    ]);
    mockPrismaUser.findMany.mockResolvedValue([{ id: "u1", name: "Admin", email: "admin@test.com", image: null }]);

    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/invitations`),
      createParams({ teamId: TEAM_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toHaveLength(1);
    expect(json[0].email).toBe("user@test.com");
    expect(json[0]).not.toHaveProperty("token");
    expect(json[0].invitedBy).toEqual({ id: "u1", name: "Admin", email: "admin@test.com" });
    expect(mockWithBypassRls).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function),
      BYPASS_GRANT.CROSS_TENANT_USER_LOOKUP,
    );
  });

  it("lists an invitation whose inviter's users row does not come back, with an id-only inviter, and reads no user relation in the tenant context", async () => {
    mockPrismaTeamInvitation.findMany.mockResolvedValue([
      {
        id: "inv-1",
        email: "user@test.com",
        role: TEAM_ROLE.MEMBER,
        token: "abc123",
        status: INVITATION_STATUS.PENDING,
        expiresAt: now,
        createdAt: now,
        invitedById: "u-departed",
      },
    ]);
    mockPrismaUser.findMany.mockResolvedValue([]);

    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/invitations`),
      createParams({ teamId: TEAM_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json[0].invitedBy).toEqual({ id: "u-departed", name: null, email: null });
    expect(mockPrismaTeamInvitation.findMany.mock.calls[0][0]).not.toHaveProperty("include");
  });
});

describe("POST /api/teams/[teamId]/invitations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireTeamPermission.mockResolvedValue({ role: TEAM_ROLE.ADMIN });
    mockPrismaUser.findMany.mockResolvedValue([]);
    mockPrismaTeam.findUnique.mockResolvedValue({ name: "Team", tenantId: "tenant-1" });
    mockPrismaTeamMember.findMany.mockResolvedValue([]);
    mockPrismaTeamInvitation.findMany.mockResolvedValue([]);
    mockPrismaTeamInvitation.updateMany.mockResolvedValue({ count: 0 });
    mockLockTenantRows.mockResolvedValue(new Map());
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/invitations`, {
        body: { email: "new@test.com", role: TEAM_ROLE.MEMBER },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 on invalid body", async () => {
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/invitations`, {
        body: { email: "invalid" },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 409 when user is already a member", async () => {
    mockPrismaUser.findMany.mockResolvedValue([{ id: "existing-user" }]);
    mockPrismaTeamMember.findMany.mockResolvedValue([{ deactivatedAt: null, scimManaged: false, deactivatedByTenant: false }]);

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/invitations`, {
        body: { email: "existing@test.com", role: TEAM_ROLE.MEMBER },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("ALREADY_A_MEMBER");
  });

  it("blocks re-inviting a guest member found via bypass user lookup", async () => {
    mockPrismaUser.findMany.mockResolvedValue([{ id: "guest-user" }]);
    mockPrismaTeamMember.findMany.mockResolvedValue([{ deactivatedAt: null, scimManaged: false, deactivatedByTenant: false }]);

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/invitations`, {
        body: { email: "guest@test.com", role: TEAM_ROLE.ADMIN },
      }),
      createParams({ teamId: TEAM_ID }),
    );

    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("ALREADY_A_MEMBER");
    expect(mockWithBypassRls).toHaveBeenCalledTimes(1);
    expect(mockPrismaUser.findMany).toHaveBeenCalledWith({
      where: { email: { equals: "guest@test.com", mode: "insensitive" } },
      select: { id: true },
    });
    expect(mockPrismaTeamInvitation.create).not.toHaveBeenCalled();
  });

  it("returns 409 when invitation already pending", async () => {
    mockPrismaTeamInvitation.findMany.mockResolvedValue([{ id: "existing-inv", createdAt: now }]);

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/invitations`, {
        body: { email: "pending@test.com", role: TEAM_ROLE.MEMBER },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("INVITATION_ALREADY_SENT");
  });

  it("creates invitation successfully (201)", async () => {
    mockPrismaTeamInvitation.create.mockResolvedValue({
      id: "new-inv",
      email: "new@test.com",
      role: TEAM_ROLE.MEMBER,
      token: "generated-token",
      expiresAt: now,
      createdAt: now,
    });

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/invitations`, {
        body: { email: "new@test.com", role: TEAM_ROLE.MEMBER },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json.email).toBe("new@test.com");
    expect(json.token).toBeDefined();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
  describe("re-invitation after a tenant departure", () => {
    const invite = (email = "left@test.com") =>
      POST(
        createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/invitations`, { body: { email, role: TEAM_ROLE.MEMBER } }),
        createParams({ teamId: TEAM_ID }),
      );
    const departed = (deactivatedAt: Date) =>
      new Map([["left-user", { hasRow: true, deactivatedAt, departedAt: null }]]);

    beforeEach(() => {
      mockPrismaUser.findMany.mockResolvedValue([{ id: "left-user" }]);
      mockPrismaTeamInvitation.create.mockResolvedValue({ id: "new-inv", email: "left@test.com", role: TEAM_ROLE.MEMBER, token: "t", expiresAt: now, createdAt: now });
    });

    it("expires a pending invitation issued before the invitee left and issues a new one", async () => {
      mockPrismaTeamInvitation.findMany.mockResolvedValue([{ id: "stale-inv", createdAt: now }]);
      mockLockTenantRows.mockResolvedValue(departed(new Date(now.getTime() + 1)));

      const res = await invite();

      expect(res.status).toBe(201);
      expect(mockPrismaTeamInvitation.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ["stale-inv"] }, status: INVITATION_STATUS.PENDING },
        data: { status: INVITATION_STATUS.EXPIRED },
      });
      expect(mockPrismaTeamInvitation.create).toHaveBeenCalledOnce();
    });

    it("treats a pending invitation issued at the instant of the departure as stale", async () => {
      mockPrismaTeamInvitation.findMany.mockResolvedValue([{ id: "stale-inv", createdAt: now }]);
      mockLockTenantRows.mockResolvedValue(departed(now));

      expect((await invite()).status).toBe(201);
    });

    it("keeps refusing a pending invitation issued after the departure", async () => {
      mockPrismaTeamInvitation.findMany.mockResolvedValue([{ id: "live-inv", createdAt: now }]);
      mockLockTenantRows.mockResolvedValue(departed(new Date(now.getTime() - 1)));

      const res = await invite();

      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("INVITATION_ALREADY_SENT");
      expect(mockPrismaTeamInvitation.create).not.toHaveBeenCalled();
    });

    it("re-invites a SCIM-managed membership the tenant departure ended", async () => {
      mockPrismaTeamMember.findMany.mockResolvedValue([{ deactivatedAt: now, scimManaged: true, deactivatedByTenant: true }]);

      expect((await invite()).status).toBe(201);
    });

    it("still refuses a SCIM-managed membership the IdP's group removal ended", async () => {
      mockPrismaTeamMember.findMany.mockResolvedValue([{ deactivatedAt: now, scimManaged: true, deactivatedByTenant: false }]);

      const res = await invite();

      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("SCIM_MANAGED_MEMBER");
    });

    it("locks the inviter's and every case variant's tenant row before issuing", async () => {
      mockPrismaUser.findMany.mockResolvedValue([{ id: "left-user" }, { id: "left-user-upper" }]);

      await invite("Left@Test.com");

      expect(mockLockTenantRows).toHaveBeenCalledWith(
        expect.anything(), "tenant-1", ["test-user-id", "left-user", "left-user-upper"], "share", expect.anything(),
      );
      expect(mockLockTenantRows.mock.invocationCallOrder[0]).toBeLessThan(mockPrismaTeamInvitation.create.mock.invocationCallOrder[0]);
    });
  });
});
