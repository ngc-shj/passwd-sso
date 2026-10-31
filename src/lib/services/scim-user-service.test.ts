import { describe, it, expect, vi, beforeEach } from "vitest";
import { teamLockQuery, lockQueryCalls } from "@/__tests__/helpers/team-rotation-lock-mock";

const {
  mockTenantMemberFindUnique,
  mockTenantMemberUpdate,
  mockTenantMemberDelete,
  mockTeamMemberDeleteMany,
  mockTeamMemberKeyDeleteMany,
  mockScimExternalMappingFindFirst,
  mockScimExternalMappingDeleteMany,
  mockTransaction,
  mockQueryRaw,
  mockExecuteRaw,
  mockDepartFromTenant,
  mockReturnToTenant,
} = vi.hoisted(() => ({
  mockTenantMemberFindUnique: vi.fn(),
  mockTenantMemberUpdate: vi.fn(),
  mockTenantMemberDelete: vi.fn(),
  mockTeamMemberDeleteMany: vi.fn(),
  mockTeamMemberKeyDeleteMany: vi.fn(),
  mockScimExternalMappingFindFirst: vi.fn(),
  mockScimExternalMappingDeleteMany: vi.fn(),
  mockTransaction: vi.fn(),
  // The tenant-row lock, the team lock against key rotation (membership
  // read, then FOR SHARE) and the team_members delete's RETURNING.
  mockQueryRaw: vi.fn(),
  mockExecuteRaw: vi.fn(),
  mockDepartFromTenant: vi.fn(),
  mockReturnToTenant: vi.fn(),
}));

vi.mock("@/lib/team/team-departure", () => ({
  departFromTenant: mockDepartFromTenant,
  returnToTenant: mockReturnToTenant,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantMember: {
      findUnique: mockTenantMemberFindUnique,
      update: mockTenantMemberUpdate,
      delete: mockTenantMemberDelete,
    },
    teamMember: {
      deleteMany: mockTeamMemberDeleteMany,
    },
    teamMemberKey: {
      deleteMany: mockTeamMemberKeyDeleteMany,
    },
    scimExternalMapping: {
      findFirst: mockScimExternalMappingFindFirst,
      deleteMany: mockScimExternalMappingDeleteMany,
    },
    $transaction: mockTransaction,
  },
}));

import {
  patchScimUser,
  deactivateScimUser,
  ScimUserNotFoundError,
  ScimOwnerProtectedError,
} from "./scim-user-service";

const TENANT_ID = "tenant-1";
const USER_ID = "user-1";
const ACTOR = { userId: "scim-actor", actorType: "SERVICE_ACCOUNT" as const, ip: null, userAgent: null };

/** `$queryRaw` answers for the tenant-row lock, the team lock and the membership delete. */
function lockAnswers(overrides: { teams?: string[]; deleted?: string[]; memberships?: string[] } = {}) {
  return teamLockQuery((sql) => {
    if (sql.includes("FROM teams")) return (overrides.teams ?? ["team-1"]).map((id) => ({ id }));
    if (sql.includes("DELETE FROM team_members")) {
      return (overrides.deleted ?? ["team-1"]).map((team_id) => ({ team_id }));
    }
    if (sql.includes("FROM tenant_member_departures")) return [];
    if (sql.includes("FROM tenant_members")) return [{ user_id: USER_ID, deactivated_at: null }];
    return (overrides.memberships ?? ["team-1"]).map((team_id) => ({ team_id }));
  });
}

/** An interactive transaction over the shared model mocks. */
function runTransactionOverMocks() {
  mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({
      $queryRaw: mockQueryRaw,
      $executeRaw: mockExecuteRaw,
      teamMemberKey: { deleteMany: mockTeamMemberKeyDeleteMany },
      scimExternalMapping: { deleteMany: mockScimExternalMappingDeleteMany },
      teamMember: { deleteMany: mockTeamMemberDeleteMany },
      tenantMember: { update: mockTenantMemberUpdate, delete: mockTenantMemberDelete },
    }),
  );
}

/** Raw SQL statements sent through `$executeRaw`, in order. */
function executedSql(): { sql: string; order: number }[] {
  return mockExecuteRaw.mock.calls.map((call, i) => ({
    sql: (call[0] as TemplateStringsArray).join("?"),
    order: mockExecuteRaw.mock.invocationCallOrder[i],
  }));
}

