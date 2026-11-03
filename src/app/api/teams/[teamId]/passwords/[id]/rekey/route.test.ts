import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockAuth,
  mockRequireTeamPermission,
  MockTeamAuthError,
  mockWithTeamTenantRls,
  mockRequireRecentSession,
  mockRekeyCheck,
  mockReadCheck,
  mockLockTeamKeyVersion,
  mockPostcheck,
  mockLogAuditInTx,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTeamPermission: vi.fn(),
  MockTeamAuthError: class MockTeamAuthError extends Error {
    status: number;
    constructor(message: string, status = 403) {
      super(message);
      this.name = "TeamAuthError";
      this.status = status;
    }
  },
  mockWithTeamTenantRls: vi.fn(),
  mockRequireRecentSession: vi.fn(),
  mockRekeyCheck: vi.fn(),
  mockReadCheck: vi.fn(),
  mockLockTeamKeyVersion: vi.fn(),
  mockPostcheck: vi.fn(),
  mockLogAuditInTx: vi.fn(),
}));

// One client stands in for both the pre-check context and the re-key
// transaction. `$queryRaw` answers the three row-lock reads by their table.
const txMock = {
  $queryRaw: vi.fn(),
  team: { findUnique: vi.fn() },
  teamMember: { findFirst: vi.fn() },
  teamPasswordEntry: { findUnique: vi.fn(), update: vi.fn() },
  teamPasswordEntryHistory: { findMany: vi.fn(), updateMany: vi.fn() },
  attachment: { count: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
};

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/auth/access/team-auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/access/team-auth")>("@/lib/auth/access/team-auth");
  return {
    requireTeamPermission: mockRequireTeamPermission,
    // The real role read and permission table: the route re-checks the actor under its locks.
    activeTeamRole: actual.activeTeamRole,
    hasTeamPermission: actual.hasTeamPermission,
    TeamAuthError: MockTeamAuthError,
  };
});
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: mockWithTeamTenantRls,
}));
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: mockRequireRecentSession,
}));
vi.mock("@/lib/security/rate-limiters", () => ({
  teamEntryRekeyLimiter: { check: mockRekeyCheck, clear: vi.fn() },
  teamRekeyReadLimiter: { check: mockReadCheck, clear: vi.fn() },
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditInTx: mockLogAuditInTx,
  teamAuditBase: vi.fn((_req, userId, teamId) => ({ scope: "TEAM", userId, teamId })),
}));
// The team lock is raw SQL; exercised against a real DB in
// team-entry-rekey.integration.test.ts.
vi.mock("@/lib/team/team-key-rotation-lock", async () => ({
  ...(await vi.importActual<typeof import("@/lib/team/team-key-rotation-lock")>("@/lib/team/team-key-rotation-lock")),
  lockTeamKeyVersion: mockLockTeamKeyVersion,
}));
// The post-check re-reads rows; it is red-proved on real rows in
// team-entry-rekey.integration.test.ts.
vi.mock("@/lib/team/rekey-consistency", async () => ({
  ...(await vi.importActual<typeof import("@/lib/team/rekey-consistency")>("@/lib/team/rekey-consistency")),
  assertEntryRekeyConsistent: mockPostcheck,
}));
vi.mock("@/lib/http/with-request-log", () => ({
  withRequestLog: (fn: (...args: unknown[]) => unknown) => fn,
}));

import { GET, POST } from "./route";
import { TeamRotationInProgressError } from "@/lib/team/team-key-rotation-lock";
import { REKEY_INCONSISTENCY, RekeyConsistencyError } from "@/lib/team/rekey-consistency";
import { REKEY_HISTORY_MAX } from "@/lib/validations/common";
import { METADATA_MAX_BYTES } from "@/lib/validations/common.server";

const TEAM = "11111111-1111-4111-8111-111111111111";
const ENTRY = "22222222-2222-4222-8222-222222222222";
const H1 = "33333333-3333-4333-8333-333333333331";
const H2 = "33333333-3333-4333-8333-333333333332";
const H_RETAINED = "33333333-3333-4333-8333-333333333333";
const ATT = "44444444-4444-4444-8444-444444444444";

