import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockAuth,
  mockRequireTeamPermission,
  mockPrismaTeamPasswordEntry,
  mockPrismaAttachment,
  mockPrismaHistory,
  MockTeamAuthError,
  mockWithTeamTenantRls,
  mockLockEntry,
  mockLockRow,
  mockGetObject,
  mockDeleteBlobs,
  mockLogAuditAsync,
  mockTeamMemberFindFirst,
} = vi.hoisted(() => ({
  // The actor's membership, re-read under the team lock (activeTeamRole).
  mockTeamMemberFindFirst: vi.fn(),
  mockAuth: vi.fn(),
  mockRequireTeamPermission: vi.fn(),
  mockPrismaTeamPasswordEntry: {
    findUnique: vi.fn(),
  },
  mockPrismaAttachment: {
    findUnique: vi.fn(),
    delete: vi.fn(),
  },
  mockPrismaHistory: {
    findMany: vi.fn(),
  },
  mockWithTeamTenantRls: vi.fn(),
  MockTeamAuthError: class MockTeamAuthError extends Error {
    status: number;
    constructor(message: string, status = 403) {
      super(message);
      this.name = "TeamAuthError";
      this.status = status;
    }
  },
  mockLockEntry: vi.fn(),
  mockLockRow: vi.fn(),
  mockGetObject: vi.fn(),
  mockDeleteBlobs: vi.fn(),
  mockLogAuditAsync: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/auth/access/team-auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/access/team-auth")>("@/lib/auth/access/team-auth");
  return {
    requireTeamPermission: mockRequireTeamPermission,
    activeTeamRole: actual.activeTeamRole,
    hasTeamPermission: actual.hasTeamPermission,
    TeamAuthError: MockTeamAuthError,
  };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamPasswordEntry: mockPrismaTeamPasswordEntry,
    attachment: mockPrismaAttachment,
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: mockWithTeamTenantRls,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAuditAsync,
  teamAuditBase: vi.fn((_req, userId, teamId) => ({ scope: "TEAM", userId, teamId })),
}));
// Raw-SQL row locks; exercised against a real DB in
// team-attachment-rekey.integration.test.ts.
vi.mock("@/lib/team/team-attachment-lock", () => ({
  lockTeamAttachmentEntry: mockLockEntry,
  lockTeamAttachmentRow: mockLockRow,
}));
vi.mock("@/lib/blob-store", () => ({
  getAttachmentBlobStore: () => ({ backend: "s3", getObject: mockGetObject }),
}));
vi.mock("@/lib/blob-store/cleanup", () => ({
  deleteAttachmentBlobs: mockDeleteBlobs,
}));

import { GET, DELETE } from "./route";
import { BlobRefInvalidError } from "@/lib/blob-store/object-ref";
import { TeamRotationInProgressError } from "@/lib/team/team-key-rotation-lock";

const tx = {
  teamPasswordEntry: mockPrismaTeamPasswordEntry,
  attachment: mockPrismaAttachment,
  teamPasswordEntryHistory: mockPrismaHistory,
  teamMember: { findFirst: mockTeamMemberFindFirst },
};

const KEY_A = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const KEY_B = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";

// The entry's live wrap: ItemKey A at item key version 2 under team key 3.
const ENTRY = {
  teamId: "team-1",
  encryptedItemKey: "entry-wrap",
  itemKeyIv: "1".repeat(24),
  itemKeyAuthTag: "2".repeat(32),
  teamKeyVersion: 3,
  itemKeyVersion: 2,
  itemKeyId: KEY_A,
};

function historyRow(id: string, itemKeyId: string | null, teamKeyVersion: number, itemKeyVersion = 1) {
  return {
    id,
    encryptedItemKey: `wrap-${id}`,
    itemKeyIv: "3".repeat(24),
    itemKeyAuthTag: "4".repeat(32),
    teamKeyVersion,
    itemKeyVersion,
    itemKeyId,
  };
}

function attachment(overrides: Record<string, unknown> = {}) {
  return {
    id: "att-1",
    filename: "doc.pdf",
    contentType: "application/pdf",
    sizeBytes: 4,
    encryptedData: Buffer.from('{"key":"ref"}'),
    iv: "a".repeat(24),
    authTag: "b".repeat(32),
    keyVersion: 3,
    aadVersion: 1,
    encryptionMode: 2,
    cekEncrypted: Buffer.from([9, 9]),
    cekIv: "c".repeat(24),
    cekAuthTag: "d".repeat(32),
    cekKeyVersion: 2,
    cekWrapAadVersion: 1,
    cekItemKeyId: KEY_A,
    ...overrides,
  };
}

function createParams(teamId: string, id: string, attachmentId: string) {
  return { params: Promise.resolve({ teamId: teamId, id, attachmentId }) };
}