// loadScimUserSnapshot makes a second tenantMember.findUnique call and a
// scimExternalMapping.findFirst call — we provide a valid shape for both.
function mockSnapshotRead() {
  mockTenantMemberFindUnique.mockResolvedValueOnce({ userId: USER_ID, deactivatedAt: null });
  mockScimExternalMappingFindFirst.mockResolvedValueOnce(null);
}

describe("patchScimUser", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockTenantMemberUpdate.mockResolvedValue({});
    mockQueryRaw.mockImplementation(lockAnswers());
    mockDepartFromTenant.mockResolvedValue([]);
    mockReturnToTenant.mockResolvedValue([]);
    runTransactionOverMocks();
  });

  it("throws ScimUserNotFoundError when member does not exist", async () => {
    mockTenantMemberFindUnique.mockResolvedValueOnce(null);
    mockScimExternalMappingFindFirst.mockResolvedValue(null);

    await expect(
      patchScimUser(TENANT_ID, USER_ID, { active: false }, ACTOR),
    ).rejects.toThrow(ScimUserNotFoundError);
  });

  it("throws ScimOwnerProtectedError when deactivating the tenant OWNER", async () => {
    mockTenantMemberFindUnique.mockResolvedValueOnce({
      id: "tm1",
      role: "OWNER",
      deactivatedAt: null,
    });

    await expect(
      patchScimUser(TENANT_ID, USER_ID, { active: false }, ACTOR),
    ).rejects.toThrow(ScimOwnerProtectedError);
    expect(mockTenantMemberUpdate).not.toHaveBeenCalled();
  });

  it("sets auditAction to SCIM_USER_DEACTIVATE when deactivating an active member", async () => {
    // First call: member lookup (select: id, role, deactivatedAt)
    mockTenantMemberFindUnique.mockResolvedValueOnce({
      id: "tm1",
      role: "MEMBER",
      deactivatedAt: null,
    });
    mockSnapshotRead();
    mockDepartFromTenant.mockResolvedValueOnce([USER_ID]);

    const result = await patchScimUser(TENANT_ID, USER_ID, { active: false }, ACTOR);

    expect(result.auditAction).toBe("SCIM_USER_DEACTIVATE");
    expect(result.needsSessionInvalidation).toBe(true);
  });

  it("reports SCIM_USER_UPDATE when the departure transitioned nobody", async () => {
    // The pre-read says active, but a concurrent request deactivated the
    // member first: the returned ids decide, not the pre-read.
    mockTenantMemberFindUnique.mockResolvedValueOnce({ id: "tm1", role: "MEMBER", deactivatedAt: null });
    mockSnapshotRead();

    const result = await patchScimUser(TENANT_ID, USER_ID, { active: false }, ACTOR);

    expect(result.auditAction).toBe("SCIM_USER_UPDATE");
    expect(result.needsSessionInvalidation).toBe(false);
  });

  it("departs through team-departure under the tenant row it locked first", async () => {
    mockTenantMemberFindUnique.mockResolvedValueOnce({ id: "tm1", role: "MEMBER", deactivatedAt: null });
    mockSnapshotRead();

    await patchScimUser(TENANT_ID, USER_ID, { active: false }, ACTOR);

    const rowLock = lockQueryCalls(mockQueryRaw).find((c) => c.sql.includes("FROM tenant_members"));
    expect(rowLock?.sql).toMatch(/FOR UPDATE/);
    expect(mockDepartFromTenant).toHaveBeenCalledWith(
      expect.anything(),
      TENANT_ID,
      [USER_ID],
      expect.objectContaining({ actor: ACTOR, alreadyLocked: true }),
    );
    expect(rowLock?.order).toBeLessThan(mockDepartFromTenant.mock.invocationCallOrder[0]);
    expect(mockReturnToTenant).not.toHaveBeenCalled();
  });

  it("does not move the active state for a PATCH without `active`", async () => {
    mockTenantMemberFindUnique.mockResolvedValueOnce({ id: "tm1", role: "MEMBER", deactivatedAt: null });
    mockSnapshotRead();

    const result = await patchScimUser(TENANT_ID, USER_ID, {}, ACTOR);

    expect(result.auditAction).toBe("SCIM_USER_UPDATE");
    expect(mockDepartFromTenant).not.toHaveBeenCalled();
    expect(mockReturnToTenant).not.toHaveBeenCalled();
  });

  it("sets auditAction to SCIM_USER_REACTIVATE when reactivating an inactive member", async () => {
    // First call: member lookup (select: id, role, deactivatedAt)
    mockTenantMemberFindUnique.mockResolvedValueOnce({
      id: "tm1",
      role: "MEMBER",
      deactivatedAt: new Date("2024-01-01T00:00:00.000Z"),
    });
    mockSnapshotRead();
    mockReturnToTenant.mockResolvedValueOnce([USER_ID]);

    const result = await patchScimUser(TENANT_ID, USER_ID, { active: true }, ACTOR);

    expect(result.auditAction).toBe("SCIM_USER_REACTIVATE");
    expect(result.needsSessionInvalidation).toBe(false);
  });

  it("does not set needsSessionInvalidation when updating an already-active member", async () => {
    // First call: member lookup — already active, active stays true → SCIM_USER_UPDATE
    mockTenantMemberFindUnique.mockResolvedValueOnce({
      id: "tm1",
      role: "MEMBER",
      deactivatedAt: null,
    });
    mockSnapshotRead();

    const result = await patchScimUser(TENANT_ID, USER_ID, { active: true }, ACTOR);

    expect(result.auditAction).toBe("SCIM_USER_UPDATE");
    expect(result.needsSessionInvalidation).toBe(false);
  });

  it("calls tenantMember.update with select fields matching the PR change", async () => {
    mockTenantMemberFindUnique.mockResolvedValueOnce({
      id: "tm1",
      role: "MEMBER",
      deactivatedAt: null,
    });
    mockSnapshotRead();

    await patchScimUser(TENANT_ID, USER_ID, { active: false }, ACTOR);

    expect(mockTenantMemberUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "tm1" },
        data: expect.objectContaining({ scimManaged: true, provisioningSource: "SCIM" }),
      }),
    );
    // The active state is team-departure.ts's to write.
    expect(mockTenantMemberUpdate.mock.calls[0][0].data).not.toHaveProperty("deactivatedAt");
  });

  it("returns the membership snapshot and reads no user relation", async () => {
    mockTenantMemberFindUnique.mockResolvedValueOnce({ id: "tm1", role: "MEMBER", deactivatedAt: null });
    mockSnapshotRead();

    const result = await patchScimUser(TENANT_ID, USER_ID, { active: true }, ACTOR);

    expect(result.snapshot).toEqual({ userId: USER_ID, deactivatedAt: null, externalId: undefined });
    const snapshotRead = mockTenantMemberFindUnique.mock.calls[1][0];
    expect(snapshotRead).not.toHaveProperty("include");
    expect(snapshotRead.select).toEqual({ userId: true, deactivatedAt: true });
  });
});