const iv = (c: string) => c.repeat(24);
const tag = (c: string) => c.repeat(32);
const field = (c: string) => ({ ciphertext: c.repeat(40), iv: iv(c), authTag: tag(c) });

// The locked entry: v1 ItemKey created at team key 1, team now at 2, high-water 3.
const LOCKED = {
  blob_iv: iv("a"),
  overview_iv: iv("b"),
  item_key_iv: iv("c"),
  item_key_version: 1,
  item_key_team_key_version: 1,
  item_key_version_high_water: 3,
};
const LOCKED_HISTORY = [
  { id: H1, team_key_version: 1, item_key_version: 1 },
  { id: H2, team_key_version: 1, item_key_version: 1 },
  { id: H_RETAINED, team_key_version: 0, item_key_version: 0 },
];
const LOCKED_ATTACHMENTS = [{ id: ATT, encryption_mode: 2 }];

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    teamKeyVersion: 2,
    snapshot: { blobIv: iv("a"), overviewIv: iv("b"), itemKeyIv: iv("c"), itemKeyVersion: 1 },
    newItemKeyVersion: 4,
    encryptedItemKey: field("d"),
    encryptedBlob: field("e"),
    encryptedOverview: field("f"),
    aadVersion: 1,
    history: [
      { id: H1, snapshotBlobIv: iv("1"), encryptedBlob: field("2") },
      { id: H2, snapshotBlobIv: iv("3"), encryptedBlob: field("4") },
    ],
    retainHistoryIds: [H_RETAINED],
    attachmentCekRewraps: [
      { id: ATT, snapshotCekIv: iv("5"), cekEncrypted: Buffer.alloc(48, 1).toString("base64"), cekIv: iv("6"), cekAuthTag: tag("7") },
    ],
    ...overrides,
  };
}

