import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockTeamFindUnique,
  mockTeamFolderFindUnique,
  mockTeamPasswordEntryCreate,
  mockTeamPasswordEntryUpdate,
  mockTeamPasswordEntryHistoryCreate,
  mockTeamPasswordEntryHistoryFindMany,
  mockTeamPasswordEntryHistoryDeleteMany,
  mockTransaction,
} = vi.hoisted(() => {
  const mockTeamFindUnique = vi.fn();
  const mockTeamFolderFindUnique = vi.fn();
  const mockTeamPasswordEntryCreate = vi.fn();
  const mockTeamPasswordEntryUpdate = vi.fn();
  const mockTeamPasswordEntryHistoryCreate = vi.fn();
  const mockTeamPasswordEntryHistoryFindMany = vi.fn();
  const mockTeamPasswordEntryHistoryDeleteMany = vi.fn();

  const txClient = {
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
    mockTeamPasswordEntryCreate,
    mockTeamPasswordEntryUpdate,
    mockTeamPasswordEntryHistoryCreate,
    mockTeamPasswordEntryHistoryFindMany,
    mockTeamPasswordEntryHistoryDeleteMany,
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

const TEAM_ID = "team-1";
const PASSWORD_ID = "entry-1";
const USER_ID = "user-1";
const TENANT_ID = "tenant-1";
const FOLDER_ID = "folder-1";

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
    expect(err.code).toBe("FOLDER_NOT_FOUND");
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
    expect(err.code).toBe("FOLDER_NOT_FOUND");
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
});

// ---------------------------------------------------------------------------
// updateTeamPassword
// ---------------------------------------------------------------------------

describe("updateTeamPassword", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Re-apply the transaction implementation after reset
    mockTransaction.mockImplementation(async (fn) =>
      fn({
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
    expect(err.code).toBe("FOLDER_NOT_FOUND");
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
    expect(err.code).toBe("FOLDER_NOT_FOUND");
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
    expect(historyData.encryptedBlob).toBe(BASE_EXISTING_ENTRY.encryptedBlob);
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
    expect(err.code).toBe("ITEM_KEY_REQUIRED");
    expect(err.statusHint).toBe(400);
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
});
