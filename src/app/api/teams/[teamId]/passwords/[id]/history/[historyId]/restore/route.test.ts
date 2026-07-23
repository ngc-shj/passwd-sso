import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams, parseResponse } from "@/__tests__/helpers/request-builder";
import { DEFAULT_SESSION } from "@/__tests__/helpers/mock-auth";

const {
  mockAuth,
  mockRequireTeamPermission,
  mockEntryFindUnique,
  mockHistoryFindUnique,
  mockTransaction,
  mockLogAudit,
  mockWithTeamTenantRls,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTeamPermission: vi.fn(),
  mockEntryFindUnique: vi.fn(),
  mockHistoryFindUnique: vi.fn(),
  mockTransaction: vi.fn(),
  mockLogAudit: vi.fn(),
  mockWithTeamTenantRls: vi.fn(async (_teamId: string, fn: () => unknown) => fn()),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/auth/access/team-auth", () => {
  class TeamAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "TeamAuthError";
      this.status = status;
    }
  }
  return { requireTeamPermission: mockRequireTeamPermission, TeamAuthError };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamPasswordEntry: { findUnique: mockEntryFindUnique },
    teamPasswordEntryHistory: { findUnique: mockHistoryFindUnique },
    $transaction: mockTransaction,
  },
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "Test" }),
  teamAuditBase: vi.fn((_, userId, teamId) => ({ scope: "TEAM", userId, teamId })),
}));
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: mockWithTeamTenantRls,
}));

import { POST } from "./route";
import { TeamAuthError } from "@/lib/auth/access/team-auth";

const TEAM_ID = "team-1";
const ENTRY_ID = "entry-1";
const HISTORY_ID = "hist-1";

function makeParams() {
  return createParams({ teamId: TEAM_ID, id: ENTRY_ID, historyId: HISTORY_ID });
}

const baseEntry = {
  teamId: TEAM_ID,
  tenantId: "tenant-1",
  encryptedBlob: "cur",
  blobIv: "curIv",
  blobAuthTag: "curTag",
  aadVersion: 1,
  teamKeyVersion: 3,
  itemKeyVersion: 2,
  encryptedItemKey: "curItemKey",
  itemKeyIv: "curItemKeyIv",
  itemKeyAuthTag: "curItemKeyTag",
};

const baseHistory = {
  id: HISTORY_ID,
  entryId: ENTRY_ID,
  encryptedBlob: "old",
  blobIv: "oldIv",
  blobAuthTag: "oldTag",
  aadVersion: 0,
  teamKeyVersion: 2,
  itemKeyVersion: 1,
  encryptedItemKey: "oldItemKey",
  itemKeyIv: "oldItemKeyIv",
  itemKeyAuthTag: "oldItemKeyTag",
  changedAt: new Date("2025-01-01"),
};

