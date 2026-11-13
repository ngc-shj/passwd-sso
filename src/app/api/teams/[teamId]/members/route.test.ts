import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const {
  mockAuth,
  mockPrismaTeam,
  mockPrismaTeamMember,
  mockPrismaTeamMemberKey,
  mockPrismaTenantMember,
  mockPrismaUser,
  mockPrismaTransaction,
  mockRequireTeamMember,
  mockRequireTeamPermission,
  TeamAuthError,
  mockWithTeamTenantRls,
  mockWithBypassRls,
  mockLogAudit,
  mockRequireRecentSession,
} = vi.hoisted(() => {
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
    mockPrismaTeam: { findUnique: vi.fn() },
    mockPrismaTeamMember: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), count: vi.fn() },
    mockPrismaTeamMemberKey: { deleteMany: vi.fn() },
    mockPrismaTenantMember: { findMany: vi.fn(), findFirst: vi.fn() },
    mockPrismaUser: { findFirst: vi.fn(), findMany: vi.fn() },
    mockPrismaTransaction: vi.fn(),
    mockRequireTeamMember: vi.fn(),
    mockRequireTeamPermission: vi.fn(),
    TeamAuthError: _TeamAuthError,
    // The admission transaction runs as fn(tenantId, tx); tx is the prisma mock.
    mockWithTeamTenantRls: vi.fn(async (_teamId: string, fn: (tenantId: string, tx: unknown) => unknown) =>
      fn("tenant-1", (await import("@/lib/prisma")).prisma)),
    mockWithBypassRls: vi.fn(async (prisma: unknown, fn: (tx: unknown) => unknown) => fn(prisma)),
    mockLogAudit: vi.fn(),
    mockRequireRecentSession: vi.fn().mockResolvedValue(null),
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    team: mockPrismaTeam,
    teamMember: mockPrismaTeamMember,
    teamMemberKey: mockPrismaTeamMemberKey,
    tenantMember: mockPrismaTenantMember,
    user: mockPrismaUser,
    $transaction: mockPrismaTransaction,
  },
}));
vi.mock("@/lib/auth/access/team-auth", async () => ({
  requireTeamMember: mockRequireTeamMember,
  requireTeamPermission: mockRequireTeamPermission,
  // The real role → permission table: GET lists departed members only to roles that can remove them.
  hasTeamPermission: (await vi.importActual<typeof import("@/lib/auth/access/team-auth")>("@/lib/auth/access/team-auth")).hasTeamPermission,
  activeTeamRole: (await vi.importActual<typeof import("@/lib/auth/access/team-auth")>("@/lib/auth/access/team-auth")).activeTeamRole,
  TeamAuthError,
}));
const { mockLockTenantRows, mockLockTeamsAgainstRotation } = vi.hoisted(() => ({
  mockLockTenantRows: vi.fn(),
  mockLockTeamsAgainstRotation: vi.fn(),
}));
vi.mock("@/lib/team/tenant-row-lock", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  lockTenantRows: mockLockTenantRows,
}));
vi.mock("@/lib/team/team-key-rotation-lock", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  lockTeamsAgainstRotation: mockLockTeamsAgainstRotation,
}));
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: mockWithTeamTenantRls,
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: vi.fn(() => ({ ip: "127.0.0.1", userAgent: "test" })),
  teamAuditBase: vi.fn((_, userId, teamId) => ({ scope: "TEAM", userId, teamId })),
}));
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: mockRequireRecentSession,
}));

import { GET, POST } from "./route";
import { TEAM_ROLE } from "@/lib/constants";
import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";

const TEAM_ID = "team-123";
const TENANT_ID = "tenant-456";
const now = new Date("2025-01-01T00:00:00Z");

