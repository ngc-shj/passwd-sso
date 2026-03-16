import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockTeamMemberFindMany,
  mockTeamMemberCreateMany,
  mockTeamMemberUpdateMany,
  mockTenantMemberFindMany,
  mockScimGroupMappingFindUnique,
  mockTransaction,
} = vi.hoisted(() => {
  const mockTeamMemberFindMany = vi.fn();
  const mockTeamMemberCreateMany = vi.fn();
  const mockTeamMemberUpdateMany = vi.fn();
  const mockTenantMemberFindMany = vi.fn();
  const mockScimGroupMappingFindUnique = vi.fn();

  const txClient = {
    teamMember: {
      findMany: mockTeamMemberFindMany,
      createMany: mockTeamMemberCreateMany,
      updateMany: mockTeamMemberUpdateMany,
    },
    tenantMember: {
      findMany: mockTenantMemberFindMany,
    },
  };

  const mockTransaction = vi.fn(async (fn: (tx: typeof txClient) => Promise<unknown>) =>
    fn(txClient),
  );

  return {
    mockTeamMemberFindMany,
    mockTeamMemberCreateMany,
    mockTeamMemberUpdateMany,
    mockTenantMemberFindMany,
    mockScimGroupMappingFindUnique,
    mockTransaction,
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    scimGroupMapping: {
      findUnique: mockScimGroupMappingFindUnique,
    },
    teamMember: {
      findMany: mockTeamMemberFindMany,
      createMany: mockTeamMemberCreateMany,
      updateMany: mockTeamMemberUpdateMany,
    },
    tenantMember: {
      findMany: mockTenantMemberFindMany,
    },
    $transaction: mockTransaction,
  },
}));