function request(method: string, body?: unknown) {
  return new NextRequest(`http://localhost/api/teams/${TEAM}/passwords/${ENTRY}/rekey`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
}

const ctx = () => ({ params: Promise.resolve({ teamId: TEAM, id: ENTRY }) });

async function rekey(body: unknown = validBody()) {
  const res = await POST(request("POST", body), ctx());
  return { res, json: await res.json() };
}

function sqlOf(strings: TemplateStringsArray) {
  return strings.join("?");
}

let lockedEntry: typeof LOCKED | undefined;
let lockedHistory: typeof LOCKED_HISTORY;
let lockedAttachments: { id: string; encryption_mode: number }[];

describe("POST /api/teams/[teamId]/passwords/[id]/rekey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lockedEntry = { ...LOCKED };
    lockedHistory = LOCKED_HISTORY.map((h) => ({ ...h }));
    lockedAttachments = LOCKED_ATTACHMENTS.map((a) => ({ ...a }));
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockRequireRecentSession.mockResolvedValue(null);
    mockRekeyCheck.mockResolvedValue({ allowed: true });
    mockWithTeamTenantRls.mockImplementation(
      async (_teamId: string, fn: (tenantId: string, tx: typeof txMock) => unknown) => fn("tenant-1", txMock),
    );
    // Pre-check context.
    txMock.teamPasswordEntry.findUnique.mockResolvedValue({ teamId: TEAM, itemKeyVersion: 1, itemKeyTeamKeyVersion: 1 });
    txMock.team.findUnique.mockResolvedValue({ teamKeyVersion: 2 });
    txMock.attachment.count.mockResolvedValue(0);
    // Transaction.
    mockLockTeamKeyVersion.mockResolvedValue({ teamKeyVersion: 2, tenantId: "tenant-1" });
    txMock.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = sqlOf(strings);
      if (sql.includes("FROM team_password_entry_histories")) return lockedHistory;
      if (sql.includes("FROM attachments")) return lockedAttachments;
      if (sql.includes("FROM team_password_entries")) return lockedEntry ? [lockedEntry] : [];
      throw new Error(`unexpected SQL: ${sql}`);
    });
    txMock.teamMember.findFirst.mockResolvedValue({ role: "ADMIN" });
    // Wrap IVs on record: the entry's own (shared by H1/H2) and the retained row's.
    txMock.teamPasswordEntryHistory.findMany.mockResolvedValue([
      { itemKeyIv: iv("c") },
      { itemKeyIv: iv("c") },
      { itemKeyIv: iv("9") },
    ]);
    txMock.teamPasswordEntryHistory.updateMany.mockResolvedValue({ count: 1 });
    txMock.attachment.updateMany.mockResolvedValue({ count: 1 });
    txMock.teamPasswordEntry.update.mockResolvedValue({});
    mockPostcheck.mockResolvedValue(undefined);
    mockLogAuditInTx.mockResolvedValue(undefined);
  });

  // ── Gates ────────────────────────────────────────────────────────────────

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const { res } = await rekey();
    expect(res.status).toBe(401);
  });

  it("requires TEAM_UPDATE", async () => {
    mockRequireTeamPermission.mockRejectedValue(new MockTeamAuthError("FORBIDDEN", 403));
    const { res, json } = await rekey();
    expect(res.status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
    expect(mockRequireTeamPermission).toHaveBeenCalledWith("user-1", TEAM, "team:update", expect.anything());
  });

  it("returns the step-up refusal before the rate limit and any read", async () => {
    mockRequireRecentSession.mockResolvedValue(
      new Response(JSON.stringify({ error: "SESSION_STEP_UP_REQUIRED" }), { status: 403 }),
    );
    const { res, json } = await rekey();
    expect(res.status).toBe(403);
    expect(json.error).toBe("SESSION_STEP_UP_REQUIRED");
    expect(mockRekeyCheck).not.toHaveBeenCalled();
    expect(mockWithTeamTenantRls).not.toHaveBeenCalled();
  });

  it("rate-limits per (team, user)", async () => {
    mockRekeyCheck.mockResolvedValue({ allowed: false, retryAfterMs: 5000 });
    const { res } = await rekey();
    expect(res.status).toBe(429);
    expect(mockRekeyCheck).toHaveBeenCalledWith(`rl:team_entry_rekey:${TEAM}:user-1`);
    expect(mockWithTeamTenantRls).not.toHaveBeenCalled();
  });

  it.each([
    ["an entry of another team", { teamId: "other-team", itemKeyVersion: 1, itemKeyTeamKeyVersion: 1 }],
    ["an entry invisible under RLS", null],
  ])("returns 404 for %s", async (_label, entry) => {
    txMock.teamPasswordEntry.findUnique.mockResolvedValue(entry);
    const { res } = await rekey();
    expect(res.status).toBe(404);
    expect(mockLockTeamKeyVersion).not.toHaveBeenCalled();
  });

  // ── Refusals that need no body ───────────────────────────────────────────

  it.each([
    ["REKEY_NOT_PENDING for an entry already at the current team key", { itemKeyTeamKeyVersion: 2 }, 0, "REKEY_NOT_PENDING"],
    ["ENTRY_UPGRADE_REQUIRED for a v0 entry", { itemKeyVersion: 0 }, 0, "ENTRY_UPGRADE_REQUIRED"],
    ["REKEY_ATTACHMENTS_UNMIGRATED for an entry holding a legacy attachment", {}, 1, "REKEY_ATTACHMENTS_UNMIGRATED"],
  ])("409 %s, without reading the body", async (_label, entryChange, legacy, code) => {
    txMock.teamPasswordEntry.findUnique.mockResolvedValue({
      teamId: TEAM, itemKeyVersion: 1, itemKeyTeamKeyVersion: 1, ...entryChange,
    });
    txMock.attachment.count.mockResolvedValue(legacy);
    // An unparseable body: refusing first proves the body was not read.
    const res = await POST(
      new NextRequest(`http://localhost/api/teams/${TEAM}/passwords/${ENTRY}/rekey`, { method: "POST", body: "{not json" }),
      ctx(),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(code);
    expect(mockLockTeamKeyVersion).not.toHaveBeenCalled();
  });

  // ── Validation ───────────────────────────────────────────────────────────

  it.each([
    ["an unknown field", { extra: 1 }],
    ["a history id both re-keyed and retained", { retainHistoryIds: [H1, H_RETAINED] }],
    ["a history id re-keyed twice (case-insensitively)", {
      history: [
        { id: H1, snapshotBlobIv: iv("1"), encryptedBlob: field("2") },
        { id: H1.toUpperCase(), snapshotBlobIv: iv("1"), encryptedBlob: field("2") },
      ],
    }],
    ["a duplicate attachment id", {
      attachmentCekRewraps: [
        { id: ATT, snapshotCekIv: iv("5"), cekEncrypted: "AAAA", cekIv: iv("6"), cekAuthTag: tag("7") },
        { id: ATT, snapshotCekIv: iv("5"), cekEncrypted: "AAAA", cekIv: iv("6"), cekAuthTag: tag("7") },
      ],
    }],
    ["more history rows than REKEY_HISTORY_MAX in total", {
      retainHistoryIds: Array.from({ length: REKEY_HISTORY_MAX - 1 }, (_, i) => `55555555-5555-4555-8555-${String(i).padStart(12, "0")}`),
    }],
    ["an aadVersion other than the current one", { aadVersion: 0 }],
    ["a non-base64 CEK wrap", {
      attachmentCekRewraps: [{ id: ATT, snapshotCekIv: iv("5"), cekEncrypted: "!!!!", cekIv: iv("6"), cekAuthTag: tag("7") }],
    }],
    ["a malformed snapshot iv", { snapshot: { blobIv: "x", overviewIv: iv("b"), itemKeyIv: iv("c"), itemKeyVersion: 1 } }],
  ])("returns 400 for %s, before any lock", async (_label, change) => {
    const { res } = await rekey(validBody(change));
    expect(res.status).toBe(400);
    expect(mockLockTeamKeyVersion).not.toHaveBeenCalled();
  });

  // ── Success ──────────────────────────────────────────────────────────────

  it("re-keys under a server-minted ItemKey id, leaves retained rows alone, post-checks and audits in the transaction", async () => {
    const { res, json } = await rekey();
    expect(res.status).toBe(200);
    expect(json).toEqual({ success: true, itemKeyVersion: 4 });

    const entryWrite = txMock.teamPasswordEntry.update.mock.calls[0][0];
    const newId = entryWrite.data.itemKeyId;
    expect(newId).toMatch(/^[0-9a-f-]{36}$/);
    expect(entryWrite).toEqual({
      where: { id: ENTRY, teamId: TEAM },
      data: {
        encryptedBlob: "e".repeat(40), blobIv: iv("e"), blobAuthTag: tag("e"),
        encryptedOverview: "f".repeat(40), overviewIv: iv("f"), overviewAuthTag: tag("f"),
        aadVersion: 1,
        teamKeyVersion: 2,
        itemKeyVersion: 4,
        encryptedItemKey: "d".repeat(40), itemKeyIv: iv("d"), itemKeyAuthTag: tag("d"),
        itemKeyId: newId,
        itemKeyTeamKeyVersion: 2,
        itemKeyVersionHighWater: 4,
      },
    });

    // Non-retained history rows: CAS on the snapshot blobIv, the entry's new wrap and id.
    expect(txMock.teamPasswordEntryHistory.updateMany).toHaveBeenCalledTimes(2);
    expect(txMock.teamPasswordEntryHistory.updateMany).toHaveBeenCalledWith({
      where: { id: H1, entryId: ENTRY, blobIv: iv("1") },
      data: {
        encryptedBlob: "2".repeat(40), blobIv: iv("2"), blobAuthTag: tag("2"),
        aadVersion: 1,
        teamKeyVersion: 2,
        itemKeyVersion: 4,
        encryptedItemKey: "d".repeat(40), itemKeyIv: iv("d"), itemKeyAuthTag: tag("d"),
        itemKeyId: newId,
      },
    });
    const historyTargets = txMock.teamPasswordEntryHistory.updateMany.mock.calls.map((c) => c[0].where.id);
    expect(historyTargets).not.toContain(H_RETAINED);

    expect(txMock.attachment.updateMany).toHaveBeenCalledWith({
      where: { id: ATT, teamPasswordEntryId: ENTRY, encryptionMode: 2, cekIv: iv("5") },
      data: {
        cekEncrypted: Buffer.alloc(48, 1),
        cekIv: iv("6"),
        cekAuthTag: tag("7"),
        cekKeyVersion: 4,
        cekWrapAadVersion: 1,
        keyVersion: 2,
        cekItemKeyId: newId,
      },
    });

    expect(mockPostcheck).toHaveBeenCalledWith(txMock, ENTRY, [H_RETAINED]);
    expect(mockPostcheck.mock.invocationCallOrder[0]).toBeGreaterThan(
      txMock.teamPasswordEntry.update.mock.invocationCallOrder[0],
    );
    expect(mockLogAuditInTx).toHaveBeenCalledWith(
      txMock,
      "tenant-1",
      expect.objectContaining({
        action: "TEAM_ENTRY_REKEY",
        targetType: "TeamPasswordEntry",
        targetId: ENTRY,
        metadata: {
          fromItemKeyVersion: 1,
          toItemKeyVersion: 4,
          fromTeamKeyVersion: 1,
          toTeamKeyVersion: 2,
          retained: [{ id: H_RETAINED, teamKeyVersion: 0, itemKeyVersion: 0 }],
        },
      }),
    );
    expect(mockLogAuditInTx.mock.invocationCallOrder[0]).toBeGreaterThan(mockPostcheck.mock.invocationCallOrder[0]);
  });

  it("takes the team lock, then the entry, then its history and attachment rows FOR UPDATE", async () => {
    await rekey();
    const sqls = txMock.$queryRaw.mock.calls.map((c) => sqlOf(c[0]));
    expect(sqls).toHaveLength(3);
    expect(sqls[0]).toMatch(/FROM team_password_entries[\s\S]*FOR UPDATE/);
    expect(sqls[1]).toMatch(/FROM team_password_entry_histories[\s\S]*FOR UPDATE/);
    expect(sqls[2]).toMatch(/FROM attachments[\s\S]*FOR UPDATE/);
    expect(mockLockTeamKeyVersion.mock.invocationCallOrder[0]).toBeLessThan(
      txMock.$queryRaw.mock.invocationCallOrder[0],
    );
  });

  it("compares retained ids case-insensitively and post-checks them lower-cased", async () => {
    const { res } = await rekey(validBody({ retainHistoryIds: [H_RETAINED.toUpperCase()] }));
    expect(res.status).toBe(200);
    expect(mockPostcheck).toHaveBeenCalledWith(txMock, ENTRY, [H_RETAINED]);
  });

  it("re-keys an entry with no history and no attachments", async () => {
    lockedHistory = [];
    lockedAttachments = [];
    txMock.teamPasswordEntryHistory.findMany.mockResolvedValue([]);
    const { res } = await rekey(validBody({ history: [], retainHistoryIds: [], attachmentCekRewraps: [] }));
    expect(res.status).toBe(200);
  });

  it(`keeps the audit metadata under METADATA_MAX_BYTES with ${REKEY_HISTORY_MAX} retained rows`, async () => {
    const ids = Array.from({ length: REKEY_HISTORY_MAX }, (_, i) => `55555555-5555-4555-8555-${String(i).padStart(12, "0")}`);
    lockedHistory = ids.map((id) => ({ id, team_key_version: 10_000, item_key_version: 10_000 }));
    const { res } = await rekey(validBody({ history: [], retainHistoryIds: ids }));
    expect(res.status).toBe(200);
    const metadata = mockLogAuditInTx.mock.calls[0][2].metadata;
    expect(metadata.retained).toHaveLength(REKEY_HISTORY_MAX);
    expect(Buffer.byteLength(JSON.stringify(metadata))).toBeLessThan(METADATA_MAX_BYTES);
  });

  // ── Refusals under the locks (each writes nothing and audits nothing) ────

  const expectRefused = async (body: unknown, status: number, code: string) => {
    const { res, json } = await rekey(body);
    expect(res.status).toBe(status);
    expect(json.error).toBe(code);
    expect(txMock.teamPasswordEntry.update).not.toHaveBeenCalled();
    expect(mockLogAuditInTx).not.toHaveBeenCalled();
  };

  it("409 TEAM_KEY_VERSION_MISMATCH while a rotation holds the team row", async () => {
    mockLockTeamKeyVersion.mockRejectedValue(new TeamRotationInProgressError());
    await expectRefused(validBody(), 409, "TEAM_KEY_VERSION_MISMATCH");
  });

  it("404 when the team is gone under the lock", async () => {
    mockLockTeamKeyVersion.mockResolvedValue(null);
    const { res } = await rekey();
    expect(res.status).toBe(404);
  });

  it("404 when the entry is gone under the lock", async () => {
    lockedEntry = undefined;
    const { res } = await rekey();
    expect(res.status).toBe(404);
    expect(mockLogAuditInTx).not.toHaveBeenCalled();
  });

  it.each([
    ["lost TEAM_UPDATE", { role: "MEMBER" }],
    ["lost membership", null],
  ])("403 ACTOR_NOT_PERMITTED when the actor %s before the lock", async (_label, member) => {
    txMock.teamMember.findFirst.mockResolvedValue(member);
    await expectRefused(validBody(), 403, "ACTOR_NOT_PERMITTED");
  });

  it("403 ACTOR_NOT_PERMITTED before REKEY_NOT_PENDING (check order)", async () => {
    txMock.teamMember.findFirst.mockResolvedValue({ role: "MEMBER" });
    lockedEntry = { ...LOCKED, item_key_team_key_version: 2 };
    await expectRefused(validBody(), 403, "ACTOR_NOT_PERMITTED");
  });

  it("409 REKEY_NOT_PENDING when a re-key committed since the pre-check", async () => {
    lockedEntry = { ...LOCKED, item_key_team_key_version: 2 };
    await expectRefused(validBody(), 409, "REKEY_NOT_PENDING");
  });

  it("409 TEAM_KEY_VERSION_CHANGED when the body names another team key version, before the snapshot", async () => {
    await expectRefused(
      validBody({ teamKeyVersion: 1, snapshot: { blobIv: iv("0"), overviewIv: iv("b"), itemKeyIv: iv("c"), itemKeyVersion: 1 } }),
      409,
      "TEAM_KEY_VERSION_CHANGED",
    );
  });

  it("409 ENTRY_UPGRADE_REQUIRED when a restore turned the entry back to v0 since the pre-check", async () => {
    lockedEntry = { ...LOCKED, item_key_version: 0, item_key_iv: null } as unknown as typeof LOCKED;
    await expectRefused(validBody(), 409, "ENTRY_UPGRADE_REQUIRED");
  });

  it.each([
    ["blobIv", { blobIv: iv("0") }],
    ["overviewIv", { overviewIv: iv("0") }],
    ["itemKeyIv", { itemKeyIv: iv("0") }],
    ["itemKeyVersion", { itemKeyVersion: 2 }],
  ])("409 REKEY_SNAPSHOT_MISMATCH for a stale snapshot %s", async (_field, change) => {
    await expectRefused(
      validBody({ snapshot: { blobIv: iv("a"), overviewIv: iv("b"), itemKeyIv: iv("c"), itemKeyVersion: 1, ...change } }),
      409,
      "REKEY_SNAPSHOT_MISMATCH",
    );
  });

  it("accepts a snapshot in another hex case", async () => {
    const { res } = await rekey(validBody({
      snapshot: { blobIv: iv("A"), overviewIv: iv("B"), itemKeyIv: iv("C"), itemKeyVersion: 1 },
    }));
    expect(res.status).toBe(200);
  });

  it.each([
    ["the high-water itself", 3],
    ["high-water + 2", 5],
    ["the entry's current version", 1],
  ])("409 ITEM_KEY_VERSION_INVALID for %s (the high-water + 1 control is the success cell)", async (_label, version) => {
    await expectRefused(validBody({ newItemKeyVersion: version }), 409, "ITEM_KEY_VERSION_INVALID");
  });

  it("409 ITEM_KEY_VERSION_INVALID before ITEM_KEY_IV_REUSED (check order)", async () => {
    await expectRefused(validBody({ newItemKeyVersion: 5, encryptedItemKey: field("c") }), 409, "ITEM_KEY_VERSION_INVALID");
  });

  it("400 ITEM_KEY_IV_REUSED for a new wrap echoing the locked entry's IV", async () => {
    await expectRefused(validBody({ encryptedItemKey: { ...field("d"), iv: iv("C") } }), 400, "ITEM_KEY_IV_REUSED");
  });

  it("400 ITEM_KEY_IV_REUSED for a new wrap reusing a history row's IV", async () => {
    await expectRefused(validBody({ encryptedItemKey: { ...field("d"), iv: iv("9") } }), 400, "ITEM_KEY_IV_REUSED");
    expect(txMock.teamPasswordEntryHistory.findMany).toHaveBeenCalledWith({
      where: { entryId: ENTRY },
      select: { itemKeyIv: true },
    });
  });

  it.each([
    ["omits a history row", { retainHistoryIds: [] }],
    ["names a history row the entry no longer has", {
      retainHistoryIds: [H_RETAINED, "66666666-6666-4666-8666-666666666666"],
    }],
  ])("409 REKEY_SET_MISMATCH when the body %s", async (_label, change) => {
    await expectRefused(validBody(change), 409, "REKEY_SET_MISMATCH");
    expect(txMock.teamPasswordEntryHistory.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["omits an attachment", { attachmentCekRewraps: [] }],
    ["names an attachment the entry does not have", {
      attachmentCekRewraps: [
        { id: "77777777-7777-4777-8777-777777777777", snapshotCekIv: iv("5"), cekEncrypted: "AAAA", cekIv: iv("6"), cekAuthTag: tag("7") },
      ],
    }],
  ])("409 REKEY_SET_MISMATCH when the body %s", async (_label, change) => {
    await expectRefused(validBody(change), 409, "REKEY_SET_MISMATCH");
  });

  it("409 REKEY_ATTACHMENTS_UNMIGRATED when a legacy attachment is locked, before the attachment set", async () => {
    lockedAttachments = [...LOCKED_ATTACHMENTS, { id: "88888888-8888-4888-8888-888888888888", encryption_mode: 1 }];
    await expectRefused(validBody(), 409, "REKEY_ATTACHMENTS_UNMIGRATED");
  });

  it("409 REKEY_SNAPSHOT_MISMATCH when a history row's blobIv CAS misses, rolling back (no entry write, no audit)", async () => {
    txMock.teamPasswordEntryHistory.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    await expectRefused(validBody(), 409, "REKEY_SNAPSHOT_MISMATCH");
    expect(mockPostcheck).not.toHaveBeenCalled();
  });

  it("409 REKEY_SNAPSHOT_MISMATCH when an attachment's cekIv CAS misses", async () => {
    txMock.attachment.updateMany.mockResolvedValue({ count: 0 });
    await expectRefused(validBody(), 409, "REKEY_SNAPSHOT_MISMATCH");
  });

  it("500 REKEY_POSTCHECK_FAILED when the post-write check fails, without auditing", async () => {
    mockPostcheck.mockRejectedValue(new RekeyConsistencyError(REKEY_INCONSISTENCY.HISTORY_ROW_NOT_REKEYED));
    const { res, json } = await rekey();
    expect(res.status).toBe(500);
    expect(json.error).toBe("REKEY_POSTCHECK_FAILED");
    expect(mockLogAuditInTx).not.toHaveBeenCalled();
  });

  it("rethrows an unexpected transaction failure", async () => {
    txMock.teamPasswordEntry.update.mockRejectedValue(new Error("db down"));
    await expect(POST(request("POST", validBody()), ctx())).rejects.toThrow("db down");
  });
});

describe("GET /api/teams/[teamId]/passwords/[id]/rekey", () => {
  const ENTRY_ROW = {
    id: ENTRY,
    teamId: TEAM,
    encryptedBlob: "e".repeat(40), blobIv: iv("a"), blobAuthTag: tag("a"),
    encryptedOverview: "f".repeat(40), overviewIv: iv("b"), overviewAuthTag: tag("b"),
    aadVersion: 1,
    teamKeyVersion: 1,
    itemKeyVersion: 1,
    encryptedItemKey: "d".repeat(40), itemKeyIv: iv("c"), itemKeyAuthTag: tag("c"),
    itemKeyId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    itemKeyTeamKeyVersion: 1,
    itemKeyVersionHighWater: 3,
  };
  const HISTORY_ROW = {
    id: H1,
    encryptedBlob: "2".repeat(40), blobIv: iv("1"), blobAuthTag: tag("1"),
    aadVersion: 0, teamKeyVersion: 1, itemKeyVersion: 1,
    encryptedItemKey: "d".repeat(40), itemKeyIv: iv("c"), itemKeyAuthTag: tag("c"),
    itemKeyId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  };
  const ATTACHMENT_ROW = {
    id: ATT, encryptionMode: 2, iv: iv("5"), authTag: tag("5"), keyVersion: 1,
    cekEncrypted: Buffer.alloc(48, 1), cekIv: iv("6"), cekAuthTag: tag("6"),
    cekKeyVersion: 1, cekWrapAadVersion: 1, cekItemKeyId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  };

  async function read() {
    const res = await GET(request("GET"), ctx());
    return { res, json: await res.json() };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockReadCheck.mockResolvedValue({ allowed: true });
    mockWithTeamTenantRls.mockImplementation(
      async (_teamId: string, fn: (tenantId: string, tx: typeof txMock) => unknown) => fn("tenant-1", txMock),
    );
    txMock.teamPasswordEntry.findUnique.mockResolvedValue(ENTRY_ROW);
    txMock.team.findUnique.mockResolvedValue({ teamKeyVersion: 2 });
    txMock.teamPasswordEntryHistory.findMany.mockResolvedValue([HISTORY_ROW]);
    txMock.attachment.findMany.mockResolvedValue([ATTACHMENT_ROW]);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await read()).res.status).toBe(401);
  });

  it("requires TEAM_UPDATE", async () => {
    mockRequireTeamPermission.mockRejectedValue(new MockTeamAuthError("FORBIDDEN", 403));
    const { res } = await read();
    expect(res.status).toBe(403);
    expect(mockRequireTeamPermission).toHaveBeenCalledWith("user-1", TEAM, "team:update", expect.anything());
  });

  it("needs no step-up", async () => {
    await read();
    expect(mockRequireRecentSession).not.toHaveBeenCalled();
  });

  it("rate-limits per (team, user)", async () => {
    mockReadCheck.mockResolvedValue({ allowed: false, retryAfterMs: 5000 });
    const { res } = await read();
    expect(res.status).toBe(429);
    expect(mockReadCheck).toHaveBeenCalledWith(`rl:team_entry_rekey_read:${TEAM}:user-1`);
  });

  it.each([
    ["an entry of another team", { ...ENTRY_ROW, teamId: "other-team" }],
    ["an entry invisible under RLS", null],
  ])("returns 404 for %s", async (_label, entry) => {
    txMock.teamPasswordEntry.findUnique.mockResolvedValue(entry);
    expect((await read()).res.status).toBe(404);
  });

  it("returns the entry, its history, its attachments' key material without a body, and the next ItemKey version", async () => {
    const { res, json } = await read();
    expect(res.status).toBe(200);
    expect(json.nextItemKeyVersion).toBe(4);
    expect(json.teamKeyVersion).toBe(2);
    expect(json.entry).toEqual({
      id: ENTRY,
      encryptedBlob: ENTRY_ROW.encryptedBlob, blobIv: ENTRY_ROW.blobIv, blobAuthTag: ENTRY_ROW.blobAuthTag,
      encryptedOverview: ENTRY_ROW.encryptedOverview, overviewIv: ENTRY_ROW.overviewIv, overviewAuthTag: ENTRY_ROW.overviewAuthTag,
      aadVersion: 1, teamKeyVersion: 1, itemKeyVersion: 1,
      encryptedItemKey: ENTRY_ROW.encryptedItemKey, itemKeyIv: ENTRY_ROW.itemKeyIv, itemKeyAuthTag: ENTRY_ROW.itemKeyAuthTag,
      itemKeyId: ENTRY_ROW.itemKeyId,
      itemKeyTeamKeyVersion: 1,
    });
    expect(json.history).toEqual([HISTORY_ROW]);
    expect(json.attachments).toEqual([{ ...ATTACHMENT_ROW, cekEncrypted: Buffer.alloc(48, 1).toString("base64") }]);
    expect(txMock.attachment.findMany.mock.calls[0][0].select).not.toHaveProperty("encryptedData");
  });
});
