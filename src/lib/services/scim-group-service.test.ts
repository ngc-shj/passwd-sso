import { describe, it, expect, vi } from "vitest";
import type { Prisma } from "@prisma/client";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

// The tenant-row lock has its own tests and real-DB cells; here it answers
// from the `tenantMember.findMany` fixture of the client it is handed — "active
// member of the tenant" when that fixture lists the userId, else not.
vi.mock("@/lib/team/tenant-row-lock", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  lockTenantRows: async (
    tx: { tenantMember: { findMany: (args: unknown) => Promise<{ userId: string }[] | undefined> } },
    tenantId: string,
    userIds: readonly string[],
  ) => {
    if (userIds.length === 0) return new Map();
    const active = new Set(
      ((await tx.tenantMember.findMany({ where: { tenantId, userId: { in: userIds }, deactivatedAt: null }, select: { userId: true } })) ?? [])
        .map((m) => m.userId),
    );
    return new Map(userIds.map((id) => [id, { hasRow: active.has(id), role: null, deactivatedAt: null, departedAt: null }]));
  },
}));

import { teamLockQuery } from "@/__tests__/helpers/team-rotation-lock-mock";
import {
  replaceScimGroup,
  patchScimGroup,
  ScimGroupNotFoundError,
  ScimOwnerProtectedError,
  ScimNoSuchMemberError,
  ScimDisplayNameMismatchError,
  ScimMembershipChangedError,
  SCIM_TRANSITION_KIND,
} from "./scim-group-service";

const BASE_URL = "http://localhost:3000/api/scim/v2";
const TENANT_ID = "tenant-1";
const SCIM_ID = "grp-ext-1";
const TEAM_ID = "team-1";

const DEFAULT_MAPPING = {
  externalGroupId: SCIM_ID,
  role: "ADMIN" as const,
  teamId: TEAM_ID,
  team: { slug: "core" },
};

/** A fresh transaction-client mock, every method a spy the test configures. */
function makeTx() {
  const teamMember = {
    findMany: vi.fn().mockResolvedValue([]),
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    updateManyAndReturn: vi.fn().mockResolvedValue([]),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  };
  const tenantMember = { findMany: vi.fn().mockResolvedValue([]) };
  const teamMemberKey = { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) };
  const scimGroupMapping = { findUnique: vi.fn().mockResolvedValue(DEFAULT_MAPPING) };
  const raw = {
    $queryRaw: vi.fn(teamLockQuery([{ id: TEAM_ID }])),
    $executeRaw: vi.fn(),
  };
  return {
    tx: { ...raw, teamMember, tenantMember, teamMemberKey, scimGroupMapping } as unknown as Prisma.TransactionClient,
    teamMember,
    tenantMember,
    teamMemberKey,
    scimGroupMapping,
  };
}

