import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import { createParams } from "../../helpers/request-builder";

const {
  mockAuth,
  mockRequireTeamPermission,
  mockEntryFindUnique,
  mockAttachmentFindUnique,
  mockAttachmentDelete,
  mockGetObject,
  mockDeleteObject,
  mockWithTeamTenantRls,
  mockHistoryFindMany,
  mockLockEntry,
  mockLockRow,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTeamPermission: vi.fn(),
  mockEntryFindUnique: vi.fn(),
  mockAttachmentFindUnique: vi.fn(),
  mockAttachmentDelete: vi.fn(),
  mockGetObject: vi.fn(),
  mockDeleteObject: vi.fn(),
  mockWithTeamTenantRls: vi.fn(),
  mockHistoryFindMany: vi.fn(),
  mockLockEntry: vi.fn(),
  mockLockRow: vi.fn(),
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
    attachment: {
      findUnique: mockAttachmentFindUnique,
      delete: mockAttachmentDelete,
    },
  },
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: vi.fn(),
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "Test" }),
  teamAuditBase: vi.fn((_, userId, teamId) => ({ scope: "TEAM", userId, teamId })),
}));
vi.mock("@/lib/blob-store", () => ({
  BLOB_STORAGE: { DB: "db", S3: "s3" },
  getAttachmentBlobStore: () => ({
    backend: "s3",
    getObject: mockGetObject,
    deleteObject: mockDeleteObject,
  }),
}));
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: mockWithTeamTenantRls,
}));
// Raw-SQL row locks; exercised against a real DB in
// team-attachment-rekey.integration.test.ts.
vi.mock("@/lib/team/team-attachment-lock", () => ({
  lockTeamAttachmentEntry: mockLockEntry,
  lockTeamAttachmentRow: mockLockRow,
}));

import { NextRequest } from "next/server";
import { GET, DELETE } from "@/app/api/teams/[teamId]/passwords/[id]/attachments/[attachmentId]/route";
import { TeamAuthError } from "@/lib/auth/access/team-auth";

function makeParams(teamId: string, id: string, attachmentId: string) {
  return createParams({ teamId: teamId, id, attachmentId });
}

function createGetRequest() {
  return new NextRequest(
    "http://localhost/api/teams/o1/passwords/e1/attachments/a1",
    { method: "GET" },
  );
}

function createDeleteRequest() {
  return new NextRequest(
    "http://localhost/api/teams/o1/passwords/e1/attachments/a1",
    { method: "DELETE" },
  );
}

const ITEM_KEY_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const TEAM_ENTRY = {
  teamId: "o1",
  encryptedItemKey: "entry-wrap",
  itemKeyIv: "1".repeat(24),
  itemKeyAuthTag: "2".repeat(32),
  teamKeyVersion: 1,
  itemKeyVersion: 1,
  itemKeyId: ITEM_KEY_ID,
};
const tx = {
  teamPasswordEntry: { findUnique: mockEntryFindUnique },
  attachment: { findUnique: mockAttachmentFindUnique, delete: mockAttachmentDelete },
  teamPasswordEntryHistory: { findMany: mockHistoryFindMany },
};
const withTx = async (_teamId: string, fn: (tenantId: string, client: typeof tx) => unknown) => fn("t1", tx);

const ATTACHMENT = {
  id: "a1",
  filename: "test.pdf",
  contentType: "application/pdf",
  sizeBytes: 100,
  iv: "a".repeat(24),
  authTag: "b".repeat(32),
  encryptedData: Buffer.from("encrypted-data"),
  keyVersion: 1,
  aadVersion: 1,
  encryptionMode: 1,
};

