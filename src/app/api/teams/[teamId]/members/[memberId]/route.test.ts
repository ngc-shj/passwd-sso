import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaTeamMember, mockPrismaTeamMemberKey, mockPrismaScimExternalMapping, mockTransaction, mockTeamLockQuery, mockRequireTeamPermission, mockIsRoleAbove, TeamAuthError, mockWithTeamTenantRls, mockInvalidateUserSessions, mockLogger, mockLogAudit, mockBuildTeamMemberDisplayItems, mockRequireRecentSession, mockTenantMemberFindMany, mockTenantMemberDepartureFindMany, mockExecuteRaw } = vi.hoisted(() => {
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
      // The conditional writes under the team lock, and the re-read of the
      // changed row for the response.
      findUniqueOrThrow: vi.fn(),
      // The acting member's role, re-read under the locks (activeTeamAdmission for PUT, activeTeamRole for DELETE).
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    mockPrismaTeamMemberKey: {
      deleteMany: vi.fn(),
    },
    mockPrismaScimExternalMapping: {
      deleteMany: vi.fn(),
    },
    mockTransaction: vi.fn(),
    // The removal's team lock (SELECT id FROM teams ... FOR SHARE).
    mockTeamLockQuery: vi.fn(),
    // The advisory locks (pg_advisory_xact_lock) and lock_timeout set/restore.
    mockExecuteRaw: vi.fn(),
    mockRequireTeamPermission: vi.fn(),
    mockIsRoleAbove: vi.fn(),
    TeamAuthError: _TeamAuthError,
    // The removal runs on the context's transaction client (fn's second argument).
    mockWithTeamTenantRls: vi.fn(async (_teamId: string, fn: (tenantId: string, tx: unknown) => unknown) =>
      fn("tenant-1", {
        $queryRaw: mockTeamLockQuery,
        // set / restore lock_timeout around the team lock.
        $executeRaw: mockExecuteRaw,
        teamMember: mockPrismaTeamMember,
        teamMemberKey: mockPrismaTeamMemberKey,
        tenantMember: { findMany: mockTenantMemberFindMany },
        tenantMemberDeparture: { findMany: mockTenantMemberDepartureFindMany },
      }),
    ),
    mockInvalidateUserSessions: vi.fn().mockResolvedValue({ sessions: 1, extensionTokens: 0, apiKeys: 0 }),
    mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    mockLogAudit: vi.fn(),
    mockBuildTeamMemberDisplayItems: vi.fn(),
    mockRequireRecentSession: vi.fn().mockResolvedValue(null),
    // The target's tenant row and departure record, read unlocked (readTenantRows).
    mockTenantMemberFindMany: vi.fn(),
    mockTenantMemberDepartureFindMany: vi.fn(),
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
vi.mock("@/lib/auth/access/team-auth", async () => ({
  requireTeamPermission: mockRequireTeamPermission,
  isRoleAbove: mockIsRoleAbove,
  // The real role reads and permission table: routes re-check the actor under their locks.
  activeTeamAdmission: (await vi.importActual<typeof import("@/lib/auth/access/team-auth")>("@/lib/auth/access/team-auth")).activeTeamAdmission,
  activeTeamRole: (await vi.importActual<typeof import("@/lib/auth/access/team-auth")>("@/lib/auth/access/team-auth")).activeTeamRole,
  hasTeamPermission: (await vi.importActual<typeof import("@/lib/auth/access/team-auth")>("@/lib/auth/access/team-auth")).hasTeamPermission,
  TeamAuthError,
}));
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: mockWithTeamTenantRls,
}));
vi.mock("@/lib/auth/session/user-session-invalidation", () => ({
  invalidateUserSessions: mockInvalidateUserSessions,
}));
vi.mock("@/lib/logger", () => ({
  getLogger: () => mockLogger,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: vi.fn().mockReturnValue({ ip: "127.0.0.1", userAgent: "test" }),
  teamAuditBase: vi.fn((_, userId, teamId) => ({ scope: "TEAM", userId, teamId })),
}));
vi.mock("@/lib/team/team-member-display", () => ({
  buildTeamMemberDisplayItems: mockBuildTeamMemberDisplayItems,
}));
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: mockRequireRecentSession,
}));

import { PUT, DELETE } from "./route";
import { teamLockQuery, lockQueryCalls } from "@/__tests__/helpers/team-rotation-lock-mock";
import { TEAM_ROLE } from "@/lib/constants";

const TEAM_ID = "team-123";
const MEMBER_ID = "member-target";