describe("patchScimGroup — add operations (C2)", () => {
  it("creates a pending row for a user not yet in the team, active in the tenant", async () => {
    const { tx, teamMember, tenantMember } = makeTx();
    teamMember.findMany
      .mockResolvedValueOnce([]) // memberships of add userIds (none yet)
      .mockResolvedValueOnce([]); // loadGroupMembers
    tenantMember.findMany.mockResolvedValue([{ userId: "user-a" }]);

    const result = await patchScimGroup(TENANT_ID, SCIM_ID, [{ op: "add", userId: "user-a" }], BASE_URL, tx);

    expect(teamMember.createMany).toHaveBeenCalledWith({
      data: [
        {
          teamId: TEAM_ID,
          userId: "user-a",
          tenantId: TENANT_ID,
          role: "ADMIN",
          scimManaged: true,
          scimApprovalPending: true,
          deactivatedAt: expect.any(Date),
          keyDistributed: false,
        },
      ],
    });
    expect(result.transitions).toEqual([
      { kind: SCIM_TRANSITION_KIND.BECAME_PENDING, userId: "user-a", role: "ADMIN" },
    ]);
  });

  it("moves a deactivated non-pending row to pending, clearing stale keys", async () => {
    const { tx, teamMember, tenantMember, teamMemberKey } = makeTx();
    teamMember.findMany
      .mockResolvedValueOnce([
        { id: "m-old", userId: "user-a", role: "ADMIN", deactivatedAt: new Date("2026-01-01"), deactivatedByTenant: false, scimApprovalPending: false },
      ])
      .mockResolvedValueOnce([]); // loadGroupMembers
    tenantMember.findMany.mockResolvedValue([{ userId: "user-a" }]);
    teamMember.updateManyAndReturn.mockResolvedValue([{ id: "m-old", userId: "user-a" }]);

    const result = await patchScimGroup(TENANT_ID, SCIM_ID, [{ op: "add", userId: "user-a" }], BASE_URL, tx);

    expect(teamMemberKey.deleteMany).toHaveBeenCalledWith({ where: { teamId: TEAM_ID, userId: { in: ["user-a"] } } });
    expect(teamMember.updateManyAndReturn).toHaveBeenCalledWith({
      where: { id: { in: ["m-old"] }, teamId: TEAM_ID, deactivatedAt: { not: null }, scimApprovalPending: false },
      data: { scimManaged: true, scimApprovalPending: true, deactivatedByTenant: false, keyDistributed: false, role: "ADMIN" },
      select: { id: true, userId: true },
    });
    expect(result.transitions).toEqual([
      { kind: SCIM_TRANSITION_KIND.BECAME_PENDING, userId: "user-a", role: "ADMIN", memberId: "m-old" },
    ]);
  });

  it("emits no transition for a row the becomes-pending CAS no longer matches", async () => {
    const { tx, teamMember, tenantMember } = makeTx();
    teamMember.findMany
      .mockResolvedValueOnce([
        { id: "m-old", userId: "user-a", role: "ADMIN", deactivatedAt: new Date("2026-01-01"), deactivatedByTenant: false, scimApprovalPending: false },
      ])
      .mockResolvedValueOnce([]); // loadGroupMembers
    tenantMember.findMany.mockResolvedValue([{ userId: "user-a" }]);
    teamMember.updateManyAndReturn.mockResolvedValue([]);

    const result = await patchScimGroup(TENANT_ID, SCIM_ID, [{ op: "add", userId: "user-a" }], BASE_URL, tx);

    expect(result.transitions).toEqual([]);
  });

  it("raises a pending row's role to the higher of its own and the mapping's role (CAS)", async () => {
    const { tx, teamMember, tenantMember } = makeTx();
    teamMember.findMany
      .mockResolvedValueOnce([
        { id: "m-1", userId: "user-a", role: "MEMBER", deactivatedAt: new Date(), deactivatedByTenant: false, scimApprovalPending: true },
      ])
      .mockResolvedValueOnce([]); // loadGroupMembers
    tenantMember.findMany.mockResolvedValue([{ userId: "user-a" }]);
    teamMember.updateManyAndReturn.mockResolvedValue([{ id: "m-1", userId: "user-a" }]);

    const result = await patchScimGroup(TENANT_ID, SCIM_ID, [{ op: "add", userId: "user-a" }], BASE_URL, tx);

    expect(teamMember.updateManyAndReturn).toHaveBeenCalledWith({
      where: { id: { in: ["m-1"] }, teamId: TEAM_ID, role: "MEMBER", scimApprovalPending: true },
      data: { role: "ADMIN" },
      select: { id: true, userId: true },
    });
    expect(result.transitions).toEqual([
      { kind: SCIM_TRANSITION_KIND.PENDING_ROLE_RAISED, userId: "user-a", role: "ADMIN", previousRole: "MEMBER", memberId: "m-1" },
    ]);
  });

  it("a pending row already at or above the mapping role is a no-op (repeated add / lower-role add)", async () => {
    const { tx, teamMember, tenantMember } = makeTx();
    teamMember.findMany
      .mockResolvedValueOnce([
        { id: "m-1", userId: "user-a", role: "ADMIN", deactivatedAt: new Date(), deactivatedByTenant: false, scimApprovalPending: true },
      ])
      .mockResolvedValueOnce([]); // loadGroupMembers
    tenantMember.findMany.mockResolvedValue([{ userId: "user-a" }]);

    // The mapping here is ADMIN too (DEFAULT_MAPPING); equal role → no raise.
    const result = await patchScimGroup(TENANT_ID, SCIM_ID, [{ op: "add", userId: "user-a" }], BASE_URL, tx);

    expect(teamMember.updateManyAndReturn).not.toHaveBeenCalled();
    expect(teamMember.updateMany).not.toHaveBeenCalled();
    expect(result.transitions).toEqual([]);
  });

  it("changes an active member's role in place via a CAS on the previous role", async () => {
    const { tx, teamMember, tenantMember } = makeTx();
    teamMember.findMany
      .mockResolvedValueOnce([
        { id: "m-1", userId: "user-a", role: "MEMBER", deactivatedAt: null, deactivatedByTenant: false, scimApprovalPending: false },
      ])
      .mockResolvedValueOnce([]); // loadGroupMembers
    tenantMember.findMany.mockResolvedValue([{ userId: "user-a" }]);
    teamMember.updateManyAndReturn.mockResolvedValue([{ id: "m-1", userId: "user-a" }]);

    const result = await patchScimGroup(TENANT_ID, SCIM_ID, [{ op: "add", userId: "user-a" }], BASE_URL, tx);

    expect(teamMember.updateManyAndReturn).toHaveBeenCalledWith({
      where: { id: { in: ["m-1"] }, teamId: TEAM_ID, role: "MEMBER", deactivatedAt: null },
      data: { role: "ADMIN" },
      select: { id: true, userId: true },
    });
    expect(result.transitions).toEqual([
      { kind: SCIM_TRANSITION_KIND.ACTIVE_ROLE_CHANGED, userId: "user-a", role: "ADMIN", previousRole: "MEMBER", memberId: "m-1" },
    ]);
  });

  it("throws ScimOwnerProtectedError when an existing active member has OWNER role", async () => {
    const { tx, teamMember } = makeTx();
    teamMember.findMany.mockResolvedValueOnce([
      { id: "m-owner", userId: "user-a", role: "OWNER", deactivatedAt: null, deactivatedByTenant: false, scimApprovalPending: false },
    ]);

    await expect(
      patchScimGroup(TENANT_ID, SCIM_ID, [{ op: "add", userId: "user-a" }], BASE_URL, tx),
    ).rejects.toThrow(ScimOwnerProtectedError);
  });

  it("skips a departure-marked row of a user inactive in the tenant, without throwing", async () => {
    const { tx, teamMember, tenantMember } = makeTx();
    teamMember.findMany
      .mockResolvedValueOnce([
        { id: "m-left", userId: "user-left", role: "ADMIN", deactivatedAt: new Date("2026-01-01"), deactivatedByTenant: true, scimApprovalPending: false },
      ])
      .mockResolvedValueOnce([]); // loadGroupMembers
    tenantMember.findMany.mockResolvedValue([]); // not active in the tenant

    const result = await patchScimGroup(TENANT_ID, SCIM_ID, [{ op: "add", userId: "user-left" }], BASE_URL, tx);

    expect(teamMember.updateMany).not.toHaveBeenCalled();
    expect(teamMember.createMany).not.toHaveBeenCalled();
    expect(result.transitions).toEqual([]);
  });

  it("skips a pending row of a user inactive in the tenant, without throwing", async () => {
    const { tx, teamMember, tenantMember } = makeTx();
    teamMember.findMany
      .mockResolvedValueOnce([
        { id: "m-pending", userId: "user-left", role: "VIEWER", deactivatedAt: new Date("2026-01-01"), deactivatedByTenant: false, scimApprovalPending: true },
      ])
      .mockResolvedValueOnce([]); // loadGroupMembers
    tenantMember.findMany.mockResolvedValue([]); // not active in the tenant

    const result = await patchScimGroup(TENANT_ID, SCIM_ID, [{ op: "add", userId: "user-left" }], BASE_URL, tx);

    expect(teamMember.updateManyAndReturn).not.toHaveBeenCalled();
    expect(result.transitions).toEqual([]);
  });

  it("throws ScimNoSuchMemberError for a user with no row who is not active in the tenant", async () => {
    const { tx, teamMember, tenantMember } = makeTx();
    teamMember.findMany.mockResolvedValueOnce([]); // no existing row
    tenantMember.findMany.mockResolvedValue([]); // not an active tenant member

    const err = await patchScimGroup(TENANT_ID, SCIM_ID, [{ op: "add", userId: "ghost-user" }], BASE_URL, tx).catch((e) => e);
    expect(err).toBeInstanceOf(ScimNoSuchMemberError);
    expect(err.userId).toBe("ghost-user");
  });
});

