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
vi.mock("@/lib/auth/access/team-auth", async (importOriginal) => {
  class TeamAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "TeamAuthError";
      this.status = status;
    }
  }
  const actual = await importOriginal<typeof import("@/lib/auth/access/team-auth")>();
  // The real permission table and role read: the holder predicate and the
  // in-lock actor re-check use them.
  return {
    requireTeamPermission: mockRequireTeamPermission,
    hasTeamPermission: actual.hasTeamPermission,
    activeTeamRole: actual.activeTeamRole,
    canWriteTeamEntry: actual.canWriteTeamEntry,
    TeamAuthError,
  };
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
const LIVE_ITEM_KEY_ID = "11111111-1111-4111-8111-111111111111";
const ROW_ITEM_KEY_ID = "22222222-2222-4222-8222-222222222222";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const ROW_BLOB_IV = "c".repeat(24);
const OVERVIEW = { ciphertext: "restored-overview", iv: "a".repeat(24), authTag: "b".repeat(32) };

function makeParams() {
  return createParams({ teamId: TEAM_ID, id: ENTRY_ID, historyId: HISTORY_ID });
}

function restoreRequest(body: unknown = { encryptedOverview: OVERVIEW, snapshotBlobIv: ROW_BLOB_IV }) {
  return createRequest("POST", "http://localhost/api/teams/team-1/passwords/entry-1/history/hist-1/restore", { body });
}

const baseEntry = {
  teamId: TEAM_ID,
  tenantId: "tenant-1",
  createdById: DEFAULT_SESSION.user.id,
};

const baseHistory = {
  id: HISTORY_ID,
  entryId: ENTRY_ID,
  encryptedBlob: "old",
  blobIv: ROW_BLOB_IV,
  blobAuthTag: "oldTag",
  aadVersion: 0,
  teamKeyVersion: 2,
  itemKeyVersion: 1,
  encryptedItemKey: "oldItemKey",
  itemKeyIv: "oldItemKeyIv",
  itemKeyAuthTag: "oldItemKeyTag",
  itemKeyId: ROW_ITEM_KEY_ID,
  changedAt: new Date("2025-01-01"),
};

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
  item_key_id: LIVE_ITEM_KEY_ID,
  item_key_team_key_version: 4,
  item_key_version_high_water: 3,
  created_by_id: DEFAULT_SESSION.user.id,
};

type TxOptions = {
  team?: { team_key_version: number; tenant_id: string } | null;
  entry?: Record<string, unknown> | null;
  history?: Record<string, unknown> | null;
  holderKeys?: { userId: string }[];
  holderMembers?: { userId: string; role: string }[];
  /** The actor's membership re-read under the team lock (null: gone). */
  actor?: { role: string } | null;
};

function setupTx(options: TxOptions = {}) {
  const calls: string[] = [];
  const team = "team" in options ? options.team : { team_key_version: 4, tenant_id: "tenant-1" };
  const entry = "entry" in options ? options.entry : lockedRow;
  const history = "history" in options ? options.history : baseHistory;
  const tx = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      if (sql.includes("current_setting('lock_timeout')")) return [{ lock_timeout: "0", statement_timeout: "0" }];
      if (/FROM teams\b/.test(sql)) {
        calls.push("teamLock");
        return team ? [team] : [];
      }
      calls.push("entryLock");
      return entry ? [entry] : [];
    }),
    $executeRaw: vi.fn(),
    teamPasswordEntryHistory: {
      findUnique: vi.fn(async () => {
        calls.push("historyRead");
        return history;
      }),
      create: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn(),
    },
    teamMemberKey: { findMany: vi.fn().mockResolvedValue(options.holderKeys ?? [{ userId: "holder-1" }]) },
    teamMember: {
      findMany: vi.fn().mockResolvedValue(options.holderMembers ?? [{ userId: "holder-1", role: "MEMBER" }]),
      findFirst: vi.fn(async () => {
        calls.push("actorRole");
        return "actor" in options ? options.actor : { role: "MEMBER" };
      }),
    },
    teamPasswordEntry: { update: vi.fn() },
  };
  mockTransaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(tx));
  return { tx, calls };
}

function preChecksPass() {
  mockAuth.mockResolvedValue(DEFAULT_SESSION);
  mockRequireTeamPermission.mockResolvedValue({ role: "MEMBER" });
  mockEntryFindUnique.mockResolvedValue(baseEntry);
  mockHistoryFindUnique.mockResolvedValue({ entryId: ENTRY_ID });
}