describe("POST /api/teams/[teamId]/passwords/[id]/history/[historyId]/restore", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(createRequest("POST"), makeParams());
    const { status, json } = await parseResponse(res);
    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 403 when lacking team permission", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("FORBIDDEN", 403));
    const res = await POST(createRequest("POST"), makeParams());
    const { status } = await parseResponse(res);
    expect(status).toBe(403);
  });

  it("returns 404 when entry not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(null);
    const res = await POST(createRequest("POST"), makeParams());
    const { status, json } = await parseResponse(res);
    expect(status).toBe(404);
    expect(json.error).toBe("NOT_FOUND");
  });

  it("returns 404 when entry belongs to different team", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue({ ...baseEntry, teamId: "other-team" });
    const res = await POST(createRequest("POST"), makeParams());
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it("returns 404 when history not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(baseEntry);
    mockHistoryFindUnique.mockResolvedValue(null);
    const res = await POST(createRequest("POST"), makeParams());
    const { status, json } = await parseResponse(res);
    expect(status).toBe(404);
    expect(json.error).toBe("HISTORY_NOT_FOUND");
  });

  it("returns 404 when history belongs to different entry", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(baseEntry);
    mockHistoryFindUnique.mockResolvedValue({ ...baseHistory, entryId: "other-entry" });
    const res = await POST(createRequest("POST"), makeParams());
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  // The FOR UPDATE row deliberately differs from the outside-tx `baseEntry`
  // read on EVERY snapshot-relevant field. The snapshot MUST source from this
  // locked row: a concurrent PUT committing between the pre-check read and
  // the transaction would otherwise have its content silently lost (restore
  // overwrites it while the stale pre-PUT content lands in the snapshot).
  const lockedRow = {
    encrypted_blob: "locked",
    blob_iv: "lockedIv",
    blob_auth_tag: "lockedTag",
    aad_version: 1,
    team_key_version: 4,
    item_key_version: 3,
    encrypted_item_key: "lockedItemKey",
    item_key_iv: "lockedItemKeyIv",
    item_key_auth_tag: "lockedItemKeyTag",
  };

  it("restores history version: creates snapshot + updates entry in a transaction", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(baseEntry);
    mockHistoryFindUnique.mockResolvedValue(baseHistory);

    const txQueryRaw = vi.fn().mockResolvedValue([lockedRow]);
    const txHistoryCreate = vi.fn();
    const txHistoryFindMany = vi.fn().mockResolvedValue([]);
    const txHistoryDeleteMany = vi.fn();
    const txEntryUpdate = vi.fn();

    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        $queryRaw: txQueryRaw,
        teamPasswordEntryHistory: {
          create: txHistoryCreate,
          findMany: txHistoryFindMany,
          deleteMany: txHistoryDeleteMany,
        },
        teamPasswordEntry: { update: txEntryUpdate },
      }),
    );

    const res = await POST(createRequest("POST"), makeParams());
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockTransaction).toHaveBeenCalled();
    expect(txQueryRaw).toHaveBeenCalledTimes(1);
    // Pre-restore snapshot must capture the row-LOCKED entry's fields
    // (sourced from the in-tx FOR UPDATE read, NOT the outside-tx
    // `baseEntry` — which deliberately differs here on every field). If
    // this assertion sees baseEntry values, the TOCTOU race is back.
    expect(txHistoryCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entryId: ENTRY_ID,
          encryptedBlob: lockedRow.encrypted_blob,
          teamKeyVersion: lockedRow.team_key_version,
          itemKeyVersion: lockedRow.item_key_version,
          encryptedItemKey: lockedRow.encrypted_item_key,
          itemKeyIv: lockedRow.item_key_iv,
          itemKeyAuthTag: lockedRow.item_key_auth_tag,
        }),
      }),
    );
    // Restore write-back must carry the HISTORY row's ItemKey metadata
    // (sourced from `history`, not `entry`) alongside its teamKeyVersion —
    // otherwise the restored entry's teamKeyVersion (old) and its
    // encryptedItemKey (still current-wrapped) go out of sync and the
    // version-aware client fails to unwrap (the bug this test guards).
    expect(txEntryUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ENTRY_ID, teamId: TEAM_ID },
        data: expect.objectContaining({
          encryptedBlob: baseHistory.encryptedBlob,
          teamKeyVersion: baseHistory.teamKeyVersion,
          itemKeyVersion: baseHistory.itemKeyVersion,
          encryptedItemKey: baseHistory.encryptedItemKey,
          itemKeyIv: baseHistory.itemKeyIv,
          itemKeyAuthTag: baseHistory.itemKeyAuthTag,
        }),
      }),
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ENTRY_HISTORY_RESTORE",
        targetId: ENTRY_ID,
        metadata: expect.objectContaining({ historyId: HISTORY_ID }),
      }),
    );
  });

  it("returns 404 when the entry is deleted between the pre-check and the row lock", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(baseEntry);
    mockHistoryFindUnique.mockResolvedValue(baseHistory);

    const txHistoryCreate = vi.fn();
    const txEntryUpdate = vi.fn();
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        $queryRaw: vi.fn().mockResolvedValue([]),
        teamPasswordEntryHistory: { create: txHistoryCreate },
        teamPasswordEntry: { update: txEntryUpdate },
      }),
    );

    const res = await POST(createRequest("POST"), makeParams());
    const { status } = await parseResponse(res);

    expect(status).toBe(404);
    expect(txHistoryCreate).not.toHaveBeenCalled();
    expect(txEntryUpdate).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});