describe("patchScimGroup — remove operations (C2)", () => {
  it("withdraws a pending row (delete), transitioning pendingWithdrawn", async () => {
    const { tx, teamMember } = makeTx();
    teamMember.findMany
      .mockResolvedValueOnce([
        { id: "m-1", userId: "user-a", role: "ADMIN", deactivatedAt: new Date(), deactivatedByTenant: false, scimApprovalPending: true },
      ])
      .mockResolvedValueOnce([]); // loadGroupMembers
    teamMember.deleteMany.mockResolvedValue({ count: 1 });

    const result = await patchScimGroup(TENANT_ID, SCIM_ID, [{ op: "remove", userId: "user-a" }], BASE_URL, tx);

    expect(teamMember.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["m-1"] }, teamId: TEAM_ID, role: "ADMIN", scimApprovalPending: true },
    });
    expect(result.transitions).toEqual([
      { kind: SCIM_TRANSITION_KIND.PENDING_WITHDRAWN, userId: "user-a", role: "ADMIN", memberId: "m-1" },
    ]);
  });

  it("throws ScimMembershipChangedError when the withdraw's delete count falls short of the locked re-read", async () => {
    const { tx, teamMember } = makeTx();
    teamMember.findMany.mockResolvedValueOnce([
      { id: "m-1", userId: "user-a", role: "ADMIN", deactivatedAt: new Date(), deactivatedByTenant: false, scimApprovalPending: true },
    ]);
    teamMember.deleteMany.mockResolvedValue({ count: 0 }); // only an unlocked writer can cause this

    await expect(
      patchScimGroup(TENANT_ID, SCIM_ID, [{ op: "remove", userId: "user-a" }], BASE_URL, tx),
    ).rejects.toThrow(ScimMembershipChangedError);
  });

  it("deactivates an active member via CAS, transitioning activeRemoved", async () => {
    const { tx, teamMember } = makeTx();
    teamMember.findMany
      .mockResolvedValueOnce([
        { id: "m-1", userId: "user-a", role: "ADMIN", deactivatedAt: null, deactivatedByTenant: false, scimApprovalPending: false },
      ])
      .mockResolvedValueOnce([]); // loadGroupMembers
    teamMember.updateManyAndReturn.mockResolvedValue([{ id: "m-1", userId: "user-a" }]);

    const result = await patchScimGroup(TENANT_ID, SCIM_ID, [{ op: "remove", userId: "user-a" }], BASE_URL, tx);

    expect(teamMember.updateManyAndReturn).toHaveBeenCalledWith({
      where: { id: { in: ["m-1"] }, teamId: TEAM_ID, role: "ADMIN", deactivatedAt: null },
      data: { deactivatedAt: expect.any(Date) },
      select: { id: true, userId: true },
    });
    expect(result.transitions).toEqual([
      { kind: SCIM_TRANSITION_KIND.ACTIVE_REMOVED, userId: "user-a", role: "ADMIN", memberId: "m-1" },
    ]);
  });

  it("unmarks a departure-marked member via CAS, transitioning departedUnmarked", async () => {
    const { tx, teamMember } = makeTx();
    teamMember.findMany
      .mockResolvedValueOnce([
        { id: "m-1", userId: "user-left", role: "ADMIN", deactivatedAt: new Date("2026-01-01"), deactivatedByTenant: true, scimApprovalPending: false },
      ])
      .mockResolvedValueOnce([]); // loadGroupMembers
    teamMember.updateManyAndReturn.mockResolvedValue([{ id: "m-1", userId: "user-left" }]);

    const result = await patchScimGroup(TENANT_ID, SCIM_ID, [{ op: "remove", userId: "user-left" }], BASE_URL, tx);

    expect(teamMember.updateManyAndReturn).toHaveBeenCalledWith({
      where: { id: { in: ["m-1"] }, teamId: TEAM_ID, role: "ADMIN", deactivatedByTenant: true },
      data: { deactivatedByTenant: false },
      select: { id: true, userId: true },
    });
    expect(result.transitions).toEqual([
      { kind: SCIM_TRANSITION_KIND.DEPARTED_UNMARKED, userId: "user-left", role: "ADMIN", memberId: "m-1" },
    ]);
  });

  it("is a no-op when removing a userId with no row in the team at all", async () => {
    const { tx, teamMember } = makeTx();
    teamMember.findMany
      .mockResolvedValueOnce([]) // no row anywhere for this user
      .mockResolvedValueOnce([]); // loadGroupMembers

    const result = await patchScimGroup(TENANT_ID, SCIM_ID, [{ op: "remove", userId: "ghost-user" }], BASE_URL, tx);

    expect(teamMember.deleteMany).not.toHaveBeenCalled();
    expect(teamMember.updateManyAndReturn).not.toHaveBeenCalled();
    expect(result.transitions).toEqual([]);
  });

  it("throws ScimOwnerProtectedError when removing a user with OWNER role", async () => {
    const { tx, teamMember } = makeTx();
    teamMember.findMany.mockResolvedValueOnce([
      { id: "m-owner", userId: "user-a", role: "OWNER", deactivatedAt: null, deactivatedByTenant: false, scimApprovalPending: false },
    ]);

    await expect(
      patchScimGroup(TENANT_ID, SCIM_ID, [{ op: "remove", userId: "user-a" }], BASE_URL, tx),
    ).rejects.toThrow(ScimOwnerProtectedError);
  });

  // F3: SCIM_GROUP_UPDATE's added/removed are derived from the transitions a
  // write actually produced — one withdraw (delete) plus one active removal
  // (CAS) both count toward `removed`.
  it("counts a withdraw and an active removal together as removed=2, added=0", async () => {
    const { tx, teamMember } = makeTx();
    teamMember.findMany
      .mockResolvedValueOnce([
        { id: "m-1", userId: "user-a", role: "ADMIN", deactivatedAt: new Date(), deactivatedByTenant: false, scimApprovalPending: true },
        { id: "m-2", userId: "user-b", role: "ADMIN", deactivatedAt: null, deactivatedByTenant: false, scimApprovalPending: false },
      ])
      .mockResolvedValueOnce([]); // loadGroupMembers
    teamMember.deleteMany.mockResolvedValue({ count: 1 });
    teamMember.updateManyAndReturn.mockResolvedValue([{ id: "m-2", userId: "user-b" }]);

    const result = await patchScimGroup(
      TENANT_ID, SCIM_ID,
      [{ op: "remove", userId: "user-a" }, { op: "remove", userId: "user-b" }],
      BASE_URL, tx,
    );

    expect(result.added).toBe(0);
    expect(result.removed).toBe(2);
  });
});