function createRequest(method: string, url: string) {
  return new NextRequest(url, { method });
}

async function get() {
  const res = await GET(
    createRequest("GET", "http://localhost/api/teams/team-1/passwords/pw-1/attachments/att-1"),
    createParams("team-1", "pw-1", "att-1"),
  );
  return { res, json: await res.json() };
}

describe("GET /api/teams/[teamId]/passwords/[id]/attachments/[attachmentId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockPrismaTeamPasswordEntry.findUnique.mockResolvedValue(ENTRY);
    mockPrismaAttachment.findUnique.mockResolvedValue(attachment());
    mockPrismaHistory.findMany.mockResolvedValue([]);
    mockGetObject.mockResolvedValue(Buffer.from([1, 2, 3]));
    mockWithTeamTenantRls.mockImplementation(
      async (_teamId: string, fn: (tenantId: string, client: typeof tx) => unknown) => fn("t1", tx),
    );
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const { res } = await get();
    expect(res.status).toBe(401);
  });

  it("returns team auth error when permission denied", async () => {
    mockRequireTeamPermission.mockRejectedValue(
      new MockTeamAuthError("FORBIDDEN", 403),
    );
    const { res, json } = await get();
    expect(res.status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
  });

  it("returns 404 when entry does not belong to team", async () => {
    mockPrismaTeamPasswordEntry.findUnique.mockResolvedValue({ ...ENTRY, teamId: "other-team" });
    const { res } = await get();
    expect(res.status).toBe(404);
    expect(mockPrismaAttachment.findUnique).not.toHaveBeenCalled();
  });

  it("returns 404 when attachment not found", async () => {
    mockPrismaAttachment.findUnique.mockResolvedValue(null);
    const { res, json } = await get();
    expect(res.status).toBe(404);
    expect(json.error).toBe("ATTACHMENT_NOT_FOUND");
  });

  it("mode 2: returns the cek fields and the entry wrap when the entry holds the CEK's ItemKey", async () => {
    const { res, json } = await get();
    expect(res.status).toBe(200);
    expect(json).toMatchObject({
      id: "att-1",
      encryptedData: Buffer.from([1, 2, 3]).toString("base64"),
      iv: "a".repeat(24),
      authTag: "b".repeat(32),
      encryptionMode: 2,
      cekEncrypted: Buffer.from([9, 9]).toString("base64"),
      cekIv: "c".repeat(24),
      cekAuthTag: "d".repeat(32),
      cekKeyVersion: 2,
      cekWrapAadVersion: 1,
      itemKeyWrap: {
        source: "entry",
        historyId: null,
        encryptedItemKey: "entry-wrap",
        teamKeyVersion: 3,
        itemKeyVersion: 2,
      },
    });
    expect(json.itemKeyWraps).toBeUndefined();
  });

  it("mode 2: returns the history wrap holding the CEK's ItemKey when the entry's ItemKey changed", async () => {
    mockPrismaAttachment.findUnique.mockResolvedValue(attachment({ cekItemKeyId: KEY_B, cekKeyVersion: 1 }));
    mockPrismaHistory.findMany.mockResolvedValue([historyRow("h-b", KEY_B, 2)]);
    const { res, json } = await get();
    expect(res.status).toBe(200);
    expect(mockPrismaHistory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { entryId: "pw-1", itemKeyId: KEY_B } }),
    );
    expect(json.itemKeyWrap).toEqual({
      source: "history",
      historyId: "h-b",
      encryptedItemKey: "wrap-h-b",
      itemKeyIv: "3".repeat(24),
      itemKeyAuthTag: "4".repeat(32),
      teamKeyVersion: 2,
      itemKeyVersion: 1,
    });
  });

  it("mode 2: returns 409 ATTACHMENT_KEY_UNAVAILABLE when no row holds the CEK's ItemKey, without reading the body", async () => {
    mockPrismaAttachment.findUnique.mockResolvedValue(attachment({ cekItemKeyId: KEY_B }));
    const { res, json } = await get();
    expect(res.status).toBe(409);
    expect(json.error).toBe("ATTACHMENT_KEY_UNAVAILABLE");
    expect(mockGetObject).not.toHaveBeenCalled();
  });

  it("mode 2 bound to no ItemKey id (D41 rollout migrate): returns the CEK fields with the entry and every history wrap for trial", async () => {
    mockPrismaTeamPasswordEntry.findUnique.mockResolvedValue({ ...ENTRY, itemKeyId: null });
    mockPrismaAttachment.findUnique.mockResolvedValue(attachment({ cekItemKeyId: null }));
    mockPrismaHistory.findMany.mockResolvedValue([historyRow("h-null", null, 3), historyRow("h-b", KEY_B, 2)]);
    const { res, json } = await get();
    expect(res.status).toBe(200);
    // No id filter: every history row is a candidate.
    expect(mockPrismaHistory.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { entryId: "pw-1" } }));
    expect(json.itemKeyWrap).toBeUndefined();
    expect(json.itemKeyWraps.map((w: { source: string; historyId: string | null }) => [w.source, w.historyId])).toEqual([
      ["entry", null],
      ["history", "h-null"],
      ["history", "h-b"],
    ]);
    expect(json.cekIv).toBe("c".repeat(24));
    expect(json.cekEncrypted).toBe(Buffer.from([9, 9]).toString("base64"));
  });

  it("mode 2 bound to no ItemKey id with no wrap anywhere → 409 ATTACHMENT_KEY_UNAVAILABLE", async () => {
    mockPrismaTeamPasswordEntry.findUnique.mockResolvedValue({ ...ENTRY, itemKeyId: null, encryptedItemKey: null });
    mockPrismaAttachment.findUnique.mockResolvedValue(attachment({ cekItemKeyId: null }));
    mockPrismaHistory.findMany.mockResolvedValue([]);
    const { res, json } = await get();
    expect(res.status).toBe(409);
    expect(json.error).toBe("ATTACHMENT_KEY_UNAVAILABLE");
  });

  it("control: mode 2 with an id keeps the strict match (history filtered by that id, one wrap)", async () => {
    mockPrismaTeamPasswordEntry.findUnique.mockResolvedValue({ ...ENTRY, itemKeyId: KEY_A });
    mockPrismaAttachment.findUnique.mockResolvedValue(attachment({ cekItemKeyId: KEY_B }));
    mockPrismaHistory.findMany.mockResolvedValue([historyRow("h-b", KEY_B, 2)]);
    const { res, json } = await get();
    expect(res.status).toBe(200);
    expect(mockPrismaHistory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { entryId: "pw-1", itemKeyId: KEY_B } }),
    );
    expect(json.itemKeyWraps).toBeUndefined();
    expect(json.itemKeyWrap.historyId).toBe("h-b");
  });

  it("mode 1: returns the entry wrap and every history wrap for trial decryption", async () => {
    mockPrismaAttachment.findUnique.mockResolvedValue(
      attachment({ encryptionMode: 1, cekEncrypted: null, cekIv: null, cekAuthTag: null, cekKeyVersion: null, cekItemKeyId: null }),
    );
    mockPrismaHistory.findMany.mockResolvedValue([
      historyRow("h-1", KEY_B, 2),
      // A v0 history row holds no ItemKey wrap.
      { ...historyRow("h-v0", null, 1, 0), encryptedItemKey: null, itemKeyIv: null, itemKeyAuthTag: null },
    ]);
    const { res, json } = await get();
    expect(res.status).toBe(200);
    expect(mockPrismaHistory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { entryId: "pw-1" } }),
    );
    expect(json.encryptionMode).toBe(1);
    expect(json.itemKeyWraps.map((w: { source: string; historyId: string | null }) => [w.source, w.historyId])).toEqual([
      ["entry", null],
      ["history", "h-1"],
    ]);
    expect(json.cekEncrypted).toBeUndefined();
  });

  it.each([
    [null, 1],
    [0, 1],
    [1, 1],
    [2, 2],
  ])("mode 0: keyVersion %s is returned as %s", async (stored, expected) => {
    mockPrismaAttachment.findUnique.mockResolvedValue(
      attachment({ encryptionMode: 0, keyVersion: stored, cekEncrypted: null, cekItemKeyId: null }),
    );
    const { res, json } = await get();
    expect(res.status).toBe(200);
    expect(json.keyVersion).toBe(expected);
    expect(json.itemKeyWrap).toBeUndefined();
    expect(json.itemKeyWraps).toBeUndefined();
    expect(mockPrismaHistory.findMany).not.toHaveBeenCalled();
  });

  it("never returns the storage ref", async () => {
    const { json } = await get();
    expect(JSON.stringify(json)).not.toContain(Buffer.from('{"key":"ref"}').toString("base64"));
    expect(JSON.stringify(json)).not.toContain('"key":"ref"');
  });

  it("returns 409 BLOB_REF_INVALID when the stored ref does not name the row's object", async () => {
    mockGetObject.mockRejectedValue(new BlobRefInvalidError());
    const { res, json } = await get();
    expect(res.status).toBe(409);
    expect(json.error).toBe("BLOB_REF_INVALID");
  });
});