describe("GET /api/teams/[teamId]/members", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireTeamMember.mockResolvedValue({ role: TEAM_ROLE.OWNER });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/members`),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when not a member", async () => {
    mockRequireTeamMember.mockRejectedValue(new TeamAuthError("NOT_FOUND", 404));
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/members`),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("returns list of members with tenantName", async () => {
    mockPrismaTeamMember.findMany.mockResolvedValue([
      {
        id: "m1",
        userId: "u1",
        role: TEAM_ROLE.OWNER,
        createdAt: now,
      },
      {
        id: "m2",
        userId: "u2",
        role: TEAM_ROLE.MEMBER,
        createdAt: now,
      },
    ]);
    mockPrismaUser.findMany.mockResolvedValue([
      { id: "u1", name: "Owner", email: "owner@test.com", image: null },
      { id: "u2", name: "Member", email: "member@test.com", image: null },
    ]);
    mockPrismaTenantMember.findMany.mockResolvedValue([
      { userId: "u1", tenant: { name: "Acme Corp" } },
      { userId: "u2", tenant: { name: "External Org" } },
    ]);

    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/members`),
      createParams({ teamId: TEAM_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toHaveLength(2);
    expect(json[0].role).toBe(TEAM_ROLE.OWNER);
    expect(json[0].tenantName).toBe("Acme Corp");
    expect(json[1].role).toBe(TEAM_ROLE.MEMBER);
    expect(json[1].tenantName).toBe("External Org");
  });

  it("lists members who left the tenant, flagged departed, and SCIM-pending members, flagged pendingApproval, to a role that can invite and remove", async () => {
    mockPrismaTeamMember.findMany.mockResolvedValue([
      { id: "m1", userId: "u1", role: TEAM_ROLE.OWNER, createdAt: now, deactivatedByTenant: false, scimApprovalPending: false },
      { id: "m2", userId: "u2", role: TEAM_ROLE.MEMBER, createdAt: now, deactivatedByTenant: true, scimApprovalPending: false },
      { id: "m3", userId: "u3", role: TEAM_ROLE.VIEWER, createdAt: now, deactivatedByTenant: false, scimApprovalPending: true },
    ]);
    mockPrismaUser.findMany.mockResolvedValue([
      { id: "u1", name: "Owner", email: "owner@test.com", image: null },
      { id: "u2", name: "Left", email: "left@test.com", image: null },
      { id: "u3", name: "Pending", email: "pending@test.com", image: null },
    ]);
    mockPrismaTenantMember.findMany.mockResolvedValue([]);

    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/members`),
      createParams({ teamId: TEAM_ID }),
    );
    const json = await res.json();

    expect(json.map((m: { id: string; departed: boolean; pendingApproval: boolean }) => [m.id, m.departed, m.pendingApproval])).toEqual([
      ["m1", false, false],
      ["m2", true, false],
      ["m3", false, true],
    ]);
    expect(mockPrismaTeamMember.findMany.mock.calls[0][0].where).toEqual({
      teamId: TEAM_ID,
      OR: [{ deactivatedAt: null }, { deactivatedByTenant: true }, { scimApprovalPending: true }],
    });
  });

  it("flags a pending row pendingTenantInactive when the user's active tenant isn't the team's own (absent or elsewhere)", async () => {
    mockPrismaTeamMember.findMany.mockResolvedValue([
      { id: "m1", userId: "u1", role: TEAM_ROLE.VIEWER, createdAt: now, deactivatedByTenant: false, scimApprovalPending: true },
      { id: "m2", userId: "u2", role: TEAM_ROLE.VIEWER, createdAt: now, deactivatedByTenant: false, scimApprovalPending: true },
      { id: "m3", userId: "u3", role: TEAM_ROLE.VIEWER, createdAt: now, deactivatedByTenant: false, scimApprovalPending: true },
    ]);
    mockPrismaUser.findMany.mockResolvedValue([
      { id: "u1", name: "In team's tenant", email: "u1@test.com", image: null },
      { id: "u2", name: "In another tenant", email: "u2@test.com", image: null },
      { id: "u3", name: "No active tenant", email: "u3@test.com", image: null },
    ]);
    // mockWithTeamTenantRls above hands the route "tenant-1" as the team's
    // own tenantId. u1 is active there; u2 is active in a different tenant;
    // u3 has no active tenantMember row at all (departed/absent).
    mockPrismaTenantMember.findMany.mockResolvedValue([
      { userId: "u1", tenantId: "tenant-1", tenant: { name: "Team Tenant" } },
      { userId: "u2", tenantId: "tenant-other", tenant: { name: "Other Tenant" } },
    ]);

    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/members`),
      createParams({ teamId: TEAM_ID }),
    );
    const json = await res.json();

    expect(json.map((m: { id: string; pendingTenantInactive: boolean }) => [m.id, m.pendingTenantInactive])).toEqual([
      ["m1", false],
      ["m2", true],
      ["m3", true],
    ]);
  });

  // S-R2-1/F-N5/T-N1 (review round 2): a user can hold an active tenantMember
  // row in the team's own tenant AND a second tenant at once — pending must
  // read as active-in-team regardless of which row a last-wins Map would
  // have kept, so both createdAt orderings are exercised.
  it.each([
    ["the team-tenant row listed first", [
      { userId: "u1", tenantId: "tenant-1", tenant: { name: "Team Tenant" } },
      { userId: "u1", tenantId: "tenant-other", tenant: { name: "Other Tenant" } },
    ]],
    ["the other-tenant row listed first", [
      { userId: "u1", tenantId: "tenant-other", tenant: { name: "Other Tenant" } },
      { userId: "u1", tenantId: "tenant-1", tenant: { name: "Team Tenant" } },
    ]],
  ])("does not flag pendingTenantInactive for a pending user active in both the team tenant and another tenant, %s", async (_label, userTenants) => {
    mockPrismaTeamMember.findMany.mockResolvedValue([
      { id: "m1", userId: "u1", role: TEAM_ROLE.VIEWER, createdAt: now, deactivatedByTenant: false, scimApprovalPending: true },
    ]);
    mockPrismaUser.findMany.mockResolvedValue([
      { id: "u1", name: "Dual tenant", email: "u1@test.com", image: null },
    ]);
    mockPrismaTenantMember.findMany.mockResolvedValue(userTenants);

    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/members`),
      createParams({ teamId: TEAM_ID }),
    );
    const json = await res.json();

    expect(json[0].pendingTenantInactive).toBe(false);
  });

  it("does not list members who left the tenant, or pending ones, to a VIEWER", async () => {
    mockRequireTeamMember.mockResolvedValue({ role: TEAM_ROLE.VIEWER });
    mockPrismaTeamMember.findMany.mockResolvedValue([]);

    await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/members`),
      createParams({ teamId: TEAM_ID }),
    );

    expect(mockPrismaTeamMember.findMany.mock.calls[0][0].where).toEqual({ teamId: TEAM_ID, deactivatedAt: null });
  });

  it("returns tenantName null when member has no tenant", async () => {
    mockPrismaTeamMember.findMany.mockResolvedValue([
      {
        id: "m1",
        userId: "u1",
        role: TEAM_ROLE.OWNER,
        createdAt: now,
      },
    ]);
    mockPrismaUser.findMany.mockResolvedValue([
      { id: "u1", name: "Owner", email: "owner@test.com", image: null },
    ]);
    mockPrismaTenantMember.findMany.mockResolvedValue([]);

    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/members`),
      createParams({ teamId: TEAM_ID }),
    );
    const json = await res.json();
    expect(json[0].tenantName).toBeNull();
  });

  it("uses withBypassRls for tenant member lookup", async () => {
    mockPrismaTeamMember.findMany.mockResolvedValue([
      {
        id: "m1",
        userId: "u1",
        role: TEAM_ROLE.OWNER,
        createdAt: now,
      },
    ]);
    mockPrismaUser.findMany.mockResolvedValue([
      { id: "u1", name: "Owner", email: "owner@test.com", image: null },
    ]);
    mockPrismaTenantMember.findMany.mockResolvedValue([]);

    await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/members`),
      createParams({ teamId: TEAM_ID }),
    );
    expect(mockWithBypassRls).toHaveBeenCalledTimes(1);
    expect(mockWithBypassRls).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function),
      BYPASS_GRANT.TEAM_MEMBER_DISPLAY_LOOKUP,
    );
  });

  it("excludes members whose user profile is not visible in the bypass lookup", async () => {
    // Route-level guard for C1 invariant: members missing a hydratable user
    // profile must be omitted from the response, not surfaced as null entries.
    mockPrismaTeamMember.findMany.mockResolvedValue([
      { id: "m1", userId: "u1", role: TEAM_ROLE.OWNER, createdAt: now },
      { id: "m2", userId: "u-orphan", role: TEAM_ROLE.MEMBER, createdAt: now },
    ]);
    mockPrismaUser.findMany.mockResolvedValue([
      { id: "u1", name: "Owner", email: "owner@test.com", image: null },
    ]);
    mockPrismaTenantMember.findMany.mockResolvedValue([
      { userId: "u1", tenant: { name: "Acme Corp" } },
    ]);

    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/members`),
      createParams({ teamId: TEAM_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toHaveLength(1);
    expect(json[0].userId).toBe("u1");
    expect(mockPrismaTenantMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: { in: ["u1", "u-orphan"] }, deactivatedAt: null },
      }),
    );
  });

  it("keeps a cross-tenant guest visible by loading user profiles outside team RLS", async () => {
    mockPrismaTeamMember.findMany.mockResolvedValue([
      {
        id: "m1",
        userId: "owner-user",
        role: TEAM_ROLE.OWNER,
        createdAt: now,
      },
      {
        id: "m2",
        userId: "guest-user",
        role: TEAM_ROLE.MEMBER,
        createdAt: now,
      },
    ]);
    mockPrismaUser.findMany.mockResolvedValue([
      { id: "owner-user", name: "Owner", email: "owner@test.com", image: null },
      { id: "guest-user", name: "Guest", email: "guest@test.com", image: null },
    ]);
    mockPrismaTenantMember.findMany.mockResolvedValue([
      { userId: "owner-user", tenant: { name: "Team Tenant" } },
      { userId: "guest-user", tenant: { name: "Guest Tenant" } },
    ]);

    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/members`),
      createParams({ teamId: TEAM_ID }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual([
      expect.objectContaining({ userId: "owner-user", email: "owner@test.com" }),
      expect.objectContaining({ userId: "guest-user", email: "guest@test.com", tenantName: "Guest Tenant" }),
    ]);
    expect(mockPrismaUser.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["owner-user", "guest-user"] } },
      select: { id: true, name: true, email: true, image: true },
    });
  });
});

const actorRole: { value: { role: string } | null } = { value: null };
const existingTarget: { value: unknown } = { value: null };

describe("POST /api/teams/[teamId]/members", () => {
  const TARGET_USER_ID = "00000000-0000-4000-a000-000000000001";

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireTeamPermission.mockResolvedValue({ id: "actor-row", role: TEAM_ROLE.ADMIN });
    // findFirst serves two reads: the acting member's role under the locks
    // (activeTeamRole selects `role`) and the target's existing membership.
    actorRole.value = { role: TEAM_ROLE.ADMIN };
    existingTarget.value = null;
    mockPrismaTeamMember.findFirst.mockImplementation(async (args: { select?: { role?: boolean } }) =>
      args?.select?.role ? actorRole.value : existingTarget.value);
    mockPrismaTeam.findUnique.mockResolvedValue({ tenantId: TENANT_ID });
    mockPrismaUser.findFirst.mockResolvedValue({ id: TARGET_USER_ID });
    mockPrismaTenantMember.findFirst.mockResolvedValue({ id: "tm-1" });
    // The target's tenant row, locked FOR SHARE: active by default.
    mockLockTenantRows.mockResolvedValue(new Map([[TARGET_USER_ID, { hasRow: true, deactivatedAt: null, departedAt: null }]]));
    mockLockTeamsAgainstRotation.mockResolvedValue(undefined);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/members`, {
        body: { userId: TARGET_USER_ID, role: TEAM_ROLE.MEMBER },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when insufficient permission", async () => {
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("FORBIDDEN", 403));
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/members`, {
        body: { userId: TARGET_USER_ID, role: TEAM_ROLE.MEMBER },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 403 when step-up reauth is required", async () => {
    mockRequireRecentSession.mockResolvedValueOnce(
      Response.json({ error: "SESSION_STEP_UP_REQUIRED" }, { status: 403 }),
    );
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/members`, {
        body: { userId: TARGET_USER_ID, role: TEAM_ROLE.MEMBER },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(403);
    expect(json.error).toBe("SESSION_STEP_UP_REQUIRED");
    expect(mockPrismaTeamMember.create).not.toHaveBeenCalled();
    expect(mockPrismaTransaction).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid body", async () => {
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/members`, {
        body: { role: TEAM_ROLE.MEMBER },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("creates a new team member", async () => {
    mockPrismaTeamMember.create.mockResolvedValue({
      id: "new-m-1",
      userId: TARGET_USER_ID,
      role: TEAM_ROLE.MEMBER,
    });

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/members`, {
        body: { userId: TARGET_USER_ID, role: TEAM_ROLE.MEMBER },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json.userId).toBe(TARGET_USER_ID);
    expect(json.reactivated).toBe(false);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "TEAM_MEMBER_ADD",
        targetType: "TeamMember",
        targetId: "new-m-1",
        metadata: expect.objectContaining({
          userId: TARGET_USER_ID,
          role: TEAM_ROLE.MEMBER,
          reactivated: false,
        }),
      }),
    );
  });

  it("reactivates a deactivated member", async () => {
    existingTarget.value = ({
      id: "existing-m-1",
      userId: TARGET_USER_ID,
      deactivatedAt: new Date(),
      scimManaged: false,
    });
    mockPrismaTeamMember.update.mockResolvedValue({ id: "existing-m-1", userId: TARGET_USER_ID, role: TEAM_ROLE.MEMBER });

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/members`, {
        body: { userId: TARGET_USER_ID, role: TEAM_ROLE.MEMBER },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json.reactivated).toBe(true);
    expect(mockPrismaTeamMemberKey.deleteMany).toHaveBeenCalledWith({
      where: { teamId: TEAM_ID, userId: TARGET_USER_ID },
    });
    expect(mockPrismaTeamMember.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ deactivatedAt: null, deactivatedByTenant: false, keyDistributed: false }),
    }));
  });

  it("re-adds a SCIM-managed membership the tenant departure ended", async () => {
    existingTarget.value = ({
      id: "existing-m-1", userId: TARGET_USER_ID, deactivatedAt: new Date(), scimManaged: true, deactivatedByTenant: true,
    });
    mockPrismaTeamMember.update.mockResolvedValue({ id: "existing-m-1", userId: TARGET_USER_ID, role: TEAM_ROLE.MEMBER });

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/members`, { body: { userId: TARGET_USER_ID, role: TEAM_ROLE.MEMBER } }),
      createParams({ teamId: TEAM_ID }),
    );

    expect(res.status).toBe(201);
    expect((await res.json()).reactivated).toBe(true);
  });

  it("locks the target's tenant row, then the team, before reading the membership", async () => {
    mockPrismaTeamMember.create.mockResolvedValue({ id: "new-m-1", userId: TARGET_USER_ID, role: TEAM_ROLE.MEMBER });

    await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/members`, { body: { userId: TARGET_USER_ID, role: TEAM_ROLE.MEMBER } }),
      createParams({ teamId: TEAM_ID }),
    );

    // The target's row and the acting member's, in one call.
    expect(mockLockTenantRows).toHaveBeenCalledWith(expect.anything(), "tenant-1", [TARGET_USER_ID, "test-user-id"], "share", expect.anything());
    expect(mockLockTenantRows.mock.invocationCallOrder[0]).toBeLessThan(mockLockTeamsAgainstRotation.mock.invocationCallOrder[0]);
    expect(mockLockTeamsAgainstRotation.mock.invocationCallOrder[0]).toBeLessThan(mockPrismaTeamMember.findFirst.mock.invocationCallOrder[0]);
  });

  it("refuses, adding nothing, when the acting member's membership ended after the permission check", async () => {
    actorRole.value = null;

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/members`, { body: { userId: TARGET_USER_ID, role: TEAM_ROLE.MEMBER } }),
      createParams({ teamId: TEAM_ID }),
    );

    expect(res.status).toBe(403);
    expect(mockPrismaTeamMember.create).not.toHaveBeenCalled();
    const actorRead = mockPrismaTeamMember.findFirst.mock.calls.findIndex((c) => (c[0] as { select?: { role?: boolean } })?.select?.role);
    expect(mockPrismaTeamMember.findFirst.mock.calls[actorRead][0]).toEqual({
      where: { teamId: TEAM_ID, userId: "test-user-id", deactivatedAt: null },
      select: { role: true },
    });
    // Read under the locks, not before them.
    expect(mockLockTeamsAgainstRotation.mock.invocationCallOrder[0]).toBeLessThan(
      mockPrismaTeamMember.findFirst.mock.invocationCallOrder[actorRead],
    );
  });

  it("refuses when the acting member was demoted to a role that cannot add members", async () => {
    actorRole.value = { role: TEAM_ROLE.VIEWER };

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/members`, { body: { userId: TARGET_USER_ID, role: TEAM_ROLE.MEMBER } }),
      createParams({ teamId: TEAM_ID }),
    );

    expect(res.status).toBe(403);
    expect(mockPrismaTeamMember.create).not.toHaveBeenCalled();
  });

  it("answers 409 TEAM_BUSY with Retry-After when the team row lock wait times out", async () => {
    const { TeamRotationInProgressError } = await vi.importActual<typeof import("@/lib/team/team-key-rotation-lock")>("@/lib/team/team-key-rotation-lock");
    mockLockTeamsAgainstRotation.mockRejectedValue(new TeamRotationInProgressError());

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/members`, { body: { userId: TARGET_USER_ID, role: TEAM_ROLE.MEMBER } }),
      createParams({ teamId: TEAM_ID }),
    );

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("TEAM_BUSY");
    expect(res.headers.get("Retry-After")).toBe("3");
    expect(mockPrismaTeamMember.create).not.toHaveBeenCalled();
  });

  it("answers 409 CONFLICT without Retry-After when the target's tenant row is held past the lock wait", async () => {
    const { TenantMemberLockTimeoutError } = await vi.importActual<typeof import("@/lib/team/tenant-row-lock")>("@/lib/team/tenant-row-lock");
    mockLockTenantRows.mockRejectedValue(new TenantMemberLockTimeoutError());

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/members`, { body: { userId: TARGET_USER_ID, role: TEAM_ROLE.MEMBER } }),
      createParams({ teamId: TEAM_ID }),
    );

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("CONFLICT");
    expect(res.headers.get("Retry-After")).toBeNull();
    expect(mockPrismaTeamMember.create).not.toHaveBeenCalled();
  });

  it("returns 409 for active member", async () => {
    existingTarget.value = ({
      id: "existing-m-1",
      userId: TARGET_USER_ID,
      deactivatedAt: null,
      scimManaged: false,
    });

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/members`, {
        body: { userId: TARGET_USER_ID, role: TEAM_ROLE.MEMBER },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("ALREADY_A_MEMBER");
  });

  it("returns 409 for SCIM-managed deactivated member", async () => {
    existingTarget.value = ({
      id: "existing-m-1",
      userId: TARGET_USER_ID,
      deactivatedAt: new Date(),
      scimManaged: true,
    });

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/members`, {
        body: { userId: TARGET_USER_ID, role: TEAM_ROLE.MEMBER },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("SCIM_MANAGED_MEMBER");
  });

  it("returns 409 SCIM_APPROVAL_PENDING for a pending member, ahead of SCIM_MANAGED_MEMBER (a pending row is always scimManaged too)", async () => {
    existingTarget.value = ({
      id: "existing-m-1",
      userId: TARGET_USER_ID,
      deactivatedAt: new Date(),
      scimManaged: true,
      scimApprovalPending: true,
    });

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/members`, {
        body: { userId: TARGET_USER_ID, role: TEAM_ROLE.MEMBER },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("SCIM_APPROVAL_PENDING");
    expect(mockPrismaTeamMember.update).not.toHaveBeenCalled();
  });

  it("accepts an uppercase spelling of the target's id, locking and adding the lowercase id", async () => {
    mockPrismaTeamMember.create.mockResolvedValue({ id: "new-m-1", userId: TARGET_USER_ID, role: TEAM_ROLE.MEMBER });

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/members`, { body: { userId: TARGET_USER_ID.toUpperCase(), role: TEAM_ROLE.MEMBER } }),
      createParams({ teamId: TEAM_ID }),
    );

    expect(res.status).toBe(201);
    expect(mockLockTenantRows).toHaveBeenCalledWith(expect.anything(), "tenant-1", [TARGET_USER_ID, "test-user-id"], "share", expect.anything());
  });

  it("refuses adding oneself under an uppercase spelling of one's own id", async () => {
    const self = "00000000-0000-4000-a000-0000000000ff";
    mockAuth.mockResolvedValue({ user: { id: self } });

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/members`, { body: { userId: self.toUpperCase(), role: TEAM_ROLE.MEMBER } }),
      createParams({ teamId: TEAM_ID }),
    );

    expect(res.status).toBe(400);
    expect(mockPrismaTeamMember.create).not.toHaveBeenCalled();
  });

  it("returns 404 when target user not in tenant", async () => {
    // The target's tenant row, locked: absent.
    mockLockTenantRows.mockResolvedValue(new Map([[TARGET_USER_ID, { hasRow: false, deactivatedAt: null, departedAt: null }]]));

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/members`, {
        body: { userId: TARGET_USER_ID, role: TEAM_ROLE.MEMBER },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when user exists but has no active tenant membership", async () => {
    mockLockTenantRows.mockResolvedValue(new Map([[TARGET_USER_ID, { hasRow: true, deactivatedAt: new Date(), departedAt: null }]]));

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/members`, {
        body: { userId: TARGET_USER_ID, role: TEAM_ROLE.MEMBER },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 409 on Prisma unique constraint race condition", async () => {
    const p2002Error = Object.assign(new Error("Unique constraint"), {
      code: "P2002",
      meta: { target: ["teamId", "userId"] },
    });
    mockPrismaTeamMember.create.mockRejectedValue(p2002Error);

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/members`, {
        body: { userId: TARGET_USER_ID, role: TEAM_ROLE.MEMBER },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(409);
  });

  it("re-throws P2002 with no meta.target (unknown constraint)", async () => {
    const p2002Error = Object.assign(new Error("Unique constraint"), {
      code: "P2002",
    });
    mockPrismaTeamMember.create.mockRejectedValue(p2002Error);

    await expect(
      POST(
        createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/members`, {
          body: { userId: TARGET_USER_ID, role: TEAM_ROLE.MEMBER },
        }),
        createParams({ teamId: TEAM_ID }),
      ),
    ).rejects.toThrow();
  });

  it("re-throws P2002 for unrelated constraint", async () => {
    const p2002Error = Object.assign(new Error("Unique constraint"), {
      code: "P2002",
      meta: { target: ["email"] },
    });
    mockPrismaTeamMember.create.mockRejectedValue(p2002Error);

    await expect(
      POST(
        createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/members`, {
          body: { userId: TARGET_USER_ID, role: TEAM_ROLE.MEMBER },
        }),
        createParams({ teamId: TEAM_ID }),
      ),
    ).rejects.toThrow();
  });

  it("returns 400 when adding yourself", async () => {
    mockAuth.mockResolvedValue({ user: { id: TARGET_USER_ID } });

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/members`, {
        body: { userId: TARGET_USER_ID, role: TEAM_ROLE.MEMBER },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(400);
  });
});