// D (RFC 7644 §3.5.2, review round 2 F-N4/T-N7): operations for the same
// userId apply in request order, last op wins. Same starting membership
// (active, role already at the mapping's role) in both tests — only the
// order of the two ops differs — so a fold bug (always add-before-remove,
// independent of request order) is caught by the opposite-order case.
describe("patchScimGroup — operation order (D)", () => {
  type Row = { id: string; userId: string; role: string; deactivatedAt: Date | null; deactivatedByTenant: boolean; scimApprovalPending: boolean };
  const X = "user-a";
  const Y = "user-b";
  const ACTIVE_X: Row = { id: "m-1", userId: X, role: "ADMIN", deactivatedAt: null, deactivatedByTenant: false, scimApprovalPending: false };

  /**
   * Answers each teamMember.findMany by the rows it asks for, not by call
   * position, so the cells hold whichever order the service reads in: a
   * membership read (`where.userId.in`) gets the matching fixture rows, the
   * group-members read gets none.
   */
  function serveRows(teamMember: ReturnType<typeof makeTx>["teamMember"], rows: Row[]) {
    teamMember.findMany.mockImplementation(async (args: { where?: { userId?: { in?: string[] }; OR?: unknown[] } }) => {
      const ids = args.where?.userId?.in;
      if (!ids) return [];
      const matched = rows.filter((r) => ids.includes(r.userId));
      return args.where?.OR ? matched.filter((r) => r.deactivatedByTenant || r.scimApprovalPending) : matched;
    });
    teamMember.updateManyAndReturn.mockImplementation(async (args: { where: { id: { in: string[] } } }) =>
      rows.filter((r) => args.where.id.in.includes(r.id)).map((r) => ({ id: r.id, userId: r.userId })),
    );
  }

  function patch(tx: Prisma.TransactionClient, ops: { op: "add" | "remove"; userId: string }[]) {
    return patchScimGroup(TENANT_ID, SCIM_ID, ops, BASE_URL, tx);
  }

  it.each([
    { label: "[remove X, add X]", ops: ["remove", "add"] as const },
    { label: "[add X, remove X, add X]", ops: ["add", "remove", "add"] as const },
  ])("$label leaves an active X untouched (the last op is add)", async ({ ops }) => {
    const { tx, teamMember, tenantMember } = makeTx();
    serveRows(teamMember, [ACTIVE_X]);
    tenantMember.findMany.mockResolvedValue([{ userId: X }]);

    const result = await patch(tx, ops.map((op) => ({ op, userId: X })));

    expect(teamMember.updateManyAndReturn).not.toHaveBeenCalled();
    expect(teamMember.deleteMany).not.toHaveBeenCalled();
    expect(result.transitions).toEqual([]);
  });

  it.each([
    { label: "[add X, remove X]", ops: ["add", "remove"] as const },
    { label: "[remove X, add X, remove X]", ops: ["remove", "add", "remove"] as const },
  ])("$label deactivates an active X (the last op is remove)", async ({ ops }) => {
    const { tx, teamMember, tenantMember } = makeTx();
    serveRows(teamMember, [ACTIVE_X]);
    tenantMember.findMany.mockResolvedValue([{ userId: X }]);

    const result = await patch(tx, ops.map((op) => ({ op, userId: X })));

    expect(result.transitions).toEqual([
      { kind: SCIM_TRANSITION_KIND.ACTIVE_REMOVED, userId: X, role: "ADMIN", memberId: "m-1" },
    ]);
  });

  it("folds per user: [add X, add Y, remove X] adds Y and removes X", async () => {
    const { tx, teamMember, tenantMember } = makeTx();
    serveRows(teamMember, [ACTIVE_X]);
    tenantMember.findMany.mockResolvedValue([{ userId: X }, { userId: Y }]);

    const result = await patch(tx, [
      { op: "add", userId: X },
      { op: "add", userId: Y },
      { op: "remove", userId: X },
    ]);

    expect(teamMember.createMany).toHaveBeenCalledTimes(1);
    expect(teamMember.createMany.mock.calls[0][0].data.map((d: { userId: string }) => d.userId)).toEqual([Y]);
    expect(result.transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: SCIM_TRANSITION_KIND.BECAME_PENDING, userId: Y }),
        expect.objectContaining({ kind: SCIM_TRANSITION_KIND.ACTIVE_REMOVED, userId: X }),
      ]),
    );
  });

  it("writes a repeated add once", async () => {
    const { tx, teamMember, tenantMember } = makeTx();
    serveRows(teamMember, []);
    tenantMember.findMany.mockResolvedValue([{ userId: Y }]);

    await patch(tx, [{ op: "add", userId: Y }, { op: "add", userId: Y }]);

    expect(teamMember.createMany.mock.calls[0][0].data).toHaveLength(1);
  });

  it("refuses a cancelled add of a user who is neither active in the tenant nor holds a kept row", async () => {
    const { tx, teamMember, tenantMember } = makeTx();
    serveRows(teamMember, []);
    tenantMember.findMany.mockResolvedValue([]);

    await expect(patch(tx, [{ op: "add", userId: Y }, { op: "remove", userId: Y }])).rejects.toThrow(ScimNoSuchMemberError);
    expect(teamMember.deleteMany).not.toHaveBeenCalled();
    expect(teamMember.updateManyAndReturn).not.toHaveBeenCalled();
  });

  it("accepts a cancelled add of a departed user whose row is departure-marked", async () => {
    const { tx, teamMember, tenantMember } = makeTx();
    const departed: Row = { id: "m-2", userId: Y, role: "ADMIN", deactivatedAt: new Date(), deactivatedByTenant: true, scimApprovalPending: false };
    serveRows(teamMember, [departed]);
    tenantMember.findMany.mockResolvedValue([]);

    const result = await patch(tx, [{ op: "add", userId: Y }, { op: "remove", userId: Y }]);

    expect(result.transitions).toEqual([
      { kind: SCIM_TRANSITION_KIND.DEPARTED_UNMARKED, userId: Y, role: "ADMIN", memberId: "m-2" },
    ]);
  });
});