describe("deactivateScimUser", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockQueryRaw.mockImplementation(lockAnswers());
    runTransactionOverMocks();
  });

  it("throws ScimUserNotFoundError when member does not exist", async () => {
    mockTenantMemberFindUnique.mockResolvedValueOnce(null);
    mockScimExternalMappingFindFirst.mockResolvedValue(null);

    await expect(deactivateScimUser(TENANT_ID, USER_ID)).rejects.toThrow(ScimUserNotFoundError);
  });

  it("throws ScimOwnerProtectedError when deleting the tenant OWNER", async () => {
    mockTenantMemberFindUnique.mockResolvedValueOnce({
      id: "tm1",
      role: "OWNER",
    });

    await expect(deactivateScimUser(TENANT_ID, USER_ID)).rejects.toThrow(ScimOwnerProtectedError);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("returns userId and reads no user relation", async () => {
    mockTenantMemberFindUnique.mockResolvedValueOnce({ id: "tm1", role: "MEMBER" });

    const result = await deactivateScimUser(TENANT_ID, USER_ID);

    expect(result).toEqual({ userId: USER_ID, needsSessionInvalidation: true });
    expect(mockTenantMemberFindUnique.mock.calls[0][0].select).toEqual({ id: true, role: true });
  });

  it("runs deletion in a transaction", async () => {
    mockTenantMemberFindUnique.mockResolvedValueOnce({
      id: "tm1",
      role: "MEMBER",
    });

    await deactivateScimUser(TENANT_ID, USER_ID);

    expect(mockTransaction).toHaveBeenCalledWith(expect.any(Function));
    expect(mockTeamMemberKeyDeleteMany).toHaveBeenCalledWith({ where: { tenantId: TENANT_ID, userId: USER_ID } });
    const removal = lockQueryCalls(mockQueryRaw).find((call) => call.sql.includes("DELETE FROM team_members"));
    expect(removal?.values).toEqual([TENANT_ID, USER_ID]);
    expect(mockTenantMemberDelete).toHaveBeenCalledOnce();
  });

  it("locks the user's teams in this tenant against key rotation before deleting member keys", async () => {
    mockTenantMemberFindUnique.mockResolvedValueOnce({ id: "tm1", role: "MEMBER" });

    await deactivateScimUser(TENANT_ID, USER_ID);

    const calls = lockQueryCalls(mockQueryRaw);
    const membership = calls.find((c) => c.sql.includes("SELECT DISTINCT team_id FROM team_members"))!;
    const lock = calls.find((c) => c.sql.includes("FROM teams"))!;
    expect(membership.sql).toMatch(/FROM team_members\s+WHERE user_id = \?::uuid AND \(\?::uuid IS NULL OR tenant_id = \?::uuid\)/);
    expect(membership.values).toEqual([USER_ID, TENANT_ID, TENANT_ID]);
    expect(lock.sql).toMatch(/FROM teams WHERE id = ANY\(\?::uuid\[\]\) ORDER BY id FOR SHARE/);
    expect(lock.values).toEqual([["team-1"]]);
    expect(lock.order).toBeLessThan(
      mockTeamMemberKeyDeleteMany.mock.invocationCallOrder[0],
    );
  });

  it("locks the tenant row, then records the departure, before locking teams", async () => {
    mockTenantMemberFindUnique.mockResolvedValueOnce({ id: "tm1", role: "MEMBER" });

    await deactivateScimUser(TENANT_ID, USER_ID);

    const calls = lockQueryCalls(mockQueryRaw);
    const rowLock = calls.find((c) => c.sql.includes("FROM tenant_members"))!;
    const teamLock = calls.find((c) => c.sql.includes("FROM teams"))!;
    const record = executedSql().find((c) => c.sql.includes("INSERT INTO tenant_member_departures"))!;
    expect(rowLock.sql).toMatch(/FOR UPDATE/);
    expect(record.sql).toMatch(/clock_timestamp\(\)/);
    expect(rowLock.order).toBeLessThan(record.order);
    expect(record.order).toBeLessThan(teamLock.order);
  });

  it("expires the pending invitations the user issued, after the team lock", async () => {
    mockTenantMemberFindUnique.mockResolvedValueOnce({ id: "tm1", role: "MEMBER" });

    await deactivateScimUser(TENANT_ID, USER_ID);

    const teamLock = lockQueryCalls(mockQueryRaw).find((c) => c.sql.includes("FROM teams"))!;
    const expiry = executedSql().find((c) => c.sql.includes("UPDATE team_invitations"))!;
    expect(expiry.sql).toMatch(/invited_by_id = \?::uuid AND status = 'PENDING'/);
    expect(teamLock.order).toBeLessThan(expiry.order);
  });

  it("refuses the deletion when a membership's team was not locked", async () => {
    // The lock covered team-1, but the delete removed a team-2 membership
    // too: one joined after the lock was taken (or one whose team RLS hid).
    mockTenantMemberFindUnique.mockResolvedValueOnce({ id: "tm1", role: "MEMBER" });
    mockQueryRaw.mockImplementation(lockAnswers({ deleted: ["team-1", "team-2"] }));

    await expect(deactivateScimUser(TENANT_ID, USER_ID)).rejects.toThrow(
      "Could not lock 1 team row(s) against key rotation",
    );
    expect(mockTenantMemberDelete).not.toHaveBeenCalled();
  });

  it("completes when a team was deleted between the membership read and the lock", async () => {
    // The lock finds no row for team-2; its memberships went with it.
    mockTenantMemberFindUnique.mockResolvedValueOnce({ id: "tm1", role: "MEMBER" });
    mockQueryRaw.mockImplementation(lockAnswers({ memberships: ["team-1", "team-2"] }));

    await expect(deactivateScimUser(TENANT_ID, USER_ID)).resolves.toMatchObject({ userId: USER_ID });
    expect(mockTenantMemberDelete).toHaveBeenCalledOnce();
  });
});