async function del() {
  const res = await DELETE(
    createRequest("DELETE", "http://localhost/api/teams/team-1/passwords/pw-1/attachments/att-1"),
    createParams("team-1", "pw-1", "att-1"),
  );
  return { res, json: await res.json() };
}

describe("DELETE /api/teams/[teamId]/passwords/[id]/attachments/[attachmentId]", () => {
  const STORED = Buffer.from('{"key":"locked-ref"}');

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockPrismaTeamPasswordEntry.findUnique.mockResolvedValue({ teamId: "team-1" });
    mockLockEntry.mockResolvedValue({ teamKeyVersion: 3, tenantId: "t1", itemKeyVersion: 2, itemKeyId: KEY_A });
    mockLockRow.mockResolvedValue({ filename: "doc.pdf", encryptedData: STORED });
    mockTeamMemberFindFirst.mockResolvedValue({ role: "ADMIN" });
    mockPrismaAttachment.delete.mockResolvedValue({});
    mockDeleteBlobs.mockResolvedValue(undefined);
    mockWithTeamTenantRls.mockImplementation(
      async (_teamId: string, fn: (tenantId?: string, client?: typeof tx) => unknown) => fn("t1", tx),
    );
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const { res } = await del();
    expect(res.status).toBe(401);
  });

  it("returns team auth error when permission denied", async () => {
    mockRequireTeamPermission.mockRejectedValue(
      new MockTeamAuthError("FORBIDDEN", 403),
    );
    const { res, json } = await del();
    expect(res.status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
  });

  it("returns 404 when entry does not belong to team", async () => {
    mockPrismaTeamPasswordEntry.findUnique.mockResolvedValue({ teamId: "other-team" });
    const { res } = await del();
    expect(res.status).toBe(404);
    expect(mockLockEntry).not.toHaveBeenCalled();
  });

  it("returns 404 when the entry is gone under the lock", async () => {
    mockLockEntry.mockResolvedValue(null);
    const { res } = await del();
    expect(res.status).toBe(404);
    expect(mockPrismaAttachment.delete).not.toHaveBeenCalled();
  });

  it.each([
    ["no longer an active member", null],
    // MEMBER holds PASSWORD_UPDATE but not PASSWORD_DELETE.
    ["demoted to MEMBER", { role: "MEMBER" }],
  ])("returns 403 ACTOR_NOT_PERMITTED when the actor is %s under the team lock, deleting nothing", async (_label, membership) => {
    mockTeamMemberFindFirst.mockResolvedValue(membership);
    const { res, json } = await del();
    expect(res.status).toBe(403);
    expect(json.error).toBe("ACTOR_NOT_PERMITTED");
    expect(mockTeamMemberFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { teamId: "team-1", userId: "user-1", deactivatedAt: null } }),
    );
    expect(mockLockRow).not.toHaveBeenCalled();
    expect(mockPrismaAttachment.delete).not.toHaveBeenCalled();
    expect(mockDeleteBlobs).not.toHaveBeenCalled();
  });

  it("returns 404 ATTACHMENT_NOT_FOUND when the locked row is gone", async () => {
    mockLockRow.mockResolvedValue(null);
    const { res, json } = await del();
    expect(res.status).toBe(404);
    expect(json.error).toBe("ATTACHMENT_NOT_FOUND");
    expect(mockPrismaAttachment.delete).not.toHaveBeenCalled();
    expect(mockDeleteBlobs).not.toHaveBeenCalled();
  });

  it("returns 409 TEAM_KEY_VERSION_MISMATCH when a rotation holds the team row", async () => {
    mockLockEntry.mockRejectedValue(new TeamRotationInProgressError());
    const { res, json } = await del();
    expect(res.status).toBe(409);
    expect(json.error).toBe("TEAM_KEY_VERSION_MISMATCH");
  });

  it("deletes the row under the locks, then the locked row's object after commit", async () => {
    const { res, json } = await del();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockLockEntry).toHaveBeenCalledWith(tx, "team-1", "pw-1");
    expect(mockLockRow).toHaveBeenCalledWith(tx, "pw-1", "att-1");
    expect(mockPrismaAttachment.delete).toHaveBeenCalledWith({
      where: { id: "att-1", teamPasswordEntryId: "pw-1" },
    });
    expect(mockDeleteBlobs).toHaveBeenCalledWith([
      { stored: STORED, context: { attachmentId: "att-1", entryId: "pw-1", teamId: "team-1" } },
    ]);
    expect(mockPrismaAttachment.delete.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeleteBlobs.mock.invocationCallOrder[0],
    );
  });

  it("does not delete the object when the row delete fails", async () => {
    mockPrismaAttachment.delete.mockRejectedValue(new Error("db down"));
    await expect(
      DELETE(
        createRequest("DELETE", "http://localhost/api/teams/team-1/passwords/pw-1/attachments/att-1"),
        createParams("team-1", "pw-1", "att-1"),
      ),
    ).rejects.toThrow("db down");
    expect(mockDeleteBlobs).not.toHaveBeenCalled();
  });
});