describe("POST /api/teams/[teamId]/passwords/[id]/history/[historyId]/restore", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(restoreRequest(), makeParams());
    const { status, json } = await parseResponse(res);
    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 403 when lacking team permission", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("FORBIDDEN", 403));
    const res = await POST(restoreRequest(), makeParams());
    const { status } = await parseResponse(res);
    expect(status).toBe(403);
  });

  it("returns 404 when entry not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue({ role: "MEMBER" });
    mockEntryFindUnique.mockResolvedValue(null);
    const res = await POST(restoreRequest(), makeParams());
    const { status, json } = await parseResponse(res);
    expect(status).toBe(404);
    expect(json.error).toBe("NOT_FOUND");
  });

  it("returns 404 when entry belongs to different team", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue({ role: "MEMBER" });
    mockEntryFindUnique.mockResolvedValue({ ...baseEntry, teamId: "other-team" });
    const res = await POST(restoreRequest(), makeParams());
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it("returns 404 when history not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue({ role: "MEMBER" });
    mockEntryFindUnique.mockResolvedValue(baseEntry);
    mockHistoryFindUnique.mockResolvedValue(null);
    const res = await POST(restoreRequest(), makeParams());
    const { status, json } = await parseResponse(res);
    expect(status).toBe(404);
    expect(json.error).toBe("HISTORY_NOT_FOUND");
  });

  it("returns 404 when history belongs to different entry", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue({ role: "MEMBER" });
    mockEntryFindUnique.mockResolvedValue(baseEntry);
    mockHistoryFindUnique.mockResolvedValue({ entryId: "other-entry" });
    const res = await POST(restoreRequest(), makeParams());
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it("returns 400 without the re-encrypted overview, before any transaction", async () => {
    preChecksPass();
    const { tx } = setupTx();
    const res = await POST(restoreRequest({}), makeParams());
    expect(res.status).toBe(400);
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(tx.teamPasswordEntry.update).not.toHaveBeenCalled();
  });

  it("restores history version: creates snapshot + updates entry in a transaction", async () => {
    preChecksPass();
    const { tx, calls } = setupTx();

    const res = await POST(restoreRequest(), makeParams());
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    // Lock order: team FOR SHARE, then the entry FOR UPDATE, then the history re-read.
    expect(calls).toEqual(["teamLock", "actorRole", "entryLock", "historyRead"]);
    const teamSql = (tx.$queryRaw.mock.calls as unknown as [TemplateStringsArray][])
      .map(([s]) => s.join("?"))
      .find((sql) => /FROM teams\b/.test(sql));
    expect(teamSql).toMatch(/FOR SHARE/);
    // Pre-restore snapshot must capture the row-LOCKED entry's fields
    // (sourced from the in-tx FOR UPDATE read). If this assertion sees
    // other values, the TOCTOU race is back.
    expect(tx.teamPasswordEntryHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entryId: ENTRY_ID,
          encryptedBlob: lockedRow.encrypted_blob,
          teamKeyVersion: lockedRow.team_key_version,
          itemKeyVersion: lockedRow.item_key_version,
          encryptedItemKey: lockedRow.encrypted_item_key,
          itemKeyIv: lockedRow.item_key_iv,
          itemKeyAuthTag: lockedRow.item_key_auth_tag,
          itemKeyId: lockedRow.item_key_id,
        }),
      }),
    );
    // Restore write-back must carry the HISTORY row's ItemKey metadata
    // (sourced from the in-tx history read) alongside its teamKeyVersion —
    // otherwise the restored entry's teamKeyVersion (old) and its
    // encryptedItemKey (still current-wrapped) go out of sync and the
    // version-aware client fails to unwrap.
    expect(tx.teamPasswordEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ENTRY_ID, teamId: TEAM_ID },
        data: expect.objectContaining({
          encryptedBlob: baseHistory.encryptedBlob,
          teamKeyVersion: baseHistory.teamKeyVersion,
          itemKeyVersion: baseHistory.itemKeyVersion,
          encryptedItemKey: baseHistory.encryptedItemKey,
          itemKeyIv: baseHistory.itemKeyIv,
          itemKeyAuthTag: baseHistory.itemKeyAuthTag,
          // The client's overview, re-encrypted under the restored row's key.
          encryptedOverview: OVERVIEW.ciphertext,
          overviewIv: OVERVIEW.iv,
          overviewAuthTag: OVERVIEW.authTag,
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
    preChecksPass();
    const { tx } = setupTx({ entry: null });

    const res = await POST(restoreRequest(), makeParams());
    const { status } = await parseResponse(res);

    expect(status).toBe(404);
    expect(tx.teamPasswordEntryHistory.create).not.toHaveBeenCalled();
    expect(tx.teamPasswordEntry.update).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it.each([
    ["no longer an active member", null],
    ["demoted to VIEWER", { role: "VIEWER" }],
  ])("returns 403 ACTOR_NOT_PERMITTED when the actor is %s under the team lock, writing nothing", async (_label, actor) => {
    preChecksPass();
    const { tx, calls } = setupTx({ actor });

    const res = await POST(restoreRequest(), makeParams());
    const { status, json } = await parseResponse(res);

    expect(status).toBe(403);
    expect(json.error).toBe("ACTOR_NOT_PERMITTED");
    expect(calls).toEqual(["teamLock", "actorRole"]);
    expect(tx.teamPasswordEntryHistory.create).not.toHaveBeenCalled();
    expect(tx.teamPasswordEntry.update).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  describe("HISTORY_ROW_CHANGED: the row the client decrypted (snapshotBlobIv)", () => {
    it("refuses 409 when the locked row's blobIv differs (a re-key rewrote it), writing nothing", async () => {
      preChecksPass();
      const { tx } = setupTx({ history: { ...baseHistory, blobIv: "d".repeat(24) } });

      const res = await POST(restoreRequest(), makeParams());
      const { status, json } = await parseResponse(res);

      expect(status).toBe(409);
      expect(json.error).toBe("HISTORY_ROW_CHANGED");
      expect(tx.teamPasswordEntryHistory.create).not.toHaveBeenCalled();
      expect(tx.teamPasswordEntry.update).not.toHaveBeenCalled();
      expect(mockLogAudit).not.toHaveBeenCalled();
    });

    it("control: the same blobIv in another case → 200", async () => {
      preChecksPass();
      const { tx } = setupTx();

      const res = await POST(
        restoreRequest({ encryptedOverview: OVERVIEW, snapshotBlobIv: ROW_BLOB_IV.toUpperCase() }),
        makeParams(),
      );

      expect(res.status).toBe(200);
      expect(tx.teamPasswordEntry.update).toHaveBeenCalledTimes(1);
    });

    it("rejects a body without snapshotBlobIv (400, no transaction)", async () => {
      preChecksPass();
      setupTx();
      const res = await POST(restoreRequest({ encryptedOverview: OVERVIEW }), makeParams());
      expect(res.status).toBe(400);
      expect(mockTransaction).not.toHaveBeenCalled();
    });
  });

  describe("own-entry rule (MEMBER restores only an entry they created)", () => {
    it("refuses a MEMBER on another member's entry before the transaction (403 ONLY_OWN_ENTRIES)", async () => {
      preChecksPass();
      mockEntryFindUnique.mockResolvedValue({ ...baseEntry, createdById: "someone-else" });
      setupTx();

      const res = await POST(restoreRequest(), makeParams());
      const { status, json } = await parseResponse(res);

      expect(status).toBe(403);
      expect(json.error).toBe("ONLY_OWN_ENTRIES");
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it("refuses under the lock when the locked row's creator is another member (403 ACTOR_NOT_PERMITTED), writing nothing", async () => {
      preChecksPass();
      const { tx } = setupTx({ entry: { ...lockedRow, created_by_id: "someone-else" } });

      const res = await POST(restoreRequest(), makeParams());
      const { status, json } = await parseResponse(res);

      expect(status).toBe(403);
      expect(json.error).toBe("ACTOR_NOT_PERMITTED");
      expect(tx.teamPasswordEntryHistory.create).not.toHaveBeenCalled();
      expect(tx.teamPasswordEntry.update).not.toHaveBeenCalled();
    });

    it("control: a MEMBER restores their own entry → 200", async () => {
      preChecksPass();
      const { tx } = setupTx();
      const res = await POST(restoreRequest(), makeParams());
      expect(res.status).toBe(200);
      expect(tx.teamPasswordEntry.update).toHaveBeenCalledTimes(1);
    });

    it("control: an ADMIN restores another member's entry → 200", async () => {
      preChecksPass();
      mockRequireTeamPermission.mockResolvedValue({ role: "ADMIN" });
      mockEntryFindUnique.mockResolvedValue({ ...baseEntry, createdById: "someone-else" });
      const { tx } = setupTx({ entry: { ...lockedRow, created_by_id: "someone-else" }, actor: { role: "ADMIN" } });

      const res = await POST(restoreRequest(), makeParams());
      expect(res.status).toBe(200);
      expect(tx.teamPasswordEntry.update).toHaveBeenCalledTimes(1);
    });
  });

  it("returns HISTORY_NOT_FOUND when the row is gone by the time the entry is locked", async () => {
    preChecksPass();
    const { tx } = setupTx({ history: null });

    const res = await POST(restoreRequest(), makeParams());
    const { status, json } = await parseResponse(res);

    expect(status).toBe(404);
    expect(json.error).toBe("HISTORY_NOT_FOUND");
    expect(tx.teamPasswordEntry.update).not.toHaveBeenCalled();
  });

  describe("holder of the row's team key version (plan C1)", () => {
    it("refuses a row no active member holds a key for (409 HISTORY_KEY_UNAVAILABLE)", async () => {
      preChecksPass();
      const { tx } = setupTx({ holderKeys: [] });

      const res = await POST(restoreRequest(), makeParams());
      const { status, json } = await parseResponse(res);

      expect(status).toBe(409);
      expect(json.error).toBe("HISTORY_KEY_UNAVAILABLE");
      expect(tx.teamPasswordEntryHistory.create).not.toHaveBeenCalled();
      expect(tx.teamPasswordEntry.update).not.toHaveBeenCalled();
      expect(mockLogAudit).not.toHaveBeenCalled();
    });

    it("refuses when the only key holder's membership is deactivated", async () => {
      preChecksPass();
      const { tx } = setupTx({ holderKeys: [{ userId: "departed" }], holderMembers: [] });

      const res = await POST(restoreRequest(), makeParams());
      expect(res.status).toBe(409);
      expect(tx.teamMember.findMany).toHaveBeenCalledWith({
        where: { teamId: TEAM_ID, userId: { in: ["departed"] }, deactivatedAt: null },
        select: { userId: true, role: true },
      });
    });

    it("accepts a row an active member holds (control) and looks the holder up at the row's normalised version", async () => {
      preChecksPass();
      const { tx } = setupTx({ history: { ...baseHistory, teamKeyVersion: 0 } });

      const res = await POST(restoreRequest(), makeParams());
      expect(res.status).toBe(200);
      expect(tx.teamMemberKey.findMany).toHaveBeenCalledWith({
        where: { teamId: TEAM_ID, keyVersion: 1 },
        select: { userId: true },
      });
    });
  });

  describe("ItemKey identity and re-key marker (plan C1)", () => {
    async function restoredData(history: Record<string, unknown>, entry: Record<string, unknown> = lockedRow) {
      preChecksPass();
      const { tx } = setupTx({ history, entry });
      const res = await POST(restoreRequest(), makeParams());
      expect(res.status).toBe(200);
      return tx.teamPasswordEntry.update.mock.calls[0][0].data;
    }

    it("keeps the marker and the id when the row holds the live ItemKey", async () => {
      const data = await restoredData({ ...baseHistory, itemKeyId: LIVE_ITEM_KEY_ID });
      expect(data.itemKeyId).toBe(LIVE_ITEM_KEY_ID);
      expect(data.itemKeyTeamKeyVersion).toBe(lockedRow.item_key_team_key_version);
    });

    it("copies the row's id and resets the marker for another ItemKey", async () => {
      const data = await restoredData(baseHistory);
      expect(data.itemKeyId).toBe(ROW_ITEM_KEY_ID);
      expect(data.itemKeyTeamKeyVersion).toBe(0);
    });

    it("mints a fresh id (marker 0) for a v1+ row of unknown identity", async () => {
      const data = await restoredData({ ...baseHistory, itemKeyId: null });
      expect(data.itemKeyId).toMatch(UUID_V4);
      expect(data.itemKeyId).not.toBe(LIVE_ITEM_KEY_ID);
      expect(data.itemKeyTeamKeyVersion).toBe(0);
    });

    it("never treats two unknown ids as the same ItemKey", async () => {
      const data = await restoredData({ ...baseHistory, itemKeyId: null }, { ...lockedRow, item_key_id: null });
      expect(data.itemKeyTeamKeyVersion).toBe(0);
      expect(data.itemKeyId).toMatch(UUID_V4);
    });

    it("leaves the id NULL for a v0 row (marker 0)", async () => {
      const data = await restoredData({
        ...baseHistory,
        itemKeyVersion: 0,
        encryptedItemKey: null,
        itemKeyIv: null,
        itemKeyAuthTag: null,
        itemKeyId: null,
      });
      expect(data.itemKeyId).toBeNull();
      expect(data.itemKeyTeamKeyVersion).toBe(0);
    });

    it("raises the high-water to the row's itemKeyVersion and never lowers it", async () => {
      const raised = await restoredData({ ...baseHistory, itemKeyVersion: 7 });
      expect(raised.itemKeyVersionHighWater).toBe(7);
      vi.clearAllMocks();
      const kept = await restoredData({ ...baseHistory, itemKeyVersion: 1 });
      expect(kept.itemKeyVersionHighWater).toBe(lockedRow.item_key_version_high_water);
    });
  });
});
