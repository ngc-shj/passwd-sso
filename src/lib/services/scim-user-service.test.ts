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
} = vi.hoisted(() => ({
  mockTenantMemberFindUnique: vi.fn(),
  mockTenantMemberUpdate: vi.fn(),
  mockTenantMemberDelete: vi.fn(),
  mockTeamMemberDeleteMany: vi.fn(),
  mockTeamMemberKeyDeleteMany: vi.fn(),
  mockScimExternalMappingFindFirst: vi.fn(),
  mockScimExternalMappingDeleteMany: vi.fn(),
  mockTransaction: vi.fn(),
  // The team lock against key rotation: the membership read, then the FOR SHARE.
  mockQueryRaw: vi.fn(),
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
  });

  it("throws ScimUserNotFoundError when member does not exist", async () => {
    mockTenantMemberFindUnique.mockResolvedValueOnce(null);
    mockScimExternalMappingFindFirst.mockResolvedValue(null);

    await expect(
      patchScimUser(TENANT_ID, USER_ID, { active: false }),
    ).rejects.toThrow(ScimUserNotFoundError);
  });

  it("throws ScimOwnerProtectedError when deactivating the tenant OWNER", async () => {
    mockTenantMemberFindUnique.mockResolvedValueOnce({
      id: "tm1",
      role: "OWNER",
      deactivatedAt: null,
    });

    await expect(
      patchScimUser(TENANT_ID, USER_ID, { active: false }),
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

    const result = await patchScimUser(TENANT_ID, USER_ID, { active: false });

    expect(result.auditAction).toBe("SCIM_USER_DEACTIVATE");
    expect(result.needsSessionInvalidation).toBe(true);
  });

  it("sets auditAction to SCIM_USER_REACTIVATE when reactivating an inactive member", async () => {
    // First call: member lookup (select: id, role, deactivatedAt)
    mockTenantMemberFindUnique.mockResolvedValueOnce({
      id: "tm1",
      role: "MEMBER",
      deactivatedAt: new Date("2024-01-01T00:00:00.000Z"),
    });
    mockSnapshotRead();

    const result = await patchScimUser(TENANT_ID, USER_ID, { active: true });

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

    const result = await patchScimUser(TENANT_ID, USER_ID, { active: true });

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

    await patchScimUser(TENANT_ID, USER_ID, { active: false });

    expect(mockTenantMemberUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "tm1" },
        data: expect.objectContaining({ scimManaged: true, provisioningSource: "SCIM" }),
      }),
    );
  });

  it("returns the membership snapshot and reads no user relation", async () => {
    mockTenantMemberFindUnique.mockResolvedValueOnce({ id: "tm1", role: "MEMBER", deactivatedAt: null });
    mockSnapshotRead();

    const result = await patchScimUser(TENANT_ID, USER_ID, { active: true });

    expect(result.snapshot).toEqual({ userId: USER_ID, deactivatedAt: null, externalId: undefined });
    const snapshotRead = mockTenantMemberFindUnique.mock.calls[1][0];
    expect(snapshotRead).not.toHaveProperty("include");
    expect(snapshotRead.select).toEqual({ userId: true, deactivatedAt: true });
  });
});

describe("deactivateScimUser", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Membership read, the team lock, and the team_members delete's RETURNING.
    mockQueryRaw.mockImplementation(teamLockQuery((sql) =>
      sql.includes("FROM teams") ? [{ id: "team-1" }] : [{ team_id: "team-1" }],
    ));
    // Interactive transaction over the same model mocks.
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        $queryRaw: mockQueryRaw,
        $executeRaw: vi.fn(),
        teamMemberKey: { deleteMany: mockTeamMemberKeyDeleteMany },
        scimExternalMapping: { deleteMany: mockScimExternalMappingDeleteMany },
        teamMember: { deleteMany: mockTeamMemberDeleteMany },
        tenantMember: { delete: mockTenantMemberDelete },
      }),
    );
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

    const [membership, lock] = lockQueryCalls(mockQueryRaw);
    expect(membership.sql).toMatch(/FROM team_members\s+WHERE user_id = \?::uuid AND \(\?::uuid IS NULL OR tenant_id = \?::uuid\)/);
    expect(membership.values).toEqual([USER_ID, TENANT_ID, TENANT_ID]);
    expect(lock.sql).toMatch(/FROM teams WHERE id = ANY\(\?::uuid\[\]\) ORDER BY id FOR SHARE/);
    expect(lock.values).toEqual([["team-1"]]);
    expect(lock.order).toBeLessThan(
      mockTeamMemberKeyDeleteMany.mock.invocationCallOrder[0],
    );
  });

  it("refuses the deletion when a membership's team was not locked", async () => {
    // The lock covered team-1, but the delete removed a team-2 membership
    // too: one joined after the lock was taken (or one whose team RLS hid).
    mockTenantMemberFindUnique.mockResolvedValueOnce({ id: "tm1", role: "MEMBER" });
    mockQueryRaw.mockImplementation(teamLockQuery((sql) => {
      if (sql.includes("FROM teams")) return [{ id: "team-1" }];
      if (sql.includes("DELETE FROM team_members")) return [{ team_id: "team-1" }, { team_id: "team-2" }];
      return [{ team_id: "team-1" }];
    }));

    await expect(deactivateScimUser(TENANT_ID, USER_ID)).rejects.toThrow(
      "Could not lock 1 team row(s) against key rotation",
    );
    expect(mockTenantMemberDelete).not.toHaveBeenCalled();
  });

  it("completes when a team was deleted between the membership read and the lock", async () => {
    // The lock finds no row for team-2; its memberships went with it.
    mockTenantMemberFindUnique.mockResolvedValueOnce({ id: "tm1", role: "MEMBER" });
    mockQueryRaw.mockImplementation(teamLockQuery((sql) => {
      if (sql.includes("FROM teams")) return [{ id: "team-1" }];
      if (sql.includes("DELETE FROM team_members")) return [{ team_id: "team-1" }];
      return [{ team_id: "team-1" }, { team_id: "team-2" }];
    }));

    await expect(deactivateScimUser(TENANT_ID, USER_ID)).resolves.toMatchObject({ userId: USER_ID });
    expect(mockTenantMemberDelete).toHaveBeenCalledOnce();
  });
});
