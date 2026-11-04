import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockTeamLockRead,
  mockTeamFolderFindUnique,
  mockTeamTagCount,
  mockTeamPasswordEntryCreate,
  mockTeamPasswordEntryUpdate,
  mockTeamPasswordEntryHistoryCreate,
  mockTeamPasswordEntryHistoryFindMany,
  mockTeamPasswordEntryHistoryDeleteMany,
  mockTxQueryRaw,
  mockTransaction,
  mockTeamMemberFindFirst,
  queryRawOn,
} = vi.hoisted(() => {
  // The actor's role, re-read under the team lock (activeTeamRole).
  const mockTeamMemberFindFirst = vi.fn();
  const mockTeamLockRead = vi.fn();
  const mockTeamFolderFindUnique = vi.fn();
  const mockTeamTagCount = vi.fn();
  const mockTeamPasswordEntryCreate = vi.fn();
  const mockTeamPasswordEntryUpdate = vi.fn();
  const mockTeamPasswordEntryHistoryCreate = vi.fn();
  const mockTeamPasswordEntryHistoryFindMany = vi.fn();
  const mockTeamPasswordEntryHistoryDeleteMany = vi.fn();

  // curRow for the FOR UPDATE re-read — values DISTINCT from BASE_EXISTING_ENTRY
  // so field-level assertions detect if the snapshot was sourced from existingEntry instead.
  const teamCurRow = {
    encrypted_blob: "cur-team-blob",
    blob_iv: "cur-team-iv",
    blob_auth_tag: "cur-team-tag",
    aad_version: 11,
    team_key_version: 5,
    item_key_version: 2,
    encrypted_item_key: "cur-ik-cipher",
    item_key_iv: "cur-ik-iv",
    item_key_auth_tag: "cur-ik-tag",
    item_key_id: "11111111-1111-4111-8111-111111111111",
    item_key_team_key_version: 5,
    item_key_version_high_water: 2,
  };
  const mockTxQueryRaw = vi.fn().mockResolvedValue([teamCurRow]);

  // $queryRaw dispatcher: the team key-version lock read (FROM teams) goes to
  // mockTeamLockRead (with the client it ran on), every other raw query —
  // the entry FOR UPDATE snapshot — to mockTxQueryRaw.
  const queryRawOn = (via: "prisma" | "tx") =>
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?");
      // The bounded lock wait reads the timeouts it later restores.
      if (sql.includes("current_setting('lock_timeout')")) return [{ lock_timeout: "0", statement_timeout: "0" }];
      if (/FROM teams\b/.test(sql)) {
        const team = await mockTeamLockRead(values[0], sql, via);
        return team ? [{ team_key_version: team.teamKeyVersion, tenant_id: team.tenantId }] : [];
      }
      return mockTxQueryRaw(strings, ...values);
    };

  const txClient = {
    $queryRaw: queryRawOn("tx"),
    // setLockTimeout before the team key-version FOR SHARE.
    $executeRaw: vi.fn(),
    teamPasswordEntryHistory: {
      create: mockTeamPasswordEntryHistoryCreate,
      findMany: mockTeamPasswordEntryHistoryFindMany,
      deleteMany: mockTeamPasswordEntryHistoryDeleteMany,
    },
    teamPasswordEntry: {
      update: mockTeamPasswordEntryUpdate,
    },
    teamMember: { findFirst: mockTeamMemberFindFirst },
  };

  const mockTransaction = vi.fn(async (fn: (tx: typeof txClient) => Promise<unknown>) =>
    fn(txClient),
  );

  return {
    mockTeamLockRead,
    mockTeamFolderFindUnique,
    mockTeamTagCount,
    mockTeamPasswordEntryCreate,
    mockTeamPasswordEntryUpdate,
    mockTeamPasswordEntryHistoryCreate,
    mockTeamPasswordEntryHistoryFindMany,
    mockTeamPasswordEntryHistoryDeleteMany,
    mockTxQueryRaw,
    mockTransaction,
    mockTeamMemberFindFirst,
    queryRawOn,
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamFolder: {
      findUnique: mockTeamFolderFindUnique,
    },
    teamTag: {
      count: mockTeamTagCount,
    },
    teamPasswordEntry: {
      create: mockTeamPasswordEntryCreate,
      update: mockTeamPasswordEntryUpdate,
    },
    $queryRaw: queryRawOn("prisma"),
    $executeRaw: vi.fn(),
    $transaction: mockTransaction,
  },
}));

import {
  createTeamPassword,
  updateTeamPassword,
  TeamPasswordServiceError,
  type CreateTeamPasswordInput,
  type UpdateTeamPasswordInput,
} from "./team-password-service";
import { API_ERROR } from "@/lib/http/api-error-codes";

const TEAM_ID = "team-1";
const PASSWORD_ID = "entry-1";
const USER_ID = "user-1";
const TENANT_ID = "tenant-1";
const FOLDER_ID = "folder-1";

// UUID v4 variants for backward-compatibility coverage
const TEAM_ID_UUID = "550e8400-e29b-41d4-a716-446655440000";
const PASSWORD_ID_UUID = "550e8400-e29b-41d4-a716-446655440001";

const ENCRYPTED_BLOB = { ciphertext: "blob-ct", iv: "blob-iv", authTag: "blob-tag" };
const ENCRYPTED_OVERVIEW = { ciphertext: "ov-ct", iv: "ov-iv", authTag: "ov-tag" };
const ENCRYPTED_ITEM_KEY = { ciphertext: "ik-ct", iv: "ik-iv", authTag: "ik-tag" };

const DEFAULT_TEAM = { teamKeyVersion: 3, tenantId: TENANT_ID };
const DEFAULT_FOLDER = { teamId: TEAM_ID };

const BASE_CREATE_INPUT: CreateTeamPasswordInput = {
  encryptedBlob: ENCRYPTED_BLOB,
  encryptedOverview: ENCRYPTED_OVERVIEW,
  aadVersion: 1,
  teamKeyVersion: 3,
  itemKeyVersion: 0,
  entryType: "LOGIN",
  userId: USER_ID,
};

const BASE_EXISTING_ENTRY: UpdateTeamPasswordInput["existingEntry"] = {
  tenantId: TENANT_ID,
  encryptedBlob: "old-blob",
  blobIv: "old-iv",
  blobAuthTag: "old-tag",
  aadVersion: 1,
  teamKeyVersion: 3,
  itemKeyVersion: 0,
  encryptedItemKey: null,
  itemKeyIv: null,
  itemKeyAuthTag: null,
};

// ---------------------------------------------------------------------------
// createTeamPassword
// ---------------------------------------------------------------------------