import {
  replaceScimGroup,
  patchScimGroup,
  ScimGroupNotFoundError,
  ScimOwnerProtectedError,
  ScimNoSuchMemberError,
  ScimDisplayNameMismatchError,
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

describe("replaceScimGroup", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Re-apply the transaction implementation after reset
    mockTransaction.mockImplementation(async (fn) => fn({
      teamMember: {
        findMany: mockTeamMemberFindMany,
        createMany: mockTeamMemberCreateMany,
        updateMany: mockTeamMemberUpdateMany,
      },
      tenantMember: { findMany: mockTenantMemberFindMany },
    }));
  });

  it("adds multiple users in a single batch", async () => {
    mockScimGroupMappingFindUnique.mockResolvedValue(DEFAULT_MAPPING);
    // No current members in the role
    mockTeamMemberFindMany
      .mockResolvedValueOnce([]) // currentMembers (outer)
      .mockResolvedValueOnce([]) // existingMembers in tx (toAdd batch pre-fetch)
      .mockResolvedValueOnce([]); // loadGroupMembers (after tx)
    mockTenantMemberFindMany.mockResolvedValue([
      { userId: "user-a" },
      { userId: "user-b" },
      { userId: "user-c" },
    ]);
    mockTeamMemberCreateMany.mockResolvedValue({ count: 3 });

    const result = await replaceScimGroup(
      TENANT_ID,
      SCIM_ID,
      { displayName: "core:ADMIN", memberUserIds: ["user-a", "user-b", "user-c"] },
      BASE_URL,
    );

    expect(mockTeamMemberCreateMany).toHaveBeenCalledOnce();
    const createCall = mockTeamMemberCreateMany.mock.calls[0][0];
    expect(createCall.data).toHaveLength(3);
    expect(createCall.data.map((d: { userId: string }) => d.userId)).toEqual(
      expect.arrayContaining(["user-a", "user-b", "user-c"]),
    );
    expect(result.added).toBe(3);
    expect(result.removed).toBe(0);
  });

  it("removes multiple users in a single batch", async () => {
    mockScimGroupMappingFindUnique.mockResolvedValue(DEFAULT_MAPPING);
    const currentMembers = [
      { id: "m-1", userId: "user-a", role: "ADMIN" },
      { id: "m-2", userId: "user-b", role: "ADMIN" },
    ];
    // Call sequence inside tx: (1) currentMembers, (2) freshMembers in applyRemoveOperations
    // applyAddOperations is called with toAdd=[] and returns early (no findMany)
    // After tx: (3) loadGroupMembers uses prisma.teamMember.findMany (same mock)
    mockTeamMemberFindMany
      .mockResolvedValueOnce(currentMembers) // currentMembers (outer, inside tx)
      .mockResolvedValueOnce(currentMembers) // freshMembers in applyRemoveOperations
      .mockResolvedValueOnce([]); // loadGroupMembers (after tx)
    mockTeamMemberUpdateMany.mockResolvedValue({ count: 2 });

    const result = await replaceScimGroup(
      TENANT_ID,
      SCIM_ID,
      { displayName: "core:ADMIN", memberUserIds: [] },
      BASE_URL,
    );

    expect(mockTeamMemberUpdateMany).toHaveBeenCalledOnce();
    const updateCall = mockTeamMemberUpdateMany.mock.calls[0][0];
    expect(updateCall.where.id.in).toEqual(expect.arrayContaining(["m-1", "m-2"]));
    expect(updateCall.data.role).toBe("MEMBER");
    expect(result.removed).toBe(2);
    expect(result.added).toBe(0);
  });

  it("applies mixed add and remove in a replace operation", async () => {
    mockScimGroupMappingFindUnique.mockResolvedValue(DEFAULT_MAPPING);
    // user-a is currently in the group; user-b will be added
    const currentMembers = [{ id: "m-1", userId: "user-a", role: "ADMIN" }];
    const freshMembersForRemove = [{ id: "m-1", role: "ADMIN" }];
    mockTeamMemberFindMany
      .mockResolvedValueOnce(currentMembers) // currentMembers (outer)
      .mockResolvedValueOnce([]) // existingMembers in tx for toAdd (user-b not yet in team)
      .mockResolvedValueOnce(freshMembersForRemove) // freshMembers for toRemove
      .mockResolvedValueOnce([]); // loadGroupMembers
    mockTenantMemberFindMany.mockResolvedValue([{ userId: "user-b" }]);
    mockTeamMemberCreateMany.mockResolvedValue({ count: 1 });
    mockTeamMemberUpdateMany.mockResolvedValue({ count: 1 });

    const result = await replaceScimGroup(
      TENANT_ID,
      SCIM_ID,
      { displayName: "core:ADMIN", memberUserIds: ["user-b"] },
      BASE_URL,
    );

    expect(mockTeamMemberCreateMany).toHaveBeenCalledOnce();
    expect(mockTeamMemberUpdateMany).toHaveBeenCalledOnce();
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
  });

  it("throws ScimOwnerProtectedError when group role is OWNER", async () => {
    mockScimGroupMappingFindUnique.mockResolvedValue({
      ...DEFAULT_MAPPING,
      role: "OWNER",
    });
    // currentMembers outer query still runs before the OWNER check
    mockTeamMemberFindMany.mockResolvedValueOnce([]);

    await expect(
      replaceScimGroup(
        TENANT_ID,
        SCIM_ID,
        { displayName: "core:OWNER", memberUserIds: ["user-a"] },
        BASE_URL,
      ),
    ).rejects.toThrow(ScimOwnerProtectedError);
  });

  it("throws ScimOwnerProtectedError when a member to add has OWNER role", async () => {
    mockScimGroupMappingFindUnique.mockResolvedValue(DEFAULT_MAPPING);
    // Call sequence: (1) currentMembers outer, (2) existingMembers in tx for toAdd
    // user-a is not in currentMembers so it goes into toAdd; tx finds it with OWNER role
    mockTeamMemberFindMany
      .mockResolvedValueOnce([]) // currentMembers (outer)
      .mockResolvedValueOnce([{ id: "m-owner", userId: "user-a", role: "OWNER" }]); // existingMembers in tx

    await expect(
      replaceScimGroup(
        TENANT_ID,
        SCIM_ID,
        { displayName: "core:ADMIN", memberUserIds: ["user-a"] },
        BASE_URL,
      ),
    ).rejects.toThrow(ScimOwnerProtectedError);
  });

  it("throws ScimOwnerProtectedError when a member to remove has OWNER role", async () => {
    mockScimGroupMappingFindUnique.mockResolvedValue(DEFAULT_MAPPING);
    // user-a is currently in the group (ADMIN role); requested list is empty so it goes to toRemove
    // freshMembers fetch reveals it was promoted to OWNER before the transaction
    // applyAddOperations is called with toAdd=[] and returns early (no findMany)
    const currentMembers = [{ id: "m-1", userId: "user-a", role: "ADMIN" }];
    mockTeamMemberFindMany
      .mockResolvedValueOnce(currentMembers) // currentMembers (outer, inside tx)
      .mockResolvedValueOnce([{ id: "m-1", role: "OWNER" }]); // freshMembers in applyRemoveOperations

    await expect(
      replaceScimGroup(
        TENANT_ID,
        SCIM_ID,
        { displayName: "core:ADMIN", memberUserIds: [] },
        BASE_URL,
      ),
    ).rejects.toThrow(ScimOwnerProtectedError);
  });

  it("throws ScimNoSuchMemberError when a userId is not an active tenant member", async () => {
    mockScimGroupMappingFindUnique.mockResolvedValue(DEFAULT_MAPPING);
    // Call sequence: (1) currentMembers outer, (2) existingMembers in tx, (3) tenantMember check fails
    mockTeamMemberFindMany
      .mockResolvedValueOnce([]) // currentMembers (outer)
      .mockResolvedValueOnce([]); // existingMembers in tx (user not yet a team member)
    mockTenantMemberFindMany.mockResolvedValue([]); // user is not an active tenant member

    const err = await replaceScimGroup(
      TENANT_ID,
      SCIM_ID,
      { displayName: "core:ADMIN", memberUserIds: ["nonexistent-user"] },
      BASE_URL,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ScimNoSuchMemberError);
    expect(err.userId).toBe("nonexistent-user");
  });

  it("deduplicates userId in add operations", async () => {
    mockScimGroupMappingFindUnique.mockResolvedValue(DEFAULT_MAPPING);
    mockTeamMemberFindMany
      .mockResolvedValueOnce([]) // currentMembers (outer)
      .mockResolvedValueOnce([]) // existingMembers in tx
      .mockResolvedValueOnce([]); // loadGroupMembers
    mockTenantMemberFindMany.mockResolvedValue([{ userId: "user-a" }]);
    mockTeamMemberCreateMany.mockResolvedValue({ count: 1 });

    // user-a appears twice in the input; Set deduplication means only one createMany row
    await replaceScimGroup(
      TENANT_ID,
      SCIM_ID,
      { displayName: "core:ADMIN", memberUserIds: ["user-a", "user-a"] },
      BASE_URL,
    );

    expect(mockTeamMemberCreateMany).toHaveBeenCalledOnce();
    const createCall = mockTeamMemberCreateMany.mock.calls[0][0];
    expect(createCall.data).toHaveLength(1);
  });

  it("succeeds as a no-op when memberUserIds is empty and group has no members", async () => {
    mockScimGroupMappingFindUnique.mockResolvedValue(DEFAULT_MAPPING);
    // Call sequence: (1) currentMembers outer, (2) existingMembers in tx for toAdd (toAdd=[]),
    // (3) loadGroupMembers — needs { userId, user: { id, email } } shape
    mockTeamMemberFindMany
      .mockResolvedValueOnce([]) // currentMembers (outer) — no current members
      .mockResolvedValueOnce([]) // existingMembers in tx for toAdd (toAdd is empty, still called)
      .mockResolvedValueOnce([]); // loadGroupMembers — returns members with user shape

    const result = await replaceScimGroup(
      TENANT_ID,
      SCIM_ID,
      { displayName: "core:ADMIN", memberUserIds: [] },
      BASE_URL,
    );

    expect(mockTeamMemberCreateMany).not.toHaveBeenCalled();
    expect(mockTeamMemberUpdateMany).not.toHaveBeenCalled();
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
  });

  it("throws ScimGroupNotFoundError when mapping does not exist", async () => {
    mockScimGroupMappingFindUnique.mockResolvedValue(null);

    await expect(
      replaceScimGroup(
        TENANT_ID,
        SCIM_ID,
        { displayName: "core:ADMIN", memberUserIds: [] },
        BASE_URL,
      ),
    ).rejects.toThrow(ScimGroupNotFoundError);
  });

  it("throws ScimDisplayNameMismatchError when displayName does not match", async () => {
    mockScimGroupMappingFindUnique.mockResolvedValue(DEFAULT_MAPPING);
    // No need to mock further — error is thrown before transaction
    await expect(
      replaceScimGroup(TENANT_ID, SCIM_ID, { displayName: "wrong:ADMIN", memberUserIds: [] }, BASE_URL),
    ).rejects.toThrow(ScimDisplayNameMismatchError);
  });

  it("calls updateMany to upgrade role for existing members with wrong role (toUpdateRole path)", async () => {
    mockScimGroupMappingFindUnique.mockResolvedValue(DEFAULT_MAPPING);
    // user-a is already a team member with role MEMBER; replace requests role ADMIN
    // currentMembers inside tx: user-a is NOT currently in the ADMIN role group
    mockTeamMemberFindMany
      .mockResolvedValueOnce([]) // currentMembers in tx (not in ADMIN group yet)
      .mockResolvedValueOnce([{ id: "m-1", userId: "user-a", role: "MEMBER" }]) // existingMembers in tx (toAdd batch pre-fetch)
      .mockResolvedValueOnce([]); // loadGroupMembers
    mockTeamMemberUpdateMany.mockResolvedValue({ count: 1 });

    const result = await replaceScimGroup(
      TENANT_ID,
      SCIM_ID,
      { displayName: "core:ADMIN", memberUserIds: ["user-a"] },
      BASE_URL,
    );

    // updateMany should be called to upgrade role from MEMBER to ADMIN
    expect(mockTeamMemberUpdateMany).toHaveBeenCalledOnce();
    const updateCall = mockTeamMemberUpdateMany.mock.calls[0][0];
    expect(updateCall.where.id.in).toContain("m-1");
    expect(updateCall.data.role).toBe("ADMIN");
    // createMany must NOT be called since user-a already exists
    expect(mockTeamMemberCreateMany).not.toHaveBeenCalled();
    expect(result.added).toBe(1);
  });
});