describe("GET /api/teams/[teamId]/passwords/[id]/attachments/[attachmentId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithTeamTenantRls.mockImplementation(withTx);
    mockHistoryFindMany.mockResolvedValue([]);
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(createGetRequest(), makeParams("o1", "e1", "a1"));
    expect(res.status).toBe(401);
  });

  it("returns 403 when lacking permission", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("FORBIDDEN", 403));
    const res = await GET(createGetRequest(), makeParams("o1", "e1", "a1"));
    expect(res.status).toBe(403);
  });

  it("returns 404 when entry not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(null);
    const res = await GET(createGetRequest(), makeParams("o1", "e1", "a1"));
    expect(res.status).toBe(404);
  });

  it("returns 404 when entry belongs to different team", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue({ teamId: "other-team" });
    const res = await GET(createGetRequest(), makeParams("o1", "e1", "a1"));
    expect(res.status).toBe(404);
  });

  it("returns 404 when attachment not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(TEAM_ENTRY);
    mockAttachmentFindUnique.mockResolvedValue(null);
    const res = await GET(createGetRequest(), makeParams("o1", "e1", "a1"));
    expect(res.status).toBe(404);
  });

  it("returns encrypted data as JSON for client-side decryption", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(TEAM_ENTRY);
    mockAttachmentFindUnique.mockResolvedValue(ATTACHMENT);
    mockGetObject.mockResolvedValue(Buffer.from("encrypted-data"));

    const res = await GET(createGetRequest(), makeParams("o1", "e1", "a1"));
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.id).toBe("a1");
    expect(json.filename).toBe("test.pdf");
    expect(json.contentType).toBe("application/pdf");
    expect(json.sizeBytes).toBe(100);
    expect(json.encryptedData).toBe(Buffer.from("encrypted-data").toString("base64"));
    expect(json.iv).toBe("a".repeat(24));
    expect(json.authTag).toBe("b".repeat(32));
    expect(json.keyVersion).toBe(1);
    expect(json.aadVersion).toBe(1);
    expect(json.encryptionMode).toBe(1);
    // Legacy mode 1: the entry wrap (and any history wraps) for trial decryption.
    expect(json.itemKeyWraps).toEqual([
      {
        source: "entry",
        historyId: null,
        encryptedItemKey: "entry-wrap",
        itemKeyIv: "1".repeat(24),
        itemKeyAuthTag: "2".repeat(32),
        teamKeyVersion: 1,
        itemKeyVersion: 1,
      },
    ]);
  });

  it("returns the mode-2 CEK wrap with the entry wrap holding its ItemKey", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(TEAM_ENTRY);
    mockAttachmentFindUnique.mockResolvedValue({
      ...ATTACHMENT,
      encryptionMode: 2,
      cekEncrypted: Buffer.from([5]),
      cekIv: "c".repeat(24),
      cekAuthTag: "d".repeat(32),
      cekKeyVersion: 1,
      cekWrapAadVersion: 1,
      cekItemKeyId: ITEM_KEY_ID,
    });
    mockGetObject.mockResolvedValue(Buffer.from("encrypted-data"));

    const res = await GET(createGetRequest(), makeParams("o1", "e1", "a1"));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.cekKeyVersion).toBe(1);
    expect(json.itemKeyWrap).toMatchObject({ source: "entry", itemKeyVersion: 1, teamKeyVersion: 1 });
  });

  it("returns 409 ATTACHMENT_KEY_UNAVAILABLE for a mode-2 attachment no wrap opens", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(TEAM_ENTRY);
    mockAttachmentFindUnique.mockResolvedValue({
      ...ATTACHMENT,
      encryptionMode: 2,
      cekItemKeyId: "99999999-8888-4777-8666-555555555555",
    });

    const res = await GET(createGetRequest(), makeParams("o1", "e1", "a1"));
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.error).toBe("ATTACHMENT_KEY_UNAVAILABLE");
  });
});

describe("DELETE /api/teams/[teamId]/passwords/[id]/attachments/[attachmentId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithTeamTenantRls.mockImplementation(withTx);
    mockLockEntry.mockResolvedValue({ teamKeyVersion: 1, tenantId: "t1", itemKeyVersion: 1, itemKeyId: ITEM_KEY_ID });
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await DELETE(createDeleteRequest(), makeParams("o1", "e1", "a1"));
    expect(res.status).toBe(401);
  });

  it("returns 403 when lacking permission", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("FORBIDDEN", 403));
    const res = await DELETE(createDeleteRequest(), makeParams("o1", "e1", "a1"));
    expect(res.status).toBe(403);
  });

  it("returns 404 when entry not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(null);
    const res = await DELETE(createDeleteRequest(), makeParams("o1", "e1", "a1"));
    expect(res.status).toBe(404);
  });

  it("returns 404 when entry belongs to different team", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue({ teamId: "other-team" });
    const res = await DELETE(createDeleteRequest(), makeParams("o1", "e1", "a1"));
    expect(res.status).toBe(404);
  });

  it("returns 404 when attachment not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue({ teamId: "o1" });
    mockLockRow.mockResolvedValue(null);
    const res = await DELETE(createDeleteRequest(), makeParams("o1", "e1", "a1"));
    expect(res.status).toBe(404);
    expect(mockAttachmentDelete).not.toHaveBeenCalled();
  });

  it("deletes attachment successfully", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue({ teamId: "o1" });
    const stored = Buffer.from(JSON.stringify({ key: `team/o1/e1/a1/${"0".repeat(32)}.bin` }));
    mockLockRow.mockResolvedValue({ filename: "test.pdf", encryptedData: stored });
    mockDeleteObject.mockResolvedValue(undefined);
    mockAttachmentDelete.mockResolvedValue({});

    const res = await DELETE(createDeleteRequest(), makeParams("o1", "e1", "a1"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockAttachmentDelete).toHaveBeenCalledWith({ where: { id: "a1", teamPasswordEntryId: "e1" } });
    // The locked row's object, deleted after the row.
    expect(mockDeleteObject).toHaveBeenCalledWith(stored, { attachmentId: "a1", entryId: "e1", teamId: "o1" });
    expect(mockAttachmentDelete.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeleteObject.mock.invocationCallOrder[0],
    );
  });
});