describe("createTeamPassword", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("creates entry successfully when both team and folder are valid", async () => {
    mockTeamLockRead.mockResolvedValue(DEFAULT_TEAM);
    mockTeamFolderFindUnique.mockResolvedValue(DEFAULT_FOLDER);
    const created = { id: "entry-1", tags: [] };
    mockTeamPasswordEntryCreate.mockResolvedValue(created);

    const result = await createTeamPassword(TEAM_ID, {
      ...BASE_CREATE_INPUT,
      teamFolderId: FOLDER_ID,
    });

    expect(result).toBe(created);
    expect(mockTeamLockRead).toHaveBeenCalledOnce();
    expect(mockTeamFolderFindUnique).toHaveBeenCalledOnce();
    expect(mockTeamPasswordEntryCreate).toHaveBeenCalledOnce();
  });

  it("creates entry successfully when no folderId is provided", async () => {
    mockTeamLockRead.mockResolvedValue(DEFAULT_TEAM);
    const created = { id: "entry-1", tags: [] };
    mockTeamPasswordEntryCreate.mockResolvedValue(created);

    const result = await createTeamPassword(TEAM_ID, BASE_CREATE_INPUT);

    expect(result).toBe(created);
    expect(mockTeamLockRead).toHaveBeenCalledOnce();
    // Folder query must not happen when no folderId given
    expect(mockTeamFolderFindUnique).not.toHaveBeenCalled();
    expect(mockTeamPasswordEntryCreate).toHaveBeenCalledOnce();
  });

  it("throws TeamPasswordServiceError (TEAM_KEY_VERSION_MISMATCH) when team is not found", async () => {
    mockTeamLockRead.mockResolvedValue(null);

    await expect(
      createTeamPassword(TEAM_ID, BASE_CREATE_INPUT),
    ).rejects.toThrow(TeamPasswordServiceError);

    const err = await createTeamPassword(TEAM_ID, BASE_CREATE_INPUT).catch((e) => e);
    expect(err).toBeInstanceOf(TeamPasswordServiceError);
    expect(err.code).toBe("TEAM_KEY_VERSION_MISMATCH");
    expect(err.statusHint).toBe(409);
  });

  it("throws TeamPasswordServiceError (TEAM_KEY_VERSION_MISMATCH) when teamKeyVersion does not match", async () => {
    mockTeamLockRead.mockResolvedValue({ ...DEFAULT_TEAM, teamKeyVersion: 99 });

    const err = await createTeamPassword(TEAM_ID, BASE_CREATE_INPUT).catch((e) => e);
    expect(err).toBeInstanceOf(TeamPasswordServiceError);
    expect(err.code).toBe("TEAM_KEY_VERSION_MISMATCH");
  });

  it("answers TEAM_KEY_VERSION_MISMATCH (409) when a rotation holds the team past the lock timeout", async () => {
    // lock_not_available, nested the way the pg driver adapter reports it.
    mockTeamLockRead.mockRejectedValue(
      Object.assign(new Error("canceling statement due to lock timeout"), {
        meta: { driverAdapterError: { cause: { originalCode: "55P03" } } },
      }),
    );

    const err = await createTeamPassword(TEAM_ID, BASE_CREATE_INPUT).catch((e) => e);
    expect(err).toBeInstanceOf(TeamPasswordServiceError);
    expect(err.code).toBe("TEAM_KEY_VERSION_MISMATCH");
    expect(err.statusHint).toBe(409);
    expect(mockTeamPasswordEntryCreate).not.toHaveBeenCalled();
  });

  it("propagates a lock-read failure other than a lock timeout unchanged", async () => {
    const boom = new Error("connection reset");
    mockTeamLockRead.mockRejectedValue(boom);

    await expect(createTeamPassword(TEAM_ID, BASE_CREATE_INPUT)).rejects.toBe(boom);
    expect(mockTeamPasswordEntryCreate).not.toHaveBeenCalled();
  });

  it("throws TeamPasswordServiceError (FOLDER_NOT_FOUND) when folder does not exist", async () => {
    mockTeamLockRead.mockResolvedValue(DEFAULT_TEAM);
    mockTeamFolderFindUnique.mockResolvedValue(null);

    const err = await createTeamPassword(TEAM_ID, {
      ...BASE_CREATE_INPUT,
      teamFolderId: FOLDER_ID,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(TeamPasswordServiceError);
    expect(err.code).toBe(API_ERROR.FOLDER_NOT_FOUND);
    expect(err.statusHint).toBe(400);
  });

  it("throws TeamPasswordServiceError (FOLDER_NOT_FOUND) when folder belongs to a different team", async () => {
    mockTeamLockRead.mockResolvedValue(DEFAULT_TEAM);
    mockTeamFolderFindUnique.mockResolvedValue({ teamId: "other-team" });

    const err = await createTeamPassword(TEAM_ID, {
      ...BASE_CREATE_INPUT,
      teamFolderId: FOLDER_ID,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(TeamPasswordServiceError);
    expect(err.code).toBe(API_ERROR.FOLDER_NOT_FOUND);
  });

  it("calls both team and folder queries", async () => {
    mockTeamLockRead.mockResolvedValue(DEFAULT_TEAM);
    mockTeamFolderFindUnique.mockResolvedValue(DEFAULT_FOLDER);
    mockTeamPasswordEntryCreate.mockResolvedValue({ id: "entry-1", tags: [] });

    await createTeamPassword(TEAM_ID, {
      ...BASE_CREATE_INPUT,
      teamFolderId: FOLDER_ID,
    });

    expect(mockTeamLockRead).toHaveBeenCalledWith(
      TEAM_ID,
      expect.stringMatching(/FROM teams WHERE id = \?::uuid FOR SHARE/),
      "prisma",
    );
    expect(mockTeamFolderFindUnique).toHaveBeenCalledWith({
      where: { id: FOLDER_ID },
      select: { teamId: true },
    });
  });

  it("uses client-provided id when given", async () => {
    const clientId = "client-uuid-abc";
    mockTeamLockRead.mockResolvedValue(DEFAULT_TEAM);
    mockTeamPasswordEntryCreate.mockResolvedValue({ id: clientId, tags: [] });

    await createTeamPassword(TEAM_ID, { ...BASE_CREATE_INPUT, id: clientId });

    const createCall = mockTeamPasswordEntryCreate.mock.calls[0][0];
    expect(createCall.data.id).toBe(clientId);
  });

  it("mints the ItemKey id server-side and marks a v1 entry created under the current team key", async () => {
    mockTeamLockRead.mockResolvedValue(DEFAULT_TEAM);
    mockTeamPasswordEntryCreate.mockResolvedValue({ id: "entry-1", tags: [] });

    await createTeamPassword(TEAM_ID, {
      ...BASE_CREATE_INPUT,
      itemKeyVersion: 1,
      encryptedItemKey: ENCRYPTED_ITEM_KEY,
    });

    const data = mockTeamPasswordEntryCreate.mock.calls[0][0].data;
    expect(data.itemKeyId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(data.itemKeyTeamKeyVersion).toBe(DEFAULT_TEAM.teamKeyVersion);
    expect(data.itemKeyVersionHighWater).toBe(1);
  });

  it("mints a different ItemKey id for each created entry", async () => {
    mockTeamLockRead.mockResolvedValue(DEFAULT_TEAM);
    mockTeamPasswordEntryCreate.mockResolvedValue({ id: "entry-1", tags: [] });
    const v1 = { ...BASE_CREATE_INPUT, itemKeyVersion: 1, encryptedItemKey: ENCRYPTED_ITEM_KEY };

    await createTeamPassword(TEAM_ID, v1);
    await createTeamPassword(TEAM_ID, v1);

    const [a, b] = mockTeamPasswordEntryCreate.mock.calls.map((c) => c[0].data.itemKeyId);
    expect(a).not.toBe(b);
  });

  it("creates a v0 entry with no ItemKey id, marked at the current team key version", async () => {
    mockTeamLockRead.mockResolvedValue(DEFAULT_TEAM);
    mockTeamPasswordEntryCreate.mockResolvedValue({ id: "entry-1", tags: [] });

    await createTeamPassword(TEAM_ID, BASE_CREATE_INPUT);

    const data = mockTeamPasswordEntryCreate.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("itemKeyId");
    expect(data.itemKeyTeamKeyVersion).toBe(DEFAULT_TEAM.teamKeyVersion);
    expect(data.itemKeyVersionHighWater).toBe(0);
  });

  it("creates entry with UUID v4 teamId and entryId", async () => {
    mockTeamLockRead.mockResolvedValue(DEFAULT_TEAM);
    const created = { id: PASSWORD_ID_UUID, tags: [] };
    mockTeamPasswordEntryCreate.mockResolvedValue(created);

    const result = await createTeamPassword(TEAM_ID_UUID, {
      ...BASE_CREATE_INPUT,
      id: PASSWORD_ID_UUID,
    });

    expect(result).toBe(created);
    const createCall = mockTeamPasswordEntryCreate.mock.calls[0][0];
    expect(createCall.data.id).toBe(PASSWORD_ID_UUID);
    expect(mockTeamLockRead).toHaveBeenCalledWith(TEAM_ID_UUID, expect.any(String), "prisma");
  });

  it("accepts tagIds that belong to the same team", async () => {
    mockTeamLockRead.mockResolvedValue(DEFAULT_TEAM);
    mockTeamTagCount.mockResolvedValue(2);
    const created = { id: "entry-1", tags: [] };
    mockTeamPasswordEntryCreate.mockResolvedValue(created);

    const result = await createTeamPassword(TEAM_ID, {
      ...BASE_CREATE_INPUT,
      tagIds: ["tag-1", "tag-2"],
    });

    expect(result).toBe(created);
    expect(mockTeamTagCount).toHaveBeenCalledWith({
      where: { id: { in: ["tag-1", "tag-2"] }, teamId: TEAM_ID },
    });
  });

  it("accepts empty tagIds without calling teamTag.count", async () => {
    mockTeamLockRead.mockResolvedValue(DEFAULT_TEAM);
    const created = { id: "entry-1", tags: [] };
    mockTeamPasswordEntryCreate.mockResolvedValue(created);

    await createTeamPassword(TEAM_ID, { ...BASE_CREATE_INPUT, tagIds: [] });

    expect(mockTeamTagCount).not.toHaveBeenCalled();
  });

  it("accepts undefined tagIds without calling teamTag.count", async () => {
    mockTeamLockRead.mockResolvedValue(DEFAULT_TEAM);
    const created = { id: "entry-1", tags: [] };
    mockTeamPasswordEntryCreate.mockResolvedValue(created);

    await createTeamPassword(TEAM_ID, BASE_CREATE_INPUT);

    expect(mockTeamTagCount).not.toHaveBeenCalled();
  });

  it("rejects tagIds from another team in same tenant on create", async () => {
    mockTeamLockRead.mockResolvedValue(DEFAULT_TEAM);
    mockTeamTagCount.mockResolvedValue(1); // only 1 of 2 tags belong to this team

    const err = await createTeamPassword(TEAM_ID, {
      ...BASE_CREATE_INPUT,
      tagIds: ["tag-1", "tag-other-team"],
    }).catch((e) => e);

    expect(err).toBeInstanceOf(TeamPasswordServiceError);
    expect(err.code).toBe(API_ERROR.NOT_FOUND);
    expect(err.statusHint).toBe(404);
    expect(mockTeamPasswordEntryCreate).not.toHaveBeenCalled();
  });

  it("accepts duplicate tagIds — deduplicates before comparing to teamTag.count", async () => {
    // A client may legitimately send ["tag-1","tag-1"] (e.g. UI bug); without
    // dedup the count check would fail spuriously because teamTag.count returns
    // distinct rows (1) while the raw input length is 2.
    mockTeamLockRead.mockResolvedValue(DEFAULT_TEAM);
    mockTeamTagCount.mockResolvedValue(1);
    const created = { id: "entry-1", tags: [] };
    mockTeamPasswordEntryCreate.mockResolvedValue(created);

    const result = await createTeamPassword(TEAM_ID, {
      ...BASE_CREATE_INPUT,
      tagIds: ["tag-1", "tag-1"],
    });

    expect(result).toBe(created);
    // count must be queried with the deduped IDs ([tag-1]), not the raw input
    expect(mockTeamTagCount).toHaveBeenCalledWith({
      where: { id: { in: ["tag-1"] }, teamId: TEAM_ID },
    });
    // The relation write must also dedupe — a duplicate connect is malformed
    // input to Prisma. Only the unique tag is connected.
    const createData = mockTeamPasswordEntryCreate.mock.calls[0][0].data;
    expect(createData.tags).toEqual({ connect: [{ id: "tag-1" }] });
  });
});

// ---------------------------------------------------------------------------
// updateTeamPassword
// ---------------------------------------------------------------------------

// curRow values accessible in test assertions (must match the vi.hoisted values)
const TEAM_CUR_ROW = {
  encrypted_blob: "cur-team-blob",
  blob_iv: "cur-team-iv",
  blob_auth_tag: "cur-team-tag",
  aad_version: 11,
  team_key_version: 5,
  item_key_version: 2,
  encrypted_item_key: "cur-ik-cipher",
  item_key_iv: "cur-ik-iv",
  item_key_auth_tag: "cur-ik-tag",
  item_key_id: "11111111-1111-4111-8111-111111111111",
  item_key_team_key_version: 5,
  item_key_version_high_water: 2,
  created_by_id: "user-1",
};
const CUR_ITEM_KEY_ID = TEAM_CUR_ROW.item_key_id;

// A v0 entry: no ItemKey, the blob sealed under the team key directly.
const TEAM_CUR_ROW_V0 = {
  ...TEAM_CUR_ROW,
  item_key_version: 0,
  encrypted_item_key: null,
  item_key_iv: null,
  item_key_auth_tag: null,
  item_key_id: null,
  item_key_version_high_water: 1,
};

describe("updateTeamPassword", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Re-apply $queryRaw and transaction implementation after reset
    mockTxQueryRaw.mockResolvedValue([TEAM_CUR_ROW]);
    mockTeamMemberFindFirst.mockResolvedValue({ role: "ADMIN" });
    mockTransaction.mockImplementation(async (fn) =>
      fn({
        $queryRaw: queryRawOn("tx"),
        $executeRaw: vi.fn(),
        teamPasswordEntryHistory: {
          create: mockTeamPasswordEntryHistoryCreate,
          findMany: mockTeamPasswordEntryHistoryFindMany,
          deleteMany: mockTeamPasswordEntryHistoryDeleteMany,
        },
        teamPasswordEntry: {
          update: mockTeamPasswordEntryUpdate,
        },
        teamMember: { findFirst: mockTeamMemberFindFirst },
      }),
    );
  });

  it("updates entry with full payload (team version check + folder validation)", async () => {
    mockTeamLockRead.mockResolvedValue({ teamKeyVersion: 5 });
    mockTeamFolderFindUnique.mockResolvedValue(DEFAULT_FOLDER);
    mockTeamPasswordEntryHistoryCreate.mockResolvedValue({});
    mockTeamPasswordEntryHistoryFindMany.mockResolvedValue([{ id: "h-1" }]);
    const updated = { id: PASSWORD_ID, tags: [] };
    mockTeamPasswordEntryUpdate.mockResolvedValue(updated);

    const input: UpdateTeamPasswordInput = {
      encryptedBlob: ENCRYPTED_BLOB,
      encryptedOverview: ENCRYPTED_OVERVIEW,
      aadVersion: 1,
      teamKeyVersion: 5,
      itemKeyVersion: 2,
      itemKeyId: CUR_ITEM_KEY_ID,
      teamFolderId: FOLDER_ID,
      userId: USER_ID,
      existingEntry: BASE_EXISTING_ENTRY,
    };

    const result = await updateTeamPassword(TEAM_ID, PASSWORD_ID, input);

    expect(result).toBe(updated);
    expect(mockTeamLockRead).toHaveBeenCalledOnce();
    expect(mockTeamFolderFindUnique).toHaveBeenCalledOnce();
    expect(mockTeamPasswordEntryHistoryCreate).toHaveBeenCalledOnce();
    expect(mockTeamPasswordEntryUpdate).toHaveBeenCalledOnce();
  });

  it("updates entry with metadata-only payload (no team version check)", async () => {
    mockTeamFolderFindUnique.mockResolvedValue(DEFAULT_FOLDER);
    mockTeamPasswordEntryUpdate.mockResolvedValue({ id: PASSWORD_ID, tags: [] });

    const input: UpdateTeamPasswordInput = {
      // No encryptedBlob → metadata-only update
      isArchived: true,
      teamFolderId: FOLDER_ID,
      userId: USER_ID,
      existingEntry: BASE_EXISTING_ENTRY,
    };

    await updateTeamPassword(TEAM_ID, PASSWORD_ID, input);

    // Team must NOT be queried when encryptedBlob is absent
    expect(mockTeamLockRead).not.toHaveBeenCalled();
    expect(mockTeamFolderFindUnique).toHaveBeenCalledOnce();
    // No history snapshot for metadata-only updates
    expect(mockTeamPasswordEntryHistoryCreate).not.toHaveBeenCalled();
    expect(mockTeamPasswordEntryUpdate).toHaveBeenCalledOnce();
  });

  it("deduplicates tagIds in the relation set on update", async () => {
    mockTeamTagCount.mockResolvedValue(1); // tag-1 owned (distinct count)
    mockTeamPasswordEntryUpdate.mockResolvedValue({ id: PASSWORD_ID, tags: [] });

    const input: UpdateTeamPasswordInput = {
      tagIds: ["tag-1", "tag-1"],
      userId: USER_ID,
      existingEntry: BASE_EXISTING_ENTRY,
    };

    await updateTeamPassword(TEAM_ID, PASSWORD_ID, input);

    // A duplicate `set` is malformed input to Prisma — only the unique tag is set.
    const updateData = mockTeamPasswordEntryUpdate.mock.calls[0][0].data;
    expect(updateData.tags).toEqual({ set: [{ id: "tag-1" }] });
  });

  it("throws TeamPasswordServiceError (TEAM_KEY_VERSION_MISMATCH) when team version differs", async () => {
    mockTeamLockRead.mockResolvedValue({ teamKeyVersion: 99 });

    const input: UpdateTeamPasswordInput = {
      encryptedBlob: ENCRYPTED_BLOB,
      encryptedOverview: ENCRYPTED_OVERVIEW,
      aadVersion: 1,
      teamKeyVersion: 5,
      itemKeyVersion: 2,
      itemKeyId: CUR_ITEM_KEY_ID,
      userId: USER_ID,
      existingEntry: BASE_EXISTING_ENTRY,
    };

    const err = await updateTeamPassword(TEAM_ID, PASSWORD_ID, input).catch((e) => e);
    expect(err).toBeInstanceOf(TeamPasswordServiceError);
    expect(err.code).toBe("TEAM_KEY_VERSION_MISMATCH");
    expect(err.statusHint).toBe(409);
  });

  it("throws TeamPasswordServiceError (TEAM_KEY_VERSION_MISMATCH) when team is not found during full update", async () => {
    mockTeamLockRead.mockResolvedValue(null);

    const input: UpdateTeamPasswordInput = {
      encryptedBlob: ENCRYPTED_BLOB,
      encryptedOverview: ENCRYPTED_OVERVIEW,
      aadVersion: 1,
      teamKeyVersion: 5,
      itemKeyVersion: 2,
      itemKeyId: CUR_ITEM_KEY_ID,
      userId: USER_ID,
      existingEntry: BASE_EXISTING_ENTRY,
    };

    const err = await updateTeamPassword(TEAM_ID, PASSWORD_ID, input).catch((e) => e);
    expect(err).toBeInstanceOf(TeamPasswordServiceError);
    expect(err.code).toBe("TEAM_KEY_VERSION_MISMATCH");
  });

  it("throws TeamPasswordServiceError (FOLDER_NOT_FOUND) when folder does not exist", async () => {
    mockTeamFolderFindUnique.mockResolvedValue(null);

    const input: UpdateTeamPasswordInput = {
      teamFolderId: FOLDER_ID,
      userId: USER_ID,
      existingEntry: BASE_EXISTING_ENTRY,
    };

    const err = await updateTeamPassword(TEAM_ID, PASSWORD_ID, input).catch((e) => e);
    expect(err).toBeInstanceOf(TeamPasswordServiceError);
    expect(err.code).toBe(API_ERROR.FOLDER_NOT_FOUND);
    expect(err.statusHint).toBe(400);
  });

  it("throws TeamPasswordServiceError (FOLDER_NOT_FOUND) when folder belongs to a different team", async () => {
    mockTeamFolderFindUnique.mockResolvedValue({ teamId: "other-team" });

    const input: UpdateTeamPasswordInput = {
      teamFolderId: FOLDER_ID,
      userId: USER_ID,
      existingEntry: BASE_EXISTING_ENTRY,
    };

    const err = await updateTeamPassword(TEAM_ID, PASSWORD_ID, input).catch((e) => e);
    expect(err).toBeInstanceOf(TeamPasswordServiceError);
    expect(err.code).toBe(API_ERROR.FOLDER_NOT_FOUND);
  });

  it("creates a history snapshot when encryptedBlob changes", async () => {
    mockTeamLockRead.mockResolvedValue({ teamKeyVersion: 5 });
    mockTeamPasswordEntryHistoryCreate.mockResolvedValue({});
    mockTeamPasswordEntryHistoryFindMany.mockResolvedValue([{ id: "h-1" }]);
    mockTeamPasswordEntryUpdate.mockResolvedValue({ id: PASSWORD_ID, tags: [] });

    const input: UpdateTeamPasswordInput = {
      encryptedBlob: ENCRYPTED_BLOB,
      encryptedOverview: ENCRYPTED_OVERVIEW,
      aadVersion: 1,
      teamKeyVersion: 5,
      itemKeyVersion: 2,
      itemKeyId: CUR_ITEM_KEY_ID,
      userId: USER_ID,
      existingEntry: BASE_EXISTING_ENTRY,
    };

    await updateTeamPassword(TEAM_ID, PASSWORD_ID, input);

    expect(mockTeamPasswordEntryHistoryCreate).toHaveBeenCalledOnce();
    const historyData = mockTeamPasswordEntryHistoryCreate.mock.calls[0][0].data;
    expect(historyData.entryId).toBe(PASSWORD_ID);
    // C1: snapshot blob fields must come from TEAM_CUR_ROW (FOR UPDATE re-read)
    expect(historyData.encryptedBlob).toBe(TEAM_CUR_ROW.encrypted_blob);
    // changedById stays as the current userId (NOT from cur)
    expect(historyData.changedById).toBe(USER_ID);
  });

  it("trims history to 20 entries when limit is exceeded", async () => {
    mockTeamLockRead.mockResolvedValue({ teamKeyVersion: 5 });
    mockTeamPasswordEntryHistoryCreate.mockResolvedValue({});
    // Simulate 21 history records (exceeds the 20-entry limit)
    const historyRecords = Array.from({ length: 21 }, (_, i) => ({ id: `h-${i}` }));
    mockTeamPasswordEntryHistoryFindMany.mockResolvedValue(historyRecords);
    mockTeamPasswordEntryHistoryDeleteMany.mockResolvedValue({ count: 1 });
    mockTeamPasswordEntryUpdate.mockResolvedValue({ id: PASSWORD_ID, tags: [] });

    const input: UpdateTeamPasswordInput = {
      encryptedBlob: ENCRYPTED_BLOB,
      encryptedOverview: ENCRYPTED_OVERVIEW,
      aadVersion: 1,
      teamKeyVersion: 5,
      itemKeyVersion: 2,
      itemKeyId: CUR_ITEM_KEY_ID,
      userId: USER_ID,
      existingEntry: BASE_EXISTING_ENTRY,
    };

    await updateTeamPassword(TEAM_ID, PASSWORD_ID, input);

    expect(mockTeamPasswordEntryHistoryDeleteMany).toHaveBeenCalledOnce();
    const deleteCall = mockTeamPasswordEntryHistoryDeleteMany.mock.calls[0][0];
    // Should delete the oldest 1 record (21 - 20 = 1)
    expect(deleteCall.where.id.in).toHaveLength(1);
    expect(deleteCall.where.id.in).toContain("h-0");
  });

  it("calls both team and folder queries during full update with folder", async () => {
    mockTeamLockRead.mockResolvedValue({ teamKeyVersion: 5 });
    mockTeamFolderFindUnique.mockResolvedValue(DEFAULT_FOLDER);
    mockTeamPasswordEntryHistoryCreate.mockResolvedValue({});
    mockTeamPasswordEntryHistoryFindMany.mockResolvedValue([{ id: "h-1" }]);
    mockTeamPasswordEntryUpdate.mockResolvedValue({ id: PASSWORD_ID, tags: [] });

    const input: UpdateTeamPasswordInput = {
      encryptedBlob: ENCRYPTED_BLOB,
      encryptedOverview: ENCRYPTED_OVERVIEW,
      aadVersion: 1,
      teamKeyVersion: 5,
      itemKeyVersion: 2,
      itemKeyId: CUR_ITEM_KEY_ID,
      teamFolderId: FOLDER_ID,
      userId: USER_ID,
      existingEntry: BASE_EXISTING_ENTRY,
    };

    await updateTeamPassword(TEAM_ID, PASSWORD_ID, input);

    // The version check runs on the transaction client, under FOR SHARE, and
    // before the entry FOR UPDATE (lock order teams → team_password_entries).
    expect(mockTeamLockRead).toHaveBeenCalledWith(
      TEAM_ID,
      expect.stringMatching(/FROM teams WHERE id = \?::uuid FOR SHARE/),
      "tx",
    );
    expect(mockTeamLockRead.mock.invocationCallOrder[0]).toBeLessThan(
      mockTxQueryRaw.mock.invocationCallOrder[0],
    );
    expect(mockTeamFolderFindUnique).toHaveBeenCalledWith({
      where: { id: FOLDER_ID },
      select: { teamId: true },
    });
  });

  // ── ItemKey identity and re-key rules, decided against the locked row (plan C1/C6) ──

  const FULL_REUSE: UpdateTeamPasswordInput = {
    encryptedBlob: ENCRYPTED_BLOB,
    encryptedOverview: ENCRYPTED_OVERVIEW,
    aadVersion: 1,
    teamKeyVersion: 5,
    itemKeyVersion: 2,
    itemKeyId: CUR_ITEM_KEY_ID,
    userId: USER_ID,
    existingEntry: BASE_EXISTING_ENTRY,
  };

  // v0→v1 upgrade of TEAM_CUR_ROW_V0 (high-water 1 → the new ItemKey is v2).
  const UPGRADE: UpdateTeamPasswordInput = {
    encryptedBlob: ENCRYPTED_BLOB,
    encryptedOverview: ENCRYPTED_OVERVIEW,
    aadVersion: 1,
    teamKeyVersion: 5,
    itemKeyVersion: 2,
    encryptedItemKey: ENCRYPTED_ITEM_KEY,
    snapshotBlobIv: TEAM_CUR_ROW_V0.blob_iv,
    userId: USER_ID,
    existingEntry: BASE_EXISTING_ENTRY,
  };

  function lockedRow(row: Record<string, unknown>) {
    mockTxQueryRaw.mockResolvedValue([row]);
  }

  // History reads: the IV-reuse check selects itemKeyIv, the trim selects id.
  function historyRows(itemKeyIvs: (string | null)[]) {
    mockTeamPasswordEntryHistoryFindMany.mockImplementation(async (args: { select: Record<string, boolean> }) =>
      args.select.itemKeyIv
        ? itemKeyIvs.map((itemKeyIv) => ({ itemKeyIv }))
        : [{ id: "h-1" }],
    );
  }

  async function refusal(input: UpdateTeamPasswordInput) {
    const err = await updateTeamPassword(TEAM_ID, PASSWORD_ID, input).catch((e) => e);
    expect(err).toBeInstanceOf(TeamPasswordServiceError);
    expect(mockTeamPasswordEntryUpdate).not.toHaveBeenCalled();
    expect(mockTeamPasswordEntryHistoryCreate).not.toHaveBeenCalled();
    return err as TeamPasswordServiceError;
  }

  describe("the actor's role, re-read under the team lock", () => {
    beforeEach(() => {
      mockTeamLockRead.mockResolvedValue({ teamKeyVersion: 5 });
      mockTeamPasswordEntryHistoryCreate.mockResolvedValue({});
      historyRows([]);
      mockTeamPasswordEntryUpdate.mockResolvedValue({ id: PASSWORD_ID, tags: [] });
    });

    it.each([
      ["no longer an active member", null],
      ["demoted to VIEWER", { role: "VIEWER" }],
    ])("refuses a full update when the actor is %s (403 ACTOR_NOT_PERMITTED)", async (_label, membership) => {
      mockTeamMemberFindFirst.mockResolvedValue(membership);
      const err = await refusal(FULL_REUSE);
      expect(err.code).toBe(API_ERROR.ACTOR_NOT_PERMITTED);
      expect(err.statusHint).toBe(403);
      expect(mockTeamMemberFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { teamId: TEAM_ID, userId: USER_ID, deactivatedAt: null } }),
      );
    });

    it("refuses a MEMBER's full update of an entry another user created (403 ACTOR_NOT_PERMITTED)", async () => {
      mockTeamMemberFindFirst.mockResolvedValue({ role: "MEMBER" });
      lockedRow({ ...TEAM_CUR_ROW, created_by_id: "someone-else" });
      const err = await refusal(FULL_REUSE);
      expect(err.code).toBe(API_ERROR.ACTOR_NOT_PERMITTED);
    });

    it("control: a MEMBER updates their own entry", async () => {
      mockTeamMemberFindFirst.mockResolvedValue({ role: "MEMBER" });
      await updateTeamPassword(TEAM_ID, PASSWORD_ID, FULL_REUSE);
      expect(mockTeamPasswordEntryUpdate).toHaveBeenCalledOnce();
    });

    it("control: an ADMIN updates another user's entry", async () => {
      lockedRow({ ...TEAM_CUR_ROW, created_by_id: "someone-else" });
      await updateTeamPassword(TEAM_ID, PASSWORD_ID, FULL_REUSE);
      expect(mockTeamPasswordEntryUpdate).toHaveBeenCalledOnce();
    });
  });

  describe("ItemKey rules under the entry lock", () => {
    beforeEach(() => {
      mockTeamLockRead.mockResolvedValue({ teamKeyVersion: 5 });
      mockTeamPasswordEntryHistoryCreate.mockResolvedValue({});
      historyRows([]);
      mockTeamPasswordEntryUpdate.mockResolvedValue({ id: PASSWORD_ID, tags: [] });
    });

    it("reuses the locked ItemKey when itemKeyId matches (control): no new id, marker untouched", async () => {
      await updateTeamPassword(TEAM_ID, PASSWORD_ID, FULL_REUSE);

      const data = mockTeamPasswordEntryUpdate.mock.calls[0][0].data;
      expect(data.itemKeyVersion).toBe(2);
      expect(data).not.toHaveProperty("itemKeyId");
      expect(data).not.toHaveProperty("encryptedItemKey");
      expect(data).not.toHaveProperty("itemKeyTeamKeyVersion");
      expect(data).not.toHaveProperty("itemKeyVersionHighWater");
    });

    it("compares itemKeyId case-insensitively", async () => {
      await updateTeamPassword(TEAM_ID, PASSWORD_ID, { ...FULL_REUSE, itemKeyId: CUR_ITEM_KEY_ID.toUpperCase() });
      expect(mockTeamPasswordEntryUpdate).toHaveBeenCalledOnce();
    });

    it("refuses a full update whose itemKeyId is not the locked one (409 ITEM_KEY_CHANGED)", async () => {
      const err = await refusal({ ...FULL_REUSE, itemKeyId: "22222222-2222-4222-8222-222222222222" });
      expect(err.code).toBe(API_ERROR.ITEM_KEY_CHANGED);
      expect(err.statusHint).toBe(409);
    });

    it("refuses a full update that sends no itemKeyId (null never matches)", async () => {
      const err = await refusal({ ...FULL_REUSE, itemKeyId: undefined });
      expect(err.code).toBe(API_ERROR.ITEM_KEY_CHANGED);
    });

    it("refuses a reuse of an ItemKey wrapped under an older team key (409 ENTRY_REKEY_REQUIRED)", async () => {
      lockedRow({ ...TEAM_CUR_ROW, team_key_version: 4 });
      const err = await refusal(FULL_REUSE);
      expect(err.code).toBe(API_ERROR.ENTRY_REKEY_REQUIRED);
      expect(err.statusHint).toBe(409);
    });

    it("checks itemKeyId before the team key version (stale id on a stale entry → ITEM_KEY_CHANGED)", async () => {
      lockedRow({ ...TEAM_CUR_ROW, team_key_version: 4 });
      const err = await refusal({ ...FULL_REUSE, itemKeyId: "22222222-2222-4222-8222-222222222222" });
      expect(err.code).toBe(API_ERROR.ITEM_KEY_CHANGED);
    });

    it("treats an entry team key version below 1 as 1", async () => {
      mockTeamLockRead.mockResolvedValue({ teamKeyVersion: 1 });
      lockedRow({ ...TEAM_CUR_ROW, team_key_version: 0 });
      await updateTeamPassword(TEAM_ID, PASSWORD_ID, { ...FULL_REUSE, teamKeyVersion: 1 });
      expect(mockTeamPasswordEntryUpdate).toHaveBeenCalledOnce();
    });

    it("refuses an itemKeyVersion that is not the locked one when reusing (409 ITEM_KEY_VERSION_INVALID)", async () => {
      const err = await refusal({ ...FULL_REUSE, itemKeyVersion: 3 });
      expect(err.code).toBe(API_ERROR.ITEM_KEY_VERSION_INVALID);
    });

    it("refuses an itemKeyVersion below the locked one (400 ITEM_KEY_VERSION_DOWNGRADE)", async () => {
      const err = await refusal({ ...FULL_REUSE, itemKeyVersion: 0, itemKeyId: undefined });
      expect(err.code).toBe(API_ERROR.ITEM_KEY_VERSION_DOWNGRADE);
      expect(err.statusHint).toBe(400);
    });

    it("refuses a new wrap for an entry that already holds an ItemKey (409 ITEM_KEY_CHANGED)", async () => {
      const err = await refusal({ ...UPGRADE, itemKeyVersion: 3, snapshotBlobIv: TEAM_CUR_ROW.blob_iv });
      expect(err.code).toBe(API_ERROR.ITEM_KEY_CHANGED);
    });

    it("refuses a reuse on an entry a restore turned back to v0 (stale v1 client → ITEM_KEY_CHANGED)", async () => {
      lockedRow(TEAM_CUR_ROW_V0);
      const err = await refusal({ ...FULL_REUSE, itemKeyVersion: 2 });
      expect(err.code).toBe(API_ERROR.ITEM_KEY_CHANGED);
    });

    it("accepts a legacy v0 edit of a v0 entry without writing an ItemKey", async () => {
      lockedRow(TEAM_CUR_ROW_V0);
      await updateTeamPassword(TEAM_ID, PASSWORD_ID, { ...FULL_REUSE, itemKeyVersion: 0, itemKeyId: undefined });
      const data = mockTeamPasswordEntryUpdate.mock.calls[0][0].data;
      expect(data.itemKeyVersion).toBe(0);
      expect(data).not.toHaveProperty("itemKeyId");
    });

    describe("v0→v1 upgrade", () => {
      beforeEach(() => lockedRow(TEAM_CUR_ROW_V0));

      it("writes the new wrap, mints a fresh id and raises the high-water; the marker is left as it was", async () => {
        await updateTeamPassword(TEAM_ID, PASSWORD_ID, UPGRADE);

        const data = mockTeamPasswordEntryUpdate.mock.calls[0][0].data;
        expect(data).toMatchObject({
          itemKeyVersion: 2,
          encryptedItemKey: ENCRYPTED_ITEM_KEY.ciphertext,
          itemKeyIv: ENCRYPTED_ITEM_KEY.iv,
          itemKeyAuthTag: ENCRYPTED_ITEM_KEY.authTag,
          itemKeyVersionHighWater: 2,
        });
        expect(data.itemKeyId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(data).not.toHaveProperty("itemKeyTeamKeyVersion");
      });

      it("is exempt from the stale team key version rule (it wraps under the current key)", async () => {
        lockedRow({ ...TEAM_CUR_ROW_V0, team_key_version: 1 });
        await updateTeamPassword(TEAM_ID, PASSWORD_ID, UPGRADE);
        expect(mockTeamPasswordEntryUpdate).toHaveBeenCalledOnce();
      });

      it("refuses a version other than high-water + 1 (409 ITEM_KEY_VERSION_INVALID)", async () => {
        const err = await refusal({ ...UPGRADE, itemKeyVersion: 3 });
        expect(err.code).toBe(API_ERROR.ITEM_KEY_VERSION_INVALID);
        expect(err.statusHint).toBe(409);
      });

      it("refuses when the blob changed since the client read it (409 ITEM_KEY_CHANGED)", async () => {
        const err = await refusal({ ...UPGRADE, snapshotBlobIv: "f".repeat(24) });
        expect(err.code).toBe(API_ERROR.ITEM_KEY_CHANGED);
      });

      it("refuses a wrap IV a history row already used (400 ITEM_KEY_IV_REUSED)", async () => {
        historyRows([null, ENCRYPTED_ITEM_KEY.iv.toUpperCase()]);
        const err = await refusal(UPGRADE);
        expect(err.code).toBe(API_ERROR.ITEM_KEY_IV_REUSED);
        expect(err.statusHint).toBe(400);
        expect(mockTeamPasswordEntryHistoryFindMany).toHaveBeenCalledWith({
          where: { entryId: PASSWORD_ID },
          select: { itemKeyIv: true },
        });
      });

      it("accepts a wrap IV no history row used (control)", async () => {
        historyRows([null, "a".repeat(24)]);
        await updateTeamPassword(TEAM_ID, PASSWORD_ID, UPGRADE);
        expect(mockTeamPasswordEntryUpdate).toHaveBeenCalledOnce();
      });
    });

    it("copies the locked row's item_key_id into the history snapshot", async () => {
      await updateTeamPassword(TEAM_ID, PASSWORD_ID, FULL_REUSE);
      expect(mockTeamPasswordEntryHistoryCreate.mock.calls[0][0].data.itemKeyId).toBe(CUR_ITEM_KEY_ID);
    });

    it("runs no ItemKey check for a metadata-only update of a stale entry", async () => {
      lockedRow({ ...TEAM_CUR_ROW, team_key_version: 1 });
      await updateTeamPassword(TEAM_ID, PASSWORD_ID, {
        isArchived: true,
        userId: USER_ID,
        existingEntry: { ...BASE_EXISTING_ENTRY, itemKeyVersion: 2 },
      });
      expect(mockTxQueryRaw).not.toHaveBeenCalled();
      expect(mockTeamPasswordEntryUpdate).toHaveBeenCalledOnce();
    });
  });

  it("rejects tagIds from another team on update", async () => {
    mockTeamTagCount.mockResolvedValue(0); // none of the tagIds belong to this team

    const input: UpdateTeamPasswordInput = {
      tagIds: ["tag-other-team"],
      userId: USER_ID,
      existingEntry: BASE_EXISTING_ENTRY,
    };

    const err = await updateTeamPassword(TEAM_ID, PASSWORD_ID, input).catch((e) => e);

    expect(err).toBeInstanceOf(TeamPasswordServiceError);
    expect(err.code).toBe("NOT_FOUND");
    expect(err.statusHint).toBe(404);
    expect(mockTeamPasswordEntryUpdate).not.toHaveBeenCalled();
  });

  it("skips tagIds ownership check when tagIds is undefined on update", async () => {
    mockTeamPasswordEntryUpdate.mockResolvedValue({ id: PASSWORD_ID, tags: [] });

    const input: UpdateTeamPasswordInput = {
      isArchived: true,
      userId: USER_ID,
      existingEntry: BASE_EXISTING_ENTRY,
    };

    await updateTeamPassword(TEAM_ID, PASSWORD_ID, input);

    expect(mockTeamTagCount).not.toHaveBeenCalled();
  });

  it("skips tagIds ownership check when tagIds is empty array on update", async () => {
    mockTeamPasswordEntryUpdate.mockResolvedValue({ id: PASSWORD_ID, tags: [] });

    const input: UpdateTeamPasswordInput = {
      tagIds: [],
      userId: USER_ID,
      existingEntry: BASE_EXISTING_ENTRY,
    };

    await updateTeamPassword(TEAM_ID, PASSWORD_ID, input);

    expect(mockTeamTagCount).not.toHaveBeenCalled();
  });

  // C7: version metadata change without re-encryption
  it("rejects itemKeyVersion change without encryptedBlob → 409 KEY_VERSION_WITHOUT_REENCRYPT", async () => {
    const input: UpdateTeamPasswordInput = {
      // No encryptedBlob — metadata-only update
      itemKeyVersion: 1, // differs from existingEntry.itemKeyVersion (0)
      userId: USER_ID,
      existingEntry: { ...BASE_EXISTING_ENTRY, itemKeyVersion: 0 },
    };

    const err = await updateTeamPassword(TEAM_ID, PASSWORD_ID, input).catch((e) => e);
    expect(err).toBeInstanceOf(TeamPasswordServiceError);
    expect(err.code).toBe(API_ERROR.KEY_VERSION_WITHOUT_REENCRYPT);
    expect(err.statusHint).toBe(409);
  });

  it("rejects teamKeyVersion change without encryptedBlob → 409", async () => {
    const input: UpdateTeamPasswordInput = {
      // No encryptedBlob — metadata-only update
      teamKeyVersion: 5, // differs from existingEntry.teamKeyVersion (3)
      userId: USER_ID,
      existingEntry: BASE_EXISTING_ENTRY,
    };

    const err = await updateTeamPassword(TEAM_ID, PASSWORD_ID, input).catch((e) => e);
    expect(err).toBeInstanceOf(TeamPasswordServiceError);
    expect(err.code).toBe(API_ERROR.KEY_VERSION_WITHOUT_REENCRYPT);
    expect(err.statusHint).toBe(409);
  });

  it("rejects aadVersion change without encryptedBlob → 409", async () => {
    const input: UpdateTeamPasswordInput = {
      // No encryptedBlob — metadata-only update
      aadVersion: 1, // differs from existingEntry.aadVersion (1)… use 0 in existing to force mismatch
      userId: USER_ID,
      existingEntry: { ...BASE_EXISTING_ENTRY, aadVersion: 0 },
    };

    const err = await updateTeamPassword(TEAM_ID, PASSWORD_ID, input).catch((e) => e);
    expect(err).toBeInstanceOf(TeamPasswordServiceError);
    expect(err.code).toBe(API_ERROR.KEY_VERSION_WITHOUT_REENCRYPT);
    expect(err.statusHint).toBe(409);
  });

  it("allows same itemKeyVersion without encryptedBlob → no error", async () => {
    mockTeamPasswordEntryUpdate.mockResolvedValue({ id: PASSWORD_ID, tags: [] });

    const input: UpdateTeamPasswordInput = {
      // No encryptedBlob — metadata-only update; itemKeyVersion matches existing
      itemKeyVersion: 0, // same as existingEntry.itemKeyVersion (0)
      userId: USER_ID,
      existingEntry: BASE_EXISTING_ENTRY,
    };

    // Should not throw — same version is a no-op, not a change
    const result = await updateTeamPassword(TEAM_ID, PASSWORD_ID, input);
    expect(result).toEqual({ id: PASSWORD_ID, tags: [] });
  });

  // C1: FOR UPDATE snapshot source and SQL text guard
  it("C1: $queryRaw is called before History.create on full (blob-changing) update", async () => {
    mockTeamLockRead.mockResolvedValue({ teamKeyVersion: 5 });
    mockTeamPasswordEntryHistoryFindMany.mockResolvedValue([]);
    mockTeamPasswordEntryUpdate.mockResolvedValue({ id: PASSWORD_ID, tags: [] });

    const callOrder: string[] = [];
    mockTxQueryRaw.mockImplementation(() => {
      callOrder.push("$queryRaw");
      return Promise.resolve([TEAM_CUR_ROW]);
    });
    mockTeamPasswordEntryHistoryCreate.mockImplementation(() => {
      callOrder.push("historyCreate");
      return Promise.resolve({});
    });

    const input: UpdateTeamPasswordInput = {
      encryptedBlob: ENCRYPTED_BLOB,
      encryptedOverview: ENCRYPTED_OVERVIEW,
      aadVersion: 1,
      teamKeyVersion: 5,
      itemKeyVersion: 2,
      itemKeyId: CUR_ITEM_KEY_ID,
      userId: USER_ID,
      existingEntry: BASE_EXISTING_ENTRY,
    };

    await updateTeamPassword(TEAM_ID, PASSWORD_ID, input);

    expect(callOrder.indexOf("$queryRaw")).toBeLessThan(callOrder.indexOf("historyCreate"));
  });

  it("C1: FOR UPDATE SQL contains table name, team_id predicate, and required crypto columns", async () => {
    mockTeamLockRead.mockResolvedValue({ teamKeyVersion: 5 });
    mockTeamPasswordEntryHistoryCreate.mockResolvedValue({});
    mockTeamPasswordEntryHistoryFindMany.mockResolvedValue([]);
    mockTeamPasswordEntryUpdate.mockResolvedValue({ id: PASSWORD_ID, tags: [] });

    const input: UpdateTeamPasswordInput = {
      encryptedBlob: ENCRYPTED_BLOB,
      encryptedOverview: ENCRYPTED_OVERVIEW,
      aadVersion: 1,
      teamKeyVersion: 5,
      itemKeyVersion: 2,
      itemKeyId: CUR_ITEM_KEY_ID,
      userId: USER_ID,
      existingEntry: BASE_EXISTING_ENTRY,
    };

    await updateTeamPassword(TEAM_ID, PASSWORD_ID, input);

    expect(mockTxQueryRaw).toHaveBeenCalled();
    const [tpl] = mockTxQueryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    const sql = tpl.join("?");
    expect(sql).toMatch(/FOR UPDATE/i);
    expect(sql).toMatch(/team_password_entries/i);
    expect(sql).toMatch(/team_id/i);
    expect(sql).toMatch(/encrypted_blob/i);
    expect(sql).toMatch(/blob_iv/i);
    expect(sql).toMatch(/blob_auth_tag/i);
    expect(sql).toMatch(/aad_version/i);
    expect(sql).toMatch(/team_key_version/i);
    expect(sql).toMatch(/item_key_version/i);
    expect(sql).toMatch(/encrypted_item_key/i);
    expect(sql).toMatch(/item_key_iv/i);
    expect(sql).toMatch(/item_key_auth_tag/i);
    expect(sql).toMatch(/item_key_id/i);
    expect(sql).toMatch(/item_key_team_key_version/i);
    expect(sql).toMatch(/item_key_version_high_water/i);
  });

  it("C1: all 9 crypto fields in History.create come from $queryRaw result, not from existingEntry", async () => {
    mockTeamLockRead.mockResolvedValue({ teamKeyVersion: 5 });
    mockTeamPasswordEntryHistoryCreate.mockResolvedValue({});
    mockTeamPasswordEntryHistoryFindMany.mockResolvedValue([]);
    mockTeamPasswordEntryUpdate.mockResolvedValue({ id: PASSWORD_ID, tags: [] });

    const input: UpdateTeamPasswordInput = {
      encryptedBlob: ENCRYPTED_BLOB,
      encryptedOverview: ENCRYPTED_OVERVIEW,
      aadVersion: 1,
      teamKeyVersion: 5,
      itemKeyVersion: 2,
      itemKeyId: CUR_ITEM_KEY_ID,
      userId: USER_ID,
      existingEntry: BASE_EXISTING_ENTRY,
    };

    await updateTeamPassword(TEAM_ID, PASSWORD_ID, input);

    const histData = mockTeamPasswordEntryHistoryCreate.mock.calls[0][0].data;
    // All 9 crypto fields must come from TEAM_CUR_ROW (not BASE_EXISTING_ENTRY)
    expect(histData.encryptedBlob).toBe(TEAM_CUR_ROW.encrypted_blob);
    expect(histData.blobIv).toBe(TEAM_CUR_ROW.blob_iv);
    expect(histData.blobAuthTag).toBe(TEAM_CUR_ROW.blob_auth_tag);
    expect(histData.aadVersion).toBe(TEAM_CUR_ROW.aad_version);
    expect(histData.teamKeyVersion).toBe(TEAM_CUR_ROW.team_key_version);
    expect(histData.itemKeyVersion).toBe(TEAM_CUR_ROW.item_key_version);
    expect(histData.encryptedItemKey).toBe(TEAM_CUR_ROW.encrypted_item_key);
    expect(histData.itemKeyIv).toBe(TEAM_CUR_ROW.item_key_iv);
    expect(histData.itemKeyAuthTag).toBe(TEAM_CUR_ROW.item_key_auth_tag);
    // Distinct-from-existingEntry sanity check
    expect(histData.encryptedBlob).not.toBe(BASE_EXISTING_ENTRY.encryptedBlob);
    expect(histData.aadVersion).not.toBe(BASE_EXISTING_ENTRY.aadVersion);
    // changedById must be the current userId, NOT from cur
    expect(histData.changedById).toBe(USER_ID);
  });

  it("C1: metadata-only update issues no $queryRaw and no History.create", async () => {
    mockTeamPasswordEntryUpdate.mockResolvedValue({ id: PASSWORD_ID, tags: [] });

    const input: UpdateTeamPasswordInput = {
      isArchived: true,
      userId: USER_ID,
      existingEntry: BASE_EXISTING_ENTRY,
    };

    await updateTeamPassword(TEAM_ID, PASSWORD_ID, input);

    expect(mockTxQueryRaw).not.toHaveBeenCalled();
    expect(mockTeamPasswordEntryHistoryCreate).not.toHaveBeenCalled();
  });

  // F1: race — entry deleted between caller's read and FOR UPDATE lock
  it("F1: throws TeamPasswordServiceError (NOT_FOUND, 404) when $queryRaw FOR UPDATE returns empty (concurrent delete)", async () => {
    mockTeamLockRead.mockResolvedValue({ teamKeyVersion: 5 });
    mockTxQueryRaw.mockResolvedValue([]); // row gone by the time the lock fires

    const input: UpdateTeamPasswordInput = {
      encryptedBlob: ENCRYPTED_BLOB,
      encryptedOverview: ENCRYPTED_OVERVIEW,
      aadVersion: 1,
      teamKeyVersion: 5,
      itemKeyVersion: 2,
      itemKeyId: CUR_ITEM_KEY_ID,
      userId: USER_ID,
      existingEntry: BASE_EXISTING_ENTRY,
    };

    const err = await updateTeamPassword(TEAM_ID, PASSWORD_ID, input).catch((e) => e);
    expect(err).toBeInstanceOf(TeamPasswordServiceError);
    expect(err.code).toBe(API_ERROR.NOT_FOUND);
    expect(err.statusHint).toBe(404);
    // update must NOT have been called — the handler must abort before writing
    expect(mockTeamPasswordEntryUpdate).not.toHaveBeenCalled();
  });
});
