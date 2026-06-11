import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockTeamFindUnique,
  mockTeamFolderFindUnique,
  mockTeamTagCount,
  mockTeamPasswordEntryCreate,
  mockTeamPasswordEntryUpdate,
  mockTeamPasswordEntryHistoryCreate,
  mockTeamPasswordEntryHistoryFindMany,
  mockTeamPasswordEntryHistoryDeleteMany,
  mockTxQueryRaw,
  mockTransaction,
} = vi.hoisted(() => {
  const mockTeamFindUnique = vi.fn();
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
  };
  const mockTxQueryRaw = vi.fn().mockResolvedValue([teamCurRow]);

  const txClient = {
    $queryRaw: mockTxQueryRaw,
    teamPasswordEntryHistory: {
      create: mockTeamPasswordEntryHistoryCreate,
      findMany: mockTeamPasswordEntryHistoryFindMany,
      deleteMany: mockTeamPasswordEntryHistoryDeleteMany,
    },
    teamPasswordEntry: {
      update: mockTeamPasswordEntryUpdate,
    },
  };

  const mockTransaction = vi.fn(async (fn: (tx: typeof txClient) => Promise<unknown>) =>
    fn(txClient),
  );

  return {
    mockTeamFindUnique,
    mockTeamFolderFindUnique,
    mockTeamTagCount,
    mockTeamPasswordEntryCreate,
    mockTeamPasswordEntryUpdate,
    mockTeamPasswordEntryHistoryCreate,
    mockTeamPasswordEntryHistoryFindMany,
    mockTeamPasswordEntryHistoryDeleteMany,
    mockTxQueryRaw,
    mockTransaction,
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    team: {
      findUnique: mockTeamFindUnique,
    },
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
    mockTeamFindUnique.mockResolvedValue(DEFAULT_TEAM);
    mockTeamFolderFindUnique.mockResolvedValue(DEFAULT_FOLDER);
    const created = { id: "entry-1", tags: [] };
    mockTeamPasswordEntryCreate.mockResolvedValue(created);

    const result = await createTeamPassword(TEAM_ID, {
      ...BASE_CREATE_INPUT,
      teamFolderId: FOLDER_ID,
    });

    expect(result).toBe(created);
    expect(mockTeamFindUnique).toHaveBeenCalledOnce();
    expect(mockTeamFolderFindUnique).toHaveBeenCalledOnce();
    expect(mockTeamPasswordEntryCreate).toHaveBeenCalledOnce();
  });

  it("creates entry successfully when no folderId is provided", async () => {
    mockTeamFindUnique.mockResolvedValue(DEFAULT_TEAM);
    const created = { id: "entry-1", tags: [] };
    mockTeamPasswordEntryCreate.mockResolvedValue(created);

    const result = await createTeamPassword(TEAM_ID, BASE_CREATE_INPUT);

    expect(result).toBe(created);
    expect(mockTeamFindUnique).toHaveBeenCalledOnce();
    // Folder query must not happen when no folderId given
    expect(mockTeamFolderFindUnique).not.toHaveBeenCalled();
    expect(mockTeamPasswordEntryCreate).toHaveBeenCalledOnce();
  });

  it("throws TeamPasswordServiceError (TEAM_KEY_VERSION_MISMATCH) when team is not found", async () => {
    mockTeamFindUnique.mockResolvedValue(null);

    await expect(
      createTeamPassword(TEAM_ID, BASE_CREATE_INPUT),
    ).rejects.toThrow(TeamPasswordServiceError);

    const err = await createTeamPassword(TEAM_ID, BASE_CREATE_INPUT).catch((e) => e);
    expect(err).toBeInstanceOf(TeamPasswordServiceError);
    expect(err.code).toBe("TEAM_KEY_VERSION_MISMATCH");
    expect(err.statusHint).toBe(409);
  });

  it("throws TeamPasswordServiceError (TEAM_KEY_VERSION_MISMATCH) when teamKeyVersion does not match", async () => {
    mockTeamFindUnique.mockResolvedValue({ ...DEFAULT_TEAM, teamKeyVersion: 99 });

    const err = await createTeamPassword(TEAM_ID, BASE_CREATE_INPUT).catch((e) => e);
    expect(err).toBeInstanceOf(TeamPasswordServiceError);
    expect(err.code).toBe("TEAM_KEY_VERSION_MISMATCH");
  });

  it("throws TeamPasswordServiceError (FOLDER_NOT_FOUND) when folder does not exist", async () => {
    mockTeamFindUnique.mockResolvedValue(DEFAULT_TEAM);
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
    mockTeamFindUnique.mockResolvedValue(DEFAULT_TEAM);
    mockTeamFolderFindUnique.mockResolvedValue({ teamId: "other-team" });

    const err = await createTeamPassword(TEAM_ID, {
      ...BASE_CREATE_INPUT,
      teamFolderId: FOLDER_ID,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(TeamPasswordServiceError);
    expect(err.code).toBe(API_ERROR.FOLDER_NOT_FOUND);
  });

  it("calls both team and folder queries (confirms parallel fetch)", async () => {
    mockTeamFindUnique.mockResolvedValue(DEFAULT_TEAM);
    mockTeamFolderFindUnique.mockResolvedValue(DEFAULT_FOLDER);
    mockTeamPasswordEntryCreate.mockResolvedValue({ id: "entry-1", tags: [] });

    await createTeamPassword(TEAM_ID, {
      ...BASE_CREATE_INPUT,
      teamFolderId: FOLDER_ID,
    });

    expect(mockTeamFindUnique).toHaveBeenCalledWith({
      where: { id: TEAM_ID },
      select: { teamKeyVersion: true, tenantId: true },
    });
    expect(mockTeamFolderFindUnique).toHaveBeenCalledWith({
      where: { id: FOLDER_ID },
      select: { teamId: true },
    });
  });

  it("uses client-provided id when given", async () => {
    const clientId = "client-uuid-abc";
    mockTeamFindUnique.mockResolvedValue(DEFAULT_TEAM);
    mockTeamPasswordEntryCreate.mockResolvedValue({ id: clientId, tags: [] });

    await createTeamPassword(TEAM_ID, { ...BASE_CREATE_INPUT, id: clientId });

    const createCall = mockTeamPasswordEntryCreate.mock.calls[0][0];
    expect(createCall.data.id).toBe(clientId);
  });

  it("creates entry with UUID v4 teamId and entryId", async () => {
    mockTeamFindUnique.mockResolvedValue(DEFAULT_TEAM);
    const created = { id: PASSWORD_ID_UUID, tags: [] };
    mockTeamPasswordEntryCreate.mockResolvedValue(created);

    const result = await createTeamPassword(TEAM_ID_UUID, {
      ...BASE_CREATE_INPUT,
      id: PASSWORD_ID_UUID,
    });

    expect(result).toBe(created);
    const createCall = mockTeamPasswordEntryCreate.mock.calls[0][0];
    expect(createCall.data.id).toBe(PASSWORD_ID_UUID);
    expect(mockTeamFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: TEAM_ID_UUID } })
    );
  });

  it("accepts tagIds that belong to the same team", async () => {
    mockTeamFindUnique.mockResolvedValue(DEFAULT_TEAM);
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
    mockTeamFindUnique.mockResolvedValue(DEFAULT_TEAM);
    const created = { id: "entry-1", tags: [] };
    mockTeamPasswordEntryCreate.mockResolvedValue(created);

    await createTeamPassword(TEAM_ID, { ...BASE_CREATE_INPUT, tagIds: [] });

    expect(mockTeamTagCount).not.toHaveBeenCalled();
  });

  it("accepts undefined tagIds without calling teamTag.count", async () => {
    mockTeamFindUnique.mockResolvedValue(DEFAULT_TEAM);
    const created = { id: "entry-1", tags: [] };
    mockTeamPasswordEntryCreate.mockResolvedValue(created);

    await createTeamPassword(TEAM_ID, BASE_CREATE_INPUT);

    expect(mockTeamTagCount).not.toHaveBeenCalled();
  });

  it("rejects tagIds from another team in same tenant on create", async () => {
    mockTeamFindUnique.mockResolvedValue(DEFAULT_TEAM);
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
    mockTeamFindUnique.mockResolvedValue(DEFAULT_TEAM);
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
};

describe("updateTeamPassword", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Re-apply $queryRaw and transaction implementation after reset
    mockTxQueryRaw.mockResolvedValue([TEAM_CUR_ROW]);
    mockTransaction.mockImplementation(async (fn) =>
      fn({
        $queryRaw: mockTxQueryRaw,
        teamPasswordEntryHistory: {
          create: mockTeamPasswordEntryHistoryCreate,
          findMany: mockTeamPasswordEntryHistoryFindMany,
          deleteMany: mockTeamPasswordEntryHistoryDeleteMany,
        },
        teamPasswordEntry: {
          update: mockTeamPasswordEntryUpdate,
        },
      }),
    );
  });

  it("updates entry with full payload (team version check + folder validation)", async () => {
    mockTeamFindUnique.mockResolvedValue({ teamKeyVersion: 3 });
    mockTeamFolderFindUnique.mockResolvedValue(DEFAULT_FOLDER);
    mockTeamPasswordEntryHistoryCreate.mockResolvedValue({});
    mockTeamPasswordEntryHistoryFindMany.mockResolvedValue([{ id: "h-1" }]);
    const updated = { id: PASSWORD_ID, tags: [] };
    mockTeamPasswordEntryUpdate.mockResolvedValue(updated);

    const input: UpdateTeamPasswordInput = {
      encryptedBlob: ENCRYPTED_BLOB,
      encryptedOverview: ENCRYPTED_OVERVIEW,
      aadVersion: 1,
      teamKeyVersion: 3,
      itemKeyVersion: 0,
      teamFolderId: FOLDER_ID,
      userId: USER_ID,
      existingEntry: BASE_EXISTING_ENTRY,
    };

    const result = await updateTeamPassword(TEAM_ID, PASSWORD_ID, input);

    expect(result).toBe(updated);
    expect(mockTeamFindUnique).toHaveBeenCalledOnce();
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
    expect(mockTeamFindUnique).not.toHaveBeenCalled();
    expect(mockTeamFolderFindUnique).toHaveBeenCalledOnce();
    // No history snapshot for metadata-only updates
    expect(mockTeamPasswordEntryHistoryCreate).not.toHaveBeenCalled();
    expect(mockTeamPasswordEntryUpdate).toHaveBeenCalledOnce();
  });

  it("throws TeamPasswordServiceError (TEAM_KEY_VERSION_MISMATCH) when team version differs", async () => {
    mockTeamFindUnique.mockResolvedValue({ teamKeyVersion: 99 });

    const input: UpdateTeamPasswordInput = {
      encryptedBlob: ENCRYPTED_BLOB,
      encryptedOverview: ENCRYPTED_OVERVIEW,
      aadVersion: 1,
      teamKeyVersion: 3,
      itemKeyVersion: 0,
      userId: USER_ID,
      existingEntry: BASE_EXISTING_ENTRY,
    };

    const err = await updateTeamPassword(TEAM_ID, PASSWORD_ID, input).catch((e) => e);
    expect(err).toBeInstanceOf(TeamPasswordServiceError);
    expect(err.code).toBe("TEAM_KEY_VERSION_MISMATCH");
    expect(err.statusHint).toBe(409);
  });

  it("throws TeamPasswordServiceError (TEAM_KEY_VERSION_MISMATCH) when team is not found during full update", async () => {
    mockTeamFindUnique.mockResolvedValue(null);

    const input: UpdateTeamPasswordInput = {
      encryptedBlob: ENCRYPTED_BLOB,
      encryptedOverview: ENCRYPTED_OVERVIEW,
      aadVersion: 1,
      teamKeyVersion: 3,
      itemKeyVersion: 0,
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
    mockTeamFindUnique.mockResolvedValue({ teamKeyVersion: 3 });
    mockTeamPasswordEntryHistoryCreate.mockResolvedValue({});
    mockTeamPasswordEntryHistoryFindMany.mockResolvedValue([{ id: "h-1" }]);
    mockTeamPasswordEntryUpdate.mockResolvedValue({ id: PASSWORD_ID, tags: [] });

    const input: UpdateTeamPasswordInput = {
      encryptedBlob: ENCRYPTED_BLOB,
      encryptedOverview: ENCRYPTED_OVERVIEW,
      aadVersion: 1,
      teamKeyVersion: 3,
      itemKeyVersion: 0,
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
    mockTeamFindUnique.mockResolvedValue({ teamKeyVersion: 3 });
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
      teamKeyVersion: 3,
      itemKeyVersion: 0,
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

  it("calls both team and folder queries in parallel during full update with folder", async () => {
    mockTeamFindUnique.mockResolvedValue({ teamKeyVersion: 3 });
    mockTeamFolderFindUnique.mockResolvedValue(DEFAULT_FOLDER);
    mockTeamPasswordEntryHistoryCreate.mockResolvedValue({});
    mockTeamPasswordEntryHistoryFindMany.mockResolvedValue([{ id: "h-1" }]);
    mockTeamPasswordEntryUpdate.mockResolvedValue({ id: PASSWORD_ID, tags: [] });

    const input: UpdateTeamPasswordInput = {
      encryptedBlob: ENCRYPTED_BLOB,
      encryptedOverview: ENCRYPTED_OVERVIEW,
      aadVersion: 1,
      teamKeyVersion: 3,
      itemKeyVersion: 0,
      teamFolderId: FOLDER_ID,
      userId: USER_ID,
      existingEntry: BASE_EXISTING_ENTRY,
    };

    await updateTeamPassword(TEAM_ID, PASSWORD_ID, input);

    expect(mockTeamFindUnique).toHaveBeenCalledWith({
      where: { id: TEAM_ID },
      select: { teamKeyVersion: true },
    });
    expect(mockTeamFolderFindUnique).toHaveBeenCalledWith({
      where: { id: FOLDER_ID },
      select: { teamId: true },
    });
  });

  it("throws TeamPasswordServiceError (ITEM_KEY_VERSION_DOWNGRADE) when itemKeyVersion decreases", async () => {
    const input: UpdateTeamPasswordInput = {
      encryptedBlob: ENCRYPTED_BLOB,
      encryptedOverview: ENCRYPTED_OVERVIEW,
      aadVersion: 1,
      teamKeyVersion: 3,
      itemKeyVersion: 0, // downgrading from v1 to v0
      userId: USER_ID,
      existingEntry: { ...BASE_EXISTING_ENTRY, itemKeyVersion: 1 },
    };

    const err = await updateTeamPassword(TEAM_ID, PASSWORD_ID, input).catch((e) => e);
    expect(err).toBeInstanceOf(TeamPasswordServiceError);
    expect(err.code).toBe("ITEM_KEY_VERSION_DOWNGRADE");
    expect(err.statusHint).toBe(400);
  });

  it("throws TeamPasswordServiceError (ITEM_KEY_REQUIRED) when upgrading v0→v1 without encryptedItemKey", async () => {
    const input: UpdateTeamPasswordInput = {
      encryptedBlob: ENCRYPTED_BLOB,
      encryptedOverview: ENCRYPTED_OVERVIEW,
      aadVersion: 1,
      teamKeyVersion: 3,
      itemKeyVersion: 1, // upgrading from v0 to v1
      // no encryptedItemKey provided
      userId: USER_ID,
      existingEntry: { ...BASE_EXISTING_ENTRY, itemKeyVersion: 0 },
    };

    const err = await updateTeamPassword(TEAM_ID, PASSWORD_ID, input).catch((e) => e);
    expect(err).toBeInstanceOf(TeamPasswordServiceError);
    expect(err.code).toBe(API_ERROR.ITEM_KEY_REQUIRED);
    expect(err.statusHint).toBe(400);
  });

  it("throws ITEM_KEY_REQUIRED when teamKeyVersion changes with itemKeyVersion>=1 but no encryptedItemKey (re-wrap required)", async () => {
    // buildItemKeyWrapAAD binds the wrapped item key to teamKeyVersion. When
    // teamKeyVersion rotates from 3 → 4 and the entry holds an item key
    // (itemKeyVersion=1), the wrapped key MUST be re-wrapped with the new
    // team key — otherwise the AAD no longer matches and the entry breaks.
    const input: UpdateTeamPasswordInput = {
      encryptedBlob: ENCRYPTED_BLOB,
      encryptedOverview: ENCRYPTED_OVERVIEW,
      aadVersion: 1,
      teamKeyVersion: 4, // rotated from existing 3
      itemKeyVersion: 1, // unchanged from existing
      // encryptedItemKey deliberately absent
      userId: USER_ID,
      existingEntry: { ...BASE_EXISTING_ENTRY, teamKeyVersion: 3, itemKeyVersion: 1 },
    };
    mockTeamFindUnique.mockResolvedValue({ teamKeyVersion: 4 });

    const err = await updateTeamPassword(TEAM_ID, PASSWORD_ID, input).catch((e) => e);
    expect(err).toBeInstanceOf(TeamPasswordServiceError);
    expect(err.code).toBe(API_ERROR.ITEM_KEY_REQUIRED);
    expect(err.statusHint).toBe(400);
    expect(mockTeamPasswordEntryUpdate).not.toHaveBeenCalled();
  });

  it("succeeds when teamKeyVersion change is paired with new encryptedItemKey re-wrap", async () => {
    mockTeamFindUnique.mockResolvedValue({ teamKeyVersion: 4 });
    mockTeamPasswordEntryHistoryCreate.mockResolvedValue({});
    mockTeamPasswordEntryHistoryFindMany.mockResolvedValue([{ id: "h-1" }]);
    const updated = { id: PASSWORD_ID, tags: [] };
    mockTeamPasswordEntryUpdate.mockResolvedValue(updated);

    const input: UpdateTeamPasswordInput = {
      encryptedBlob: ENCRYPTED_BLOB,
      encryptedOverview: ENCRYPTED_OVERVIEW,
      aadVersion: 1,
      teamKeyVersion: 4,
      itemKeyVersion: 1,
      encryptedItemKey: ENCRYPTED_ITEM_KEY, // re-wrap supplied
      userId: USER_ID,
      existingEntry: { ...BASE_EXISTING_ENTRY, teamKeyVersion: 3, itemKeyVersion: 1 },
    };

    const result = await updateTeamPassword(TEAM_ID, PASSWORD_ID, input);
    expect(result).toBe(updated);
    expect(mockTeamPasswordEntryUpdate).toHaveBeenCalledOnce();
  });

  it("succeeds when upgrading v0→v1 and encryptedItemKey is provided", async () => {
    mockTeamFindUnique.mockResolvedValue({ teamKeyVersion: 3 });
    mockTeamPasswordEntryHistoryCreate.mockResolvedValue({});
    mockTeamPasswordEntryHistoryFindMany.mockResolvedValue([{ id: "h-1" }]);
    const updated = { id: PASSWORD_ID, tags: [] };
    mockTeamPasswordEntryUpdate.mockResolvedValue(updated);

    const input: UpdateTeamPasswordInput = {
      encryptedBlob: ENCRYPTED_BLOB,
      encryptedOverview: ENCRYPTED_OVERVIEW,
      aadVersion: 1,
      teamKeyVersion: 3,
      itemKeyVersion: 1,
      encryptedItemKey: ENCRYPTED_ITEM_KEY,
      userId: USER_ID,
      existingEntry: { ...BASE_EXISTING_ENTRY, itemKeyVersion: 0 },
    };

    const result = await updateTeamPassword(TEAM_ID, PASSWORD_ID, input);
    expect(result).toBe(updated);
    expect(mockTeamPasswordEntryUpdate).toHaveBeenCalledOnce();
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
    mockTeamFindUnique.mockResolvedValue({ teamKeyVersion: 3 });
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
      teamKeyVersion: 3,
      itemKeyVersion: 0,
      userId: USER_ID,
      existingEntry: BASE_EXISTING_ENTRY,
    };

    await updateTeamPassword(TEAM_ID, PASSWORD_ID, input);

    expect(callOrder.indexOf("$queryRaw")).toBeLessThan(callOrder.indexOf("historyCreate"));
  });

  it("C1: FOR UPDATE SQL contains table name, team_id predicate, and required crypto columns", async () => {
    mockTeamFindUnique.mockResolvedValue({ teamKeyVersion: 3 });
    mockTeamPasswordEntryHistoryCreate.mockResolvedValue({});
    mockTeamPasswordEntryHistoryFindMany.mockResolvedValue([]);
    mockTeamPasswordEntryUpdate.mockResolvedValue({ id: PASSWORD_ID, tags: [] });

    const input: UpdateTeamPasswordInput = {
      encryptedBlob: ENCRYPTED_BLOB,
      encryptedOverview: ENCRYPTED_OVERVIEW,
      aadVersion: 1,
      teamKeyVersion: 3,
      itemKeyVersion: 0,
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
  });

  it("C1: all 9 crypto fields in History.create come from $queryRaw result, not from existingEntry", async () => {
    mockTeamFindUnique.mockResolvedValue({ teamKeyVersion: 3 });
    mockTeamPasswordEntryHistoryCreate.mockResolvedValue({});
    mockTeamPasswordEntryHistoryFindMany.mockResolvedValue([]);
    mockTeamPasswordEntryUpdate.mockResolvedValue({ id: PASSWORD_ID, tags: [] });

    const input: UpdateTeamPasswordInput = {
      encryptedBlob: ENCRYPTED_BLOB,
      encryptedOverview: ENCRYPTED_OVERVIEW,
      aadVersion: 1,
      teamKeyVersion: 3,
      itemKeyVersion: 0,
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
    mockTeamFindUnique.mockResolvedValue({ teamKeyVersion: 3 });
    mockTxQueryRaw.mockResolvedValue([]); // row gone by the time the lock fires

    const input: UpdateTeamPasswordInput = {
      encryptedBlob: ENCRYPTED_BLOB,
      encryptedOverview: ENCRYPTED_OVERVIEW,
      aadVersion: 1,
      teamKeyVersion: 3,
      itemKeyVersion: 0,
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