describe("patchScimGroup — group lookup and lock failures", () => {
  it("throws ScimGroupNotFoundError when mapping does not exist", async () => {
    const { tx, scimGroupMapping } = makeTx();
    scimGroupMapping.findUnique.mockResolvedValue(null);

    await expect(
      patchScimGroup(TENANT_ID, SCIM_ID, [{ op: "add", userId: "user-a" }], BASE_URL, tx),
    ).rejects.toThrow(ScimGroupNotFoundError);
  });

  it("refuses to write when the team row cannot be locked against rotation", async () => {
    const { tx } = makeTx();
    (tx as unknown as { $queryRaw: ReturnType<typeof vi.fn> }).$queryRaw.mockImplementation(teamLockQuery([]));

    await expect(
      patchScimGroup(TENANT_ID, SCIM_ID, [{ op: "add", userId: "user-a" }], BASE_URL, tx),
    ).rejects.toThrow("Could not lock 1 team row(s) against key rotation");
  });

  it("succeeds as a no-op when the operations list is empty", async () => {
    const { tx, teamMember } = makeTx();
    teamMember.findMany.mockResolvedValueOnce([]); // loadGroupMembers

    const result = await patchScimGroup(TENANT_ID, SCIM_ID, [], BASE_URL, tx);

    expect(teamMember.createMany).not.toHaveBeenCalled();
    expect(result.teamId).toBe(TEAM_ID);
  });
});