const ACTOR_ADMITTED_AT = new Date("2026-03-01T00:00:00.000Z");
const asActor = (role: string) => ({ role, admittedAt: ACTOR_ADMITTED_AT, createdAt: ACTOR_ADMITTED_AT });
const TARGET_ADMITTED_AT = new Date("2026-04-01T00:00:00.000Z");
/** The target's row as the route re-reads it under the locks (by member id). */
const lockedTarget = (over: Record<string, unknown> = {}) => ({
  userId: "target-user", admittedAt: TARGET_ADMITTED_AT, createdAt: TARGET_ADMITTED_AT, ...over,
});
/** findFirst under the locks: the target's re-read (by member id), else the acting member's admission. */
const memberReads = (actorRole: string, target: Record<string, unknown> = lockedTarget()) =>
  async ({ where }: { where: { id?: string } }) => (where.id !== undefined ? target : asActor(actorRole));

const ownerMembership = { id: "member-owner", teamId: TEAM_ID, userId: "test-user-id", role: TEAM_ROLE.OWNER };

describe("PUT /api/teams/[teamId]/members/[memberId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireTeamPermission.mockResolvedValue(ownerMembership);
    mockIsRoleAbove.mockReturnValue(true);
    mockTeamLockQuery.mockImplementation(teamLockQuery([{ id: TEAM_ID }]));
    mockPrismaTeamMember.updateMany.mockResolvedValue({ count: 1 });
    mockPrismaTeamMember.findFirst.mockImplementation(memberReads(TEAM_ROLE.OWNER));
    mockTenantMemberFindMany.mockResolvedValue([]);
    mockTenantMemberDepartureFindMany.mockResolvedValue([]);
    mockBuildTeamMemberDisplayItems.mockResolvedValue([
      {
        id: MEMBER_ID,
        userId: "target-user",
        role: TEAM_ROLE.ADMIN,
        name: "Target",
        email: "t@test.com",
        image: null,
        joinedAt: new Date("2025-01-01T00:00:00Z"),
        tenantName: "Guest Tenant",
      },
    ]);
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
    const createdAt = new Date("2025-01-01T00:00:00Z");
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      teamId: TEAM_ID,
      userId: "target-user",
      role: TEAM_ROLE.MEMBER,
      deactivatedAt: null,
    });
    mockPrismaTeamMember.findUniqueOrThrow.mockResolvedValue({
      id: MEMBER_ID,
      userId: "target-user",
      role: TEAM_ROLE.ADMIN,
      createdAt,
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
    expect(json.email).toBe("t@test.com");
    expect(mockBuildTeamMemberDisplayItems).toHaveBeenCalledWith([
      {
        id: MEMBER_ID,
        userId: "target-user",
        role: TEAM_ROLE.ADMIN,
        createdAt,
      },
    ]);
  });

  it("transfers ownership: promotes target to OWNER, demotes self to ADMIN", async () => {
    const createdAt = new Date("2025-01-01T00:00:00Z");
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      teamId: TEAM_ID,
      userId: "target-user",
      role: TEAM_ROLE.ADMIN,
      deactivatedAt: null,
    });
    const updatedOwner = {
      id: MEMBER_ID,
      userId: "target-user",
      role: TEAM_ROLE.OWNER,
      createdAt,
    };
    mockBuildTeamMemberDisplayItems.mockResolvedValue([
      {
        ...updatedOwner,
        name: "New Owner",
        email: "new@test.com",
        image: null,
        joinedAt: createdAt,
        tenantName: "Guest Tenant",
      },
    ]);
    mockPrismaTeamMember.findUniqueOrThrow.mockResolvedValue(updatedOwner);

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`, {
        body: { role: TEAM_ROLE.OWNER },
      }),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.role).toBe(TEAM_ROLE.OWNER);
    // Actor should be demoted to ADMIN, the target promoted — each only
    // while still an active member, under the team lock.
    expect(mockPrismaTeamMember.updateMany).toHaveBeenCalledWith({
      where: { id: ownerMembership.id, teamId: TEAM_ID, role: TEAM_ROLE.OWNER, deactivatedAt: null },
      data: { role: TEAM_ROLE.ADMIN },
    });
    expect(mockPrismaTeamMember.updateMany).toHaveBeenCalledWith({
      where: { id: MEMBER_ID, teamId: TEAM_ID, deactivatedAt: null },
      data: { role: TEAM_ROLE.OWNER },
    });
  });

  it("refuses the transfer, changing nothing, when the target left the tenant since the check", async () => {
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: MEMBER_ID, teamId: TEAM_ID, userId: "target-user", role: TEAM_ROLE.ADMIN, deactivatedAt: null,
    });
    // Demoting the actor matches; promoting the target does not: their
    // membership was deactivated by a departure committed in between.
    mockPrismaTeamMember.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`, { body: { role: TEAM_ROLE.OWNER } }),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );

    expect(res.status).toBe(404);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("refuses the transfer (403), changing nothing, when the acting OWNER was demoted since the check", async () => {
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: MEMBER_ID, teamId: TEAM_ID, userId: "target-user", role: TEAM_ROLE.ADMIN, deactivatedAt: null,
    });
    mockPrismaTeamMember.findFirst.mockResolvedValue(asActor(TEAM_ROLE.ADMIN));

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`, { body: { role: TEAM_ROLE.OWNER } }),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );

    expect(res.status).toBe(403);
    expect(mockPrismaTeamMember.updateMany).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("answers 409 CONFLICT without Retry-After, changing nothing, when the transferring OWNER's tenant row is held past the lock wait", async () => {
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: MEMBER_ID, teamId: TEAM_ID, userId: "target-user", role: TEAM_ROLE.ADMIN, deactivatedAt: null,
    });
    mockTeamLockQuery.mockImplementation(teamLockQuery((sql) => {
      if (sql.includes("FROM tenant_members")) throw Object.assign(new Error("lock timeout"), { code: "55P03" });
      return [{ id: TEAM_ID }];
    }));

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`, { body: { role: TEAM_ROLE.OWNER } }),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("CONFLICT");
    expect(res.headers.get("Retry-After")).toBeNull();
    expect(mockPrismaTeamMember.updateMany).not.toHaveBeenCalled();
  });

  it("answers 409 TEAM_BUSY with Retry-After, changing nothing, when the team row lock wait times out (PUT transfer)", async () => {
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: MEMBER_ID, teamId: TEAM_ID, userId: "target-user", role: TEAM_ROLE.ADMIN, deactivatedAt: null,
    });
    mockTeamLockQuery.mockImplementation(teamLockQuery((sql) => {
      if (sql.includes("FROM teams")) throw Object.assign(new Error("lock timeout"), { code: "55P03" });
      return [{ id: TEAM_ID }];
    }));

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`, { body: { role: TEAM_ROLE.OWNER } }),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("TEAM_BUSY");
    expect(res.headers.get("Retry-After")).toBe("3");
    expect(mockPrismaTeamMember.updateMany).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("refuses a role change when the acting member left the tenant since the permission check", async () => {
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: MEMBER_ID, teamId: TEAM_ID, userId: "target-user", role: TEAM_ROLE.MEMBER, deactivatedAt: null,
    });
    mockPrismaTeamMember.findFirst.mockResolvedValue(null);

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`, { body: { role: TEAM_ROLE.ADMIN } }),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );

    expect(res.status).toBe(403);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("refuses (403) a role change when the acting member was demoted to the target's rank since the check", async () => {
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: MEMBER_ID, teamId: TEAM_ID, userId: "target-user", role: TEAM_ROLE.ADMIN, deactivatedAt: null,
    });
    mockPrismaTeamMember.findFirst.mockResolvedValue(asActor(TEAM_ROLE.ADMIN));
    mockIsRoleAbove.mockImplementation((a: string, b: string) => a === "OWNER" && b !== "OWNER");

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`, { body: { role: TEAM_ROLE.MEMBER } }),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );

    expect(res.status).toBe(403);
    expect(mockPrismaTeamMember.updateMany).not.toHaveBeenCalled();
  });

  it("re-reads the acting member's role after their tenant row and the team are locked (PUT)", async () => {
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: MEMBER_ID, teamId: TEAM_ID, userId: "target-user", role: TEAM_ROLE.MEMBER, deactivatedAt: null,
    });
    mockPrismaTeamMember.findUniqueOrThrow.mockResolvedValue({ id: MEMBER_ID, userId: "target-user", role: TEAM_ROLE.ADMIN, createdAt: new Date() });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`, { body: { role: TEAM_ROLE.ADMIN } }),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );

    expect(res.status).toBe(200);
    expect(mockPrismaTeamMember.findFirst).toHaveBeenCalledWith({
      where: { teamId: TEAM_ID, userId: "test-user-id", deactivatedAt: null },
      select: { role: true, admittedAt: true, createdAt: true },
    });
    const calls = lockQueryCalls(mockTeamLockQuery);
    const tenantRowLocks = calls.filter((c) => c.sql.includes("FROM tenant_members"));
    const teamLock = calls.find((c) => c.sql.includes("FROM teams"))!;
    // Only the actor's tenant row is locked (row or advisory): a lock on the
    // target serialises the change behind any SCIM transaction on that user.
    expect(tenantRowLocks.map((c) => c.values)).toEqual([["tenant-1", ["test-user-id"]]]);
    const actorRow = tenantRowLocks[0];
    expect(JSON.stringify(mockExecuteRaw.mock.calls)).not.toContain("target-user");
    expect(actorRow.order).toBeLessThan(teamLock.order);
    expect(teamLock.order).toBeLessThan(mockPrismaTeamMember.findFirst.mock.invocationCallOrder[0]);
    expect(mockTenantMemberFindMany).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1", userId: { in: ["target-user"] } },
      select: { userId: true, role: true, deactivatedAt: true },
    });
    expect(teamLock.order).toBeLessThan(mockTenantMemberFindMany.mock.invocationCallOrder[0]);
  });

  describe("a target who left the tenant, judged against their admission to the team", () => {
    const at = (ms: number) => new Date(TARGET_ADMITTED_AT.getTime() + ms);
    /** Answer the target's unlocked tenant row and departure record (the acting OWNER is a guest). */
    const targetTenantState = (deactivatedAt: Date | null, departedAt: Date | null = null, hasRow = true) => {
      mockTenantMemberFindMany.mockResolvedValue(
        hasRow ? [{ userId: "target-user", role: "MEMBER", deactivatedAt }] : [],
      );
      mockTenantMemberDepartureFindMany.mockResolvedValue(
        departedAt ? [{ userId: "target-user", departedAt }] : [],
      );
    };
    const change = (fromRole: string, toRole: string) => {
      mockPrismaTeamMember.findUnique.mockResolvedValue({
        id: MEMBER_ID, teamId: TEAM_ID, userId: "target-user", role: fromRole, deactivatedAt: null,
      });
      mockPrismaTeamMember.findUniqueOrThrow.mockResolvedValue({ id: MEMBER_ID, userId: "target-user", role: toRole, createdAt: new Date() });
      return PUT(
        createRequest("PUT", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`, { body: { role: toRole } }),
        createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
      );
    };
    const expectRefusedUnchanged = async (res: Response) => {
      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe("MEMBER_NOT_FOUND");
      expect(mockPrismaTeamMember.updateMany).not.toHaveBeenCalled();
      expect(mockLogAudit).not.toHaveBeenCalled();
    };

    beforeEach(async () => {
      // The real hierarchy: whether the change is a promotion decides.
      const { isRoleAbove } = await vi.importActual<typeof import("@/lib/auth/access/team-role-hierarchy")>(
        "@/lib/auth/access/team-role-hierarchy",
      );
      mockIsRoleAbove.mockImplementation(isRoleAbove);
    });

    it("refuses (404 MEMBER_NOT_FOUND) promoting a target whose tenant row departed after their admission", async () => {
      targetTenantState(at(1));

      await expectRefusedUnchanged(await change(TEAM_ROLE.MEMBER, TEAM_ROLE.ADMIN));
    });

    it("refuses promoting a target whose departure equals their admission", async () => {
      targetTenantState(at(0));

      await expectRefusedUnchanged(await change(TEAM_ROLE.VIEWER, TEAM_ROLE.MEMBER));
    });

    it("refuses promoting a target whose departure record (row deleted) postdates their admission", async () => {
      targetTenantState(null, at(1), false);

      await expectRefusedUnchanged(await change(TEAM_ROLE.MEMBER, TEAM_ROLE.ADMIN));
    });

    it("refuses transferring ownership to a leftover target", async () => {
      targetTenantState(at(1));

      await expectRefusedUnchanged(await change(TEAM_ROLE.ADMIN, TEAM_ROLE.OWNER));
    });

    it("refuses when the row re-read under the locks is no longer the pre-checked user's", async () => {
      targetTenantState(null);
      mockPrismaTeamMember.findFirst.mockImplementation(memberReads(TEAM_ROLE.OWNER, lockedTarget({ userId: "other-user" })));

      await expectRefusedUnchanged(await change(TEAM_ROLE.MEMBER, TEAM_ROLE.ADMIN));
    });

    it("allows demoting a leftover target: it reduces authority", async () => {
      targetTenantState(at(1));

      expect((await change(TEAM_ROLE.ADMIN, TEAM_ROLE.VIEWER)).status).toBe(200);
      expect(mockPrismaTeamMember.updateMany).toHaveBeenCalledWith({
        where: { id: MEMBER_ID, teamId: TEAM_ID, deactivatedAt: null, role: TEAM_ROLE.ADMIN },
        data: { role: TEAM_ROLE.VIEWER },
      });
    });

    it("promotes a guest, an active, a re-admitted and a re-provisioned target", async () => {
      for (const [setup, target] of [
        [() => targetTenantState(null, null, false), lockedTarget()],
        [() => targetTenantState(null), lockedTarget()],
        // created before the departure, re-admitted after it: admitted_at decides.
        [() => targetTenantState(at(-1000)), lockedTarget({ createdAt: at(-5000) })],
        [() => targetTenantState(null, at(-1000)), lockedTarget()],
      ] as const) {
        setup();
        mockPrismaTeamMember.findFirst.mockImplementation(memberReads(TEAM_ROLE.OWNER, target));
        expect((await change(TEAM_ROLE.MEMBER, TEAM_ROLE.ADMIN)).status).toBe(200);
      }
    });

    it("transfers ownership to a guest, an active, a re-admitted and a re-provisioned target", async () => {
      for (const [setup, target] of [
        [() => targetTenantState(null, null, false), lockedTarget()],
        [() => targetTenantState(null), lockedTarget()],
        [() => targetTenantState(at(-1000)), lockedTarget({ createdAt: at(-5000) })],
        [() => targetTenantState(null, at(-1000)), lockedTarget()],
      ] as const) {
        setup();
        mockPrismaTeamMember.findFirst.mockImplementation(memberReads(TEAM_ROLE.OWNER, target));
        expect((await change(TEAM_ROLE.ADMIN, TEAM_ROLE.OWNER)).status).toBe(200);
      }
    });
  });

  describe("an acting OWNER who left the tenant, judged against their admission to the team", () => {
    const after = (ms: number) => new Date(ACTOR_ADMITTED_AT.getTime() + ms);
    /** Answer the actor's tenant row and departure record to the real lockTenantRows. */
    const actorTenantState = (deactivatedAt: Date | null, departedAt: Date | null = null, hasRow = true) =>
      mockTeamLockQuery.mockImplementation(teamLockQuery((sql) => {
        if (sql.includes("FROM tenant_members")) {
          return hasRow ? [{ user_id: "test-user-id", role: "MEMBER", deactivated_at: deactivatedAt }] : [];
        }
        if (sql.includes("FROM tenant_member_departures")) {
          return departedAt ? [{ user_id: "test-user-id", departed_at: departedAt }] : [];
        }
        return [{ id: TEAM_ID }];
      }));
    const change = (role: string) =>
      PUT(
        createRequest("PUT", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`, { body: { role } }),
        createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
      );

    beforeEach(() => {
      mockPrismaTeamMember.findUnique.mockResolvedValue({
        id: MEMBER_ID, teamId: TEAM_ID, userId: "target-user", role: TEAM_ROLE.MEMBER, deactivatedAt: null,
      });
      mockPrismaTeamMember.findUniqueOrThrow.mockResolvedValue({ id: MEMBER_ID, userId: "target-user", role: TEAM_ROLE.ADMIN, createdAt: new Date() });
    });

    it("refuses a role change (403), changing nothing", async () => {
      actorTenantState(after(1));

      expect((await change(TEAM_ROLE.ADMIN)).status).toBe(403);
      expect(mockPrismaTeamMember.updateMany).not.toHaveBeenCalled();
      expect(mockLogAudit).not.toHaveBeenCalled();
    });

    it("refuses an ownership transfer (403), changing nothing", async () => {
      actorTenantState(after(1));
      mockPrismaTeamMember.findUnique.mockResolvedValue({
        id: MEMBER_ID, teamId: TEAM_ID, userId: "target-user", role: TEAM_ROLE.ADMIN, deactivatedAt: null,
      });

      expect((await change(TEAM_ROLE.OWNER)).status).toBe(403);
      expect(mockPrismaTeamMember.updateMany).not.toHaveBeenCalled();
      expect(mockLogAudit).not.toHaveBeenCalled();
    });

    it("allows a guest OWNER, an active one, a re-admitted one and a re-provisioned one to change a role", async () => {
      for (const setup of [
        () => actorTenantState(null, null, false),
        () => actorTenantState(null),
        () => actorTenantState(after(-1000)),
        () => actorTenantState(null, after(-1000)),
      ]) {
        setup();
        expect((await change(TEAM_ROLE.ADMIN)).status).toBe(200);
      }
    });

    it("allows an active OWNER to transfer ownership", async () => {
      actorTenantState(null);
      mockPrismaTeamMember.findUnique.mockResolvedValue({
        id: MEMBER_ID, teamId: TEAM_ID, userId: "target-user", role: TEAM_ROLE.ADMIN, deactivatedAt: null,
      });
      mockPrismaTeamMember.findUniqueOrThrow.mockResolvedValue({ id: MEMBER_ID, userId: "target-user", role: TEAM_ROLE.OWNER, createdAt: new Date() });

      expect((await change(TEAM_ROLE.OWNER)).status).toBe(200);
    });
  });

  it("answers 409 CONFLICT without Retry-After when the acting member's tenant row is held past the lock wait (PUT)", async () => {
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: MEMBER_ID, teamId: TEAM_ID, userId: "target-user", role: TEAM_ROLE.MEMBER, deactivatedAt: null,
    });
    mockTeamLockQuery.mockImplementation(teamLockQuery((sql) => {
      if (sql.includes("FROM tenant_members")) throw Object.assign(new Error("lock timeout"), { code: "55P03" });
      return [{ id: TEAM_ID }];
    }));

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`, { body: { role: TEAM_ROLE.ADMIN } }),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("CONFLICT");
    expect(res.headers.get("Retry-After")).toBeNull();
    expect(mockPrismaTeamMember.updateMany).not.toHaveBeenCalled();
  });

  it("answers 409 TEAM_BUSY with Retry-After when the team row lock wait times out (PUT)", async () => {
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: MEMBER_ID, teamId: TEAM_ID, userId: "target-user", role: TEAM_ROLE.MEMBER, deactivatedAt: null,
    });
    mockTeamLockQuery.mockImplementation(teamLockQuery((sql) => {
      if (sql.includes("FROM teams")) throw Object.assign(new Error("lock timeout"), { code: "55P03" });
      return [{ id: TEAM_ID }];
    }));

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`, { body: { role: TEAM_ROLE.ADMIN } }),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("TEAM_BUSY");
    expect(res.headers.get("Retry-After")).toBe("3");
    expect(mockPrismaTeamMember.updateMany).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("keeps a cross-tenant guest visible in the role update response", async () => {
    const createdAt = new Date("2025-01-01T00:00:00Z");
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      teamId: TEAM_ID,
      userId: "guest-user",
      role: TEAM_ROLE.MEMBER,
      deactivatedAt: null,
    });
    mockPrismaTeamMember.findUniqueOrThrow.mockResolvedValue({
      id: MEMBER_ID,
      userId: "guest-user",
      role: TEAM_ROLE.ADMIN,
      createdAt,
    });
    mockPrismaTeamMember.findFirst.mockImplementation(memberReads(TEAM_ROLE.OWNER, lockedTarget({ userId: "guest-user" })));
    mockBuildTeamMemberDisplayItems.mockResolvedValue([
      {
        id: MEMBER_ID,
        userId: "guest-user",
        role: TEAM_ROLE.ADMIN,
        name: "Guest User",
        email: "guest@test.com",
        image: null,
        joinedAt: createdAt,
        tenantName: "Guest Tenant",
      },
    ]);

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`, {
        body: { role: TEAM_ROLE.ADMIN },
      }),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      id: MEMBER_ID,
      userId: "guest-user",
      role: TEAM_ROLE.ADMIN,
      name: "Guest User",
      email: "guest@test.com",
      image: null,
      tenantName: "Guest Tenant",
    });
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

  it("returns 403 when step-up reauth is required", async () => {
    mockRequireRecentSession.mockResolvedValueOnce(
      Response.json({ error: "SESSION_STEP_UP_REQUIRED" }, { status: 403 }),
    );
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`, {
        body: { role: TEAM_ROLE.ADMIN },
      }),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(403);
    expect(json.error).toBe("SESSION_STEP_UP_REQUIRED");
    expect(mockPrismaTeamMember.updateMany).not.toHaveBeenCalled();
    // Pins that step-up fires BEFORE the existence lookup — a future reorder
    // moving the gate after findUnique would reach this call and regress.
    expect(mockPrismaTeamMember.findUnique).not.toHaveBeenCalled();
  });

  it("binds the step-up gate to the actor, not the member being changed", async () => {
    // The gate binds freshness to the user whose session row it reads, so it
    // must get the actor `auth()` resolved — never the target id in scope.
    await PUT(
      createRequest("PUT", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`, {
        body: { role: TEAM_ROLE.ADMIN },
      }),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );
    expect(mockRequireRecentSession).toHaveBeenCalledTimes(1);
    expect(mockRequireRecentSession).toHaveBeenCalledWith(expect.anything(), "test-user-id");
  });
});

describe("DELETE /api/teams/[teamId]/members/[memberId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTeamLockQuery.mockImplementation(teamLockQuery([{ id: TEAM_ID }]));
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireTeamPermission.mockResolvedValue(ownerMembership);
    mockIsRoleAbove.mockReturnValue(true);
    mockPrismaTeamMember.deleteMany.mockResolvedValue({ count: 1 });
    mockPrismaTeamMember.findFirst.mockResolvedValue({ role: TEAM_ROLE.OWNER });
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

  it("returns 403 when step-up reauth is required", async () => {
    mockRequireRecentSession.mockResolvedValueOnce(
      Response.json({ error: "SESSION_STEP_UP_REQUIRED" }, { status: 403 }),
    );
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(403);
    expect(json.error).toBe("SESSION_STEP_UP_REQUIRED");
    expect(mockTeamLockQuery).not.toHaveBeenCalled();
    // Pins that step-up fires BEFORE the existence lookup.
    expect(mockPrismaTeamMember.findUnique).not.toHaveBeenCalled();
  });

  it("binds the step-up gate to the actor, not the member being removed", async () => {
    // The gate binds freshness to the user whose session row it reads, so it
    // must get the actor `auth()` resolved — never the target id in scope.
    await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );
    expect(mockRequireRecentSession).toHaveBeenCalledTimes(1);
    expect(mockRequireRecentSession).toHaveBeenCalledWith(expect.anything(), "test-user-id");
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
      tenantId: "tenant-1",
      userId: "target-user",
      role: TEAM_ROLE.MEMBER,
      deactivatedAt: null,
    });

    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockPrismaTeamMemberKey.deleteMany).toHaveBeenCalledWith({
      where: { teamId: TEAM_ID, userId: "target-user" },
    });
    expect(mockPrismaTeamMember.deleteMany).toHaveBeenCalledWith({
      // Pinned to the role the authorisation judged, so a promotion in between does not slip through.
      where: { id: MEMBER_ID, teamId: TEAM_ID, role: TEAM_ROLE.MEMBER, OR: [{ deactivatedAt: null }, { deactivatedByTenant: true }] },
    });
  });

  it("removes a member whose membership ended with their departure from the tenant", async () => {
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: MEMBER_ID, teamId: TEAM_ID, tenantId: "tenant-1", userId: "left-user", role: TEAM_ROLE.MEMBER,
      deactivatedAt: new Date("2026-05-01"), deactivatedByTenant: true,
    });

    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );

    expect(res.status).toBe(200);
    expect(mockPrismaTeamMemberKey.deleteMany).toHaveBeenCalledWith({ where: { teamId: TEAM_ID, userId: "left-user" } });
  });

  it("does not remove a membership the IdP's group removal deactivated", async () => {
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: MEMBER_ID, teamId: TEAM_ID, tenantId: "tenant-1", userId: "u", role: TEAM_ROLE.MEMBER,
      deactivatedAt: new Date("2026-05-01"), deactivatedByTenant: false,
    });

    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );

    expect(res.status).toBe(404);
    expect(mockPrismaTeamMember.deleteMany).not.toHaveBeenCalled();
  });

  it("answers 403, removing nothing, when the acting member left since the permission check", async () => {
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: MEMBER_ID, teamId: TEAM_ID, tenantId: "tenant-1", userId: "u", role: TEAM_ROLE.MEMBER, deactivatedAt: null,
    });
    mockPrismaTeamMember.findFirst.mockResolvedValue(null);

    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );

    expect(res.status).toBe(403);
    expect(mockPrismaTeamMember.deleteMany).not.toHaveBeenCalled();
    expect(mockPrismaTeamMemberKey.deleteMany).not.toHaveBeenCalled();
  });

  it("re-reads the acting member's role after the team lock, scoped to the actor", async () => {
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: MEMBER_ID, teamId: TEAM_ID, tenantId: "tenant-1", userId: "target-user", role: TEAM_ROLE.MEMBER, deactivatedAt: null,
    });

    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );

    expect(res.status).toBe(200);
    expect(mockPrismaTeamMember.findFirst).toHaveBeenCalledWith({
      where: { teamId: TEAM_ID, userId: "test-user-id", deactivatedAt: null },
      select: { role: true },
    });
    const teamLock = lockQueryCalls(mockTeamLockQuery).find((c) => c.sql.includes("FROM teams"))!;
    expect(teamLock.order).toBeLessThan(mockPrismaTeamMember.findFirst.mock.invocationCallOrder[0]);
    expect(mockPrismaTeamMember.deleteMany).toHaveBeenCalled();
  });

  it("answers 403, removing nothing, when the acting member was demoted to the target's rank since the check", async () => {
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: MEMBER_ID, teamId: TEAM_ID, tenantId: "tenant-1", userId: "target-user", role: TEAM_ROLE.ADMIN, deactivatedAt: null,
    });
    mockPrismaTeamMember.findFirst.mockResolvedValue({ role: TEAM_ROLE.ADMIN });
    mockIsRoleAbove.mockImplementation((a: string, b: string) => a === "OWNER" && b !== "OWNER");

    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );

    expect(res.status).toBe(403);
    expect(mockPrismaTeamMember.deleteMany).not.toHaveBeenCalled();
  });

  it("answers 409 CONFLICT without Retry-After when the acting member's tenant row is held past the lock wait (DELETE)", async () => {
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: MEMBER_ID, teamId: TEAM_ID, tenantId: "tenant-1", userId: "u", role: TEAM_ROLE.MEMBER, deactivatedAt: null,
    });
    mockTeamLockQuery.mockImplementation(teamLockQuery((sql) => {
      if (sql.includes("FROM tenant_members")) throw Object.assign(new Error("lock timeout"), { code: "55P03" });
      return [{ id: TEAM_ID }];
    }));

    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("CONFLICT");
    expect(res.headers.get("Retry-After")).toBeNull();
    expect(mockPrismaTeamMember.deleteMany).not.toHaveBeenCalled();
  });

  it("answers 409 TEAM_BUSY with Retry-After when the team row lock wait times out (DELETE)", async () => {
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: MEMBER_ID, teamId: TEAM_ID, tenantId: "tenant-1", userId: "u", role: TEAM_ROLE.MEMBER, deactivatedAt: null,
    });
    mockTeamLockQuery.mockImplementation(teamLockQuery((sql) => {
      if (sql.includes("FROM teams")) throw Object.assign(new Error("lock timeout"), { code: "55P03" });
      return [{ id: TEAM_ID }];
    }));

    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("TEAM_BUSY");
    expect(res.headers.get("Retry-After")).toBe("3");
    expect(mockPrismaTeamMember.deleteMany).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("answers 404, removing nothing, when the row changed between the check and the team lock", async () => {
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: MEMBER_ID, teamId: TEAM_ID, tenantId: "tenant-1", userId: "u", role: TEAM_ROLE.MEMBER, deactivatedAt: null,
    });
    mockPrismaTeamMember.deleteMany.mockResolvedValue({ count: 0 });

    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );

    expect(res.status).toBe(404);
    expect(mockPrismaTeamMemberKey.deleteMany).not.toHaveBeenCalled();
    expect(mockInvalidateUserSessions).not.toHaveBeenCalled();
  });

  it("locks the team against key rotation before deleting the member's keys", async () => {
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      teamId: TEAM_ID,
      tenantId: "tenant-1",
      userId: "target-user",
      role: TEAM_ROLE.MEMBER,
      deactivatedAt: null,
    });

    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );

    expect(res.status).toBe(200);
    const calls = lockQueryCalls(mockTeamLockQuery);
    const actorRow = calls.find((c) => c.sql.includes("FROM tenant_members"))!;
    const lock = calls.find((c) => c.sql.includes("FROM teams"))!;
    // The acting member's tenant row first, then the team.
    expect(actorRow.sql).toMatch(/FOR SHARE/);
    expect(actorRow.values).toEqual(["tenant-1", ["test-user-id"]]);
    expect(actorRow.order).toBeLessThan(lock.order);
    expect(lock.sql).toMatch(/FROM teams WHERE id = ANY\(\?::uuid\[\]\) ORDER BY id FOR SHARE/);
    expect(lock.values).toEqual([[TEAM_ID]]);
    expect(lock.order).toBeLessThan(
      mockPrismaTeamMember.deleteMany.mock.invocationCallOrder[0],
    );
  });

  it("refuses the removal when the team row cannot be locked", async () => {
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      teamId: TEAM_ID,
      tenantId: "tenant-1",
      userId: "target-user",
      role: TEAM_ROLE.MEMBER,
      deactivatedAt: null,
    });
    mockTeamLockQuery.mockImplementation(teamLockQuery([]));

    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("CONFLICT");
    expect(mockPrismaTeamMemberKey.deleteMany).not.toHaveBeenCalled();
    expect(mockPrismaTeamMember.deleteMany).not.toHaveBeenCalled();
  });

  it("triggers invalidateUserSessions with tenantId on member removal", async () => {
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      teamId: TEAM_ID,
      tenantId: "tenant-1",
      userId: "target-user",
      role: TEAM_ROLE.MEMBER,
      deactivatedAt: null,
    });

    await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );

    expect(mockInvalidateUserSessions).toHaveBeenCalledWith("target-user", { tenantId: "tenant-1" });
  });

  it("returns 200 even if session invalidation fails", async () => {
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      teamId: TEAM_ID,
      tenantId: "tenant-1",
      userId: "target-user",
      role: TEAM_ROLE.MEMBER,
      deactivatedAt: null,
    });
    mockInvalidateUserSessions.mockRejectedValue(new Error("db error"));

    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );
    expect(res.status).toBe(200);
  });

  it("logs error when session invalidation fails", async () => {
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      teamId: TEAM_ID,
      tenantId: "tenant-1",
      userId: "target-user",
      role: TEAM_ROLE.MEMBER,
      deactivatedAt: null,
    });
    const dbError = new Error("db error");
    mockInvalidateUserSessions.mockRejectedValue(dbError);

    await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );

    expect(mockLogger.error).toHaveBeenCalledWith(
      { userId: "target-user", error: { name: "Error", code: "unknown" } },
      "session-invalidation-failed",
    );
  });

  it("includes sessionInvalidationFailed in audit metadata on failure", async () => {
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      teamId: TEAM_ID,
      tenantId: "tenant-1",
      userId: "target-user",
      role: TEAM_ROLE.MEMBER,
      deactivatedAt: null,
    });
    mockInvalidateUserSessions.mockRejectedValue(new Error("db error"));

    await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ sessionInvalidationFailed: true }),
      }),
    );
  });

  it("includes invalidation counts in audit metadata on success", async () => {
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: MEMBER_ID,
      teamId: TEAM_ID,
      tenantId: "tenant-1",
      userId: "target-user",
      role: TEAM_ROLE.MEMBER,
      deactivatedAt: null,
    });
    mockInvalidateUserSessions.mockResolvedValue({ sessions: 2, extensionTokens: 1, apiKeys: 0 });

    await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_ID}`),
      createParams({ teamId: TEAM_ID, memberId: MEMBER_ID }),
    );

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          sessions: 2,
          extensionTokens: 1,
          apiKeys: 0,
        }),
      }),
    );
  });
});