describe("patchScimGroup", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Re-apply the transaction implementation after reset
    mockTransaction.mockImplementation(async (fn) => fn({
      teamMember: {
        findMany: mockTeamMemberFindMany,
        createMany: mockTeamMemberCreateMany,
        updateMany: mockTeamMemberUpdateMany,
      },
      tenantMember: { findMany: mockTenantMemberFindMany },
    }));
  });

  it("adds multiple users via add operations in a single batch", async () => {
    mockScimGroupMappingFindUnique.mockResolvedValue(DEFAULT_MAPPING);
    mockTeamMemberFindMany
      .mockResolvedValueOnce([]) // existingMembers in tx for addOps
      .mockResolvedValueOnce([]); // loadGroupMembers
    mockTenantMemberFindMany.mockResolvedValue([
      { userId: "user-a" },
      { userId: "user-b" },
    ]);
    mockTeamMemberCreateMany.mockResolvedValue({ count: 2 });

    const result = await patchScimGroup(
      TENANT_ID,
      SCIM_ID,
      [
        { op: "add", userId: "user-a" },
        { op: "add", userId: "user-b" },
      ],
      BASE_URL,
    );

    expect(mockTeamMemberCreateMany).toHaveBeenCalledOnce();
    const createCall = mockTeamMemberCreateMany.mock.calls[0][0];
    expect(createCall.data).toHaveLength(2);
    expect(result.teamId).toBe(TEAM_ID);
    expect(result.role).toBe("ADMIN");
  });

  it("removes multiple users via remove operations in a single batch", async () => {
    mockScimGroupMappingFindUnique.mockResolvedValue(DEFAULT_MAPPING);
    const existingMembers = [
      { id: "m-1", userId: "user-a", role: "ADMIN" },
      { id: "m-2", userId: "user-b", role: "ADMIN" },
    ];
    // Call sequence: applyAddOperations with addOps=[] returns early (no findMany)
    // (1) tx.teamMember.findMany for validate existence (removeOps)
    // (2) tx.teamMember.findMany in applyRemoveOperations (freshMembers)
    // (3) prisma.teamMember.findMany in loadGroupMembers (after tx)
    mockTeamMemberFindMany
      .mockResolvedValueOnce(existingMembers) // validate existence in removeOps
      .mockResolvedValueOnce(existingMembers) // freshMembers in applyRemoveOperations
      .mockResolvedValueOnce([]); // loadGroupMembers (after tx)
    mockTeamMemberUpdateMany.mockResolvedValue({ count: 2 });

    await patchScimGroup(
      TENANT_ID,
      SCIM_ID,
      [
        { op: "remove", userId: "user-a" },
        { op: "remove", userId: "user-b" },
      ],
      BASE_URL,
    );

    expect(mockTeamMemberUpdateMany).toHaveBeenCalledOnce();
    const updateCall = mockTeamMemberUpdateMany.mock.calls[0][0];
    expect(updateCall.where.id.in).toEqual(expect.arrayContaining(["m-1", "m-2"]));
    expect(updateCall.data.role).toBe("MEMBER");
  });

  it("throws ScimOwnerProtectedError when adding a user with OWNER role", async () => {
    mockScimGroupMappingFindUnique.mockResolvedValue(DEFAULT_MAPPING);
    mockTeamMemberFindMany.mockResolvedValueOnce([
      { id: "m-owner", userId: "user-a", role: "OWNER" },
    ]);

    await expect(
      patchScimGroup(TENANT_ID, SCIM_ID, [{ op: "add", userId: "user-a" }], BASE_URL),
    ).rejects.toThrow(ScimOwnerProtectedError);
  });

  it("throws ScimOwnerProtectedError when removing a user with OWNER role", async () => {
    mockScimGroupMappingFindUnique.mockResolvedValue(DEFAULT_MAPPING);
    // Call sequence: applyAddOperations with addOps=[] returns early (no findMany)
    // (1) tx.teamMember.findMany for validate existence → returns member with OWNER role
    // (2) tx.teamMember.findMany in applyRemoveOperations (freshMembers) → same OWNER member
    const ownerMember = [{ id: "m-owner", userId: "user-a", role: "OWNER" }];
    mockTeamMemberFindMany
      .mockResolvedValueOnce(ownerMember) // validate existence in removeOps
      .mockResolvedValueOnce(ownerMember); // freshMembers in applyRemoveOperations → throws OWNER_PROTECTED

    await expect(
      patchScimGroup(TENANT_ID, SCIM_ID, [{ op: "remove", userId: "user-a" }], BASE_URL),
    ).rejects.toThrow(ScimOwnerProtectedError);
  });

  it("throws ScimNoSuchMemberError when adding a userId not in the tenant", async () => {
    mockScimGroupMappingFindUnique.mockResolvedValue(DEFAULT_MAPPING);
    mockTeamMemberFindMany.mockResolvedValueOnce([]); // not an existing team member
    mockTenantMemberFindMany.mockResolvedValue([]); // not an active tenant member

    const err = await patchScimGroup(
      TENANT_ID,
      SCIM_ID,
      [{ op: "add", userId: "ghost-user" }],
      BASE_URL,
    ).catch((e) => e);

    expect(err).toBeInstanceOf(ScimNoSuchMemberError);
    expect(err.userId).toBe("ghost-user");
  });

  it("throws ScimNoSuchMemberError when removing a userId not in the team", async () => {
    mockScimGroupMappingFindUnique.mockResolvedValue(DEFAULT_MAPPING);
    // memberByUserId map won't contain the userId
    mockTeamMemberFindMany.mockResolvedValueOnce([]);

    await expect(
      patchScimGroup(TENANT_ID, SCIM_ID, [{ op: "remove", userId: "ghost-user" }], BASE_URL),
    ).rejects.toThrow(ScimNoSuchMemberError);
  });

  it("handles duplicate userIds in add operations gracefully", async () => {
    mockScimGroupMappingFindUnique.mockResolvedValue(DEFAULT_MAPPING);
    // Both ops for the same user; existingMembers returns that user once
    mockTeamMemberFindMany
      .mockResolvedValueOnce([]) // existingMembers in tx (not yet a team member)
      .mockResolvedValueOnce([]); // loadGroupMembers
    // tenantMember.findMany called with de-duped list — user-a appears twice in ops but once in DB
    mockTenantMemberFindMany.mockResolvedValue([{ userId: "user-a" }]);
    mockTeamMemberCreateMany.mockResolvedValue({ count: 1 });

    await patchScimGroup(
      TENANT_ID,
      SCIM_ID,
      [
        { op: "add", userId: "user-a" },
        { op: "add", userId: "user-a" },
      ],
      BASE_URL,
    );

    // createMany is called (duplicates are not collapsed at this layer — caller is expected to
    // deduplicate; the DB unique constraint would reject true duplicates)
    expect(mockTeamMemberCreateMany).toHaveBeenCalled();
  });

  it("calls updateMany to upgrade role for an existing member with wrong role (toUpdateRole path)", async () => {
    mockScimGroupMappingFindUnique.mockResolvedValue(DEFAULT_MAPPING);
    // user-a is already a team member with MEMBER role; add op requests ADMIN
    mockTeamMemberFindMany
      .mockResolvedValueOnce([{ id: "m-1", userId: "user-a", role: "MEMBER" }]) // existingMembers in tx for addOps
      .mockResolvedValueOnce([]); // loadGroupMembers
    mockTeamMemberUpdateMany.mockResolvedValue({ count: 1 });

    await patchScimGroup(
      TENANT_ID,
      SCIM_ID,
      [{ op: "add", userId: "user-a" }],
      BASE_URL,
    );

    // updateMany should upgrade role from MEMBER to ADMIN
    expect(mockTeamMemberUpdateMany).toHaveBeenCalledOnce();
    const updateCall = mockTeamMemberUpdateMany.mock.calls[0][0];
    expect(updateCall.where.id.in).toContain("m-1");
    expect(updateCall.data.role).toBe("ADMIN");
    // createMany must NOT be called since user-a already exists
    expect(mockTeamMemberCreateMany).not.toHaveBeenCalled();
  });

  it("succeeds as a no-op when operations list is empty", async () => {
    mockScimGroupMappingFindUnique.mockResolvedValue(DEFAULT_MAPPING);
    mockTeamMemberFindMany.mockResolvedValueOnce([]); // loadGroupMembers

    const result = await patchScimGroup(TENANT_ID, SCIM_ID, [], BASE_URL);

    expect(mockTeamMemberCreateMany).not.toHaveBeenCalled();
    expect(mockTeamMemberUpdateMany).not.toHaveBeenCalled();
    expect(result.teamId).toBe(TEAM_ID);
  });

  it("throws ScimGroupNotFoundError when mapping does not exist", async () => {
    mockScimGroupMappingFindUnique.mockResolvedValue(null);

    await expect(
      patchScimGroup(TENANT_ID, SCIM_ID, [{ op: "add", userId: "user-a" }], BASE_URL),
    ).rejects.toThrow(ScimGroupNotFoundError);
  });
});