describe("replaceScimGroup — current-member set and deltas (C2)", () => {
  it("includes a pending row in the current-member set (SCIM_GROUP_ROW_STATE)", async () => {
    const { tx, teamMember } = makeTx();
    const pendingMember = { id: "m-1", userId: "user-a", role: "ADMIN" };
    teamMember.findMany
      .mockResolvedValueOnce([]) // unlocked pre-read
      .mockResolvedValueOnce([pendingMember]) // locked re-read (current members)
      .mockResolvedValueOnce([]); // loadGroupMembers

    await replaceScimGroup(TENANT_ID, SCIM_ID, { displayName: "core:ADMIN", memberUserIds: ["user-a"] }, BASE_URL, tx);

    const [, currentReadCall] = teamMember.findMany.mock.calls;
    expect(currentReadCall[0].where.OR).toEqual([
      { deactivatedAt: null },
      { deactivatedByTenant: true },
      { scimApprovalPending: true },
    ]);
  });

  it("is a no-op when the PUT repeats a listing of an already-pending member at the same role", async () => {
    const { tx, teamMember } = makeTx();
    const pendingMember = { id: "m-1", userId: "user-a", role: "ADMIN" };
    teamMember.findMany
      .mockResolvedValueOnce([{ userId: "user-a" }]) // unlocked pre-read
      .mockResolvedValueOnce([pendingMember]) // locked re-read
      .mockResolvedValueOnce([]); // loadGroupMembers

    const result = await replaceScimGroup(TENANT_ID, SCIM_ID, { displayName: "core:ADMIN", memberUserIds: ["user-a"] }, BASE_URL, tx);

    expect(teamMember.updateManyAndReturn).not.toHaveBeenCalled();
    expect(teamMember.createMany).not.toHaveBeenCalled();
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
  });

  it("does not remove a member the locked re-read found outside the locked set (joined after the unlocked pre-read)", async () => {
    const { tx, teamMember, tenantMember } = makeTx();
    // Pre-read sees only user-a; by the time the lock is held and the group
    // is re-read, user-b has also joined (a concurrent PATCH committed).
    teamMember.findMany
      .mockResolvedValueOnce([{ userId: "user-a" }]) // unlocked pre-read
      .mockResolvedValueOnce([
        { id: "m-a", userId: "user-a", role: "ADMIN" },
        { id: "m-b", userId: "user-b", role: "ADMIN" },
      ]) // locked re-read
      .mockResolvedValueOnce([]) // applyRemoveOperations' freshMembers read for user-a only
      .mockResolvedValueOnce([]); // loadGroupMembers
    tenantMember.findMany.mockResolvedValue([]);
    teamMember.updateManyAndReturn.mockResolvedValue([]);

    // PUT with an empty member list: user-a is locked (in the pre-read) and
    // removable; user-b is not locked and must be left for the next sync.
    await replaceScimGroup(TENANT_ID, SCIM_ID, { displayName: "core:ADMIN", memberUserIds: [] }, BASE_URL, tx);

    const freshMembersCall = teamMember.findMany.mock.calls[2][0];
    expect(freshMembersCall.where.userId.in).toEqual(["user-a"]);
  });

  it("counts added from activeRoleChanged + becamePending + pendingRoleRaised transitions, removed from the rest", async () => {
    const { tx, teamMember, tenantMember } = makeTx();
    // user-a: active member with the wrong role (MEMBER), requested role ADMIN.
    teamMember.findMany
      .mockResolvedValueOnce([]) // unlocked pre-read (none at ADMIN role yet)
      .mockResolvedValueOnce([]) // locked re-read (none at ADMIN role yet)
      .mockResolvedValueOnce([
        { id: "m-1", userId: "user-a", role: "MEMBER", deactivatedAt: null, deactivatedByTenant: false, scimApprovalPending: false },
      ]) // applyAddOperations' membership read
      .mockResolvedValueOnce([]); // loadGroupMembers
    tenantMember.findMany.mockResolvedValue([{ userId: "user-a" }]);
    teamMember.updateManyAndReturn.mockResolvedValue([{ id: "m-1", userId: "user-a" }]);

    const result = await replaceScimGroup(TENANT_ID, SCIM_ID, { displayName: "core:ADMIN", memberUserIds: ["user-a"] }, BASE_URL, tx);

    expect(result.added).toBe(1);
    expect(result.removed).toBe(0);
  });

  it("throws ScimOwnerProtectedError when the group's role is OWNER", async () => {
    const { tx, scimGroupMapping } = makeTx();
    scimGroupMapping.findUnique.mockResolvedValue({ ...DEFAULT_MAPPING, role: "OWNER" });

    await expect(
      replaceScimGroup(TENANT_ID, SCIM_ID, { displayName: "core:OWNER", memberUserIds: [] }, BASE_URL, tx),
    ).rejects.toThrow(ScimOwnerProtectedError);
  });

  it("throws ScimDisplayNameMismatchError when displayName does not match", async () => {
    const { tx } = makeTx();

    await expect(
      replaceScimGroup(TENANT_ID, SCIM_ID, { displayName: "wrong:ADMIN", memberUserIds: [] }, BASE_URL, tx),
    ).rejects.toThrow(ScimDisplayNameMismatchError);
  });

  it("throws ScimGroupNotFoundError when mapping does not exist", async () => {
    const { tx, scimGroupMapping } = makeTx();
    scimGroupMapping.findUnique.mockResolvedValue(null);

    await expect(
      replaceScimGroup(TENANT_ID, SCIM_ID, { displayName: "core:ADMIN", memberUserIds: [] }, BASE_URL, tx),
    ).rejects.toThrow(ScimGroupNotFoundError);
  });
});

describe("reader composition — loadGroupMembers (scim-group-members.ts)", () => {
  it("filters the final member list to the user's active tenant membership", async () => {
    const { tx, teamMember } = makeTx();
    teamMember.findMany
      .mockResolvedValueOnce([]) // unlocked pre-read
      .mockResolvedValueOnce([]) // locked re-read
      .mockResolvedValueOnce([]); // loadGroupMembers

    await replaceScimGroup(TENANT_ID, SCIM_ID, { displayName: "core:ADMIN", memberUserIds: [] }, BASE_URL, tx);

    const loadCall = teamMember.findMany.mock.calls.at(-1)?.[0];
    expect(loadCall.where.user).toEqual({
      tenantMemberships: { some: { tenantId: TENANT_ID, deactivatedAt: null } },
    });
    expect(loadCall.where.OR).toEqual([
      { deactivatedAt: null },
      { deactivatedByTenant: true },
      { scimApprovalPending: true },
    ]);
  });
});
