import { createHash } from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockAuth,
  mockRequireTeamPermission,
  MockTeamAuthError,
  mockEntryFindUnique,
  mockAttachmentFindUnique,
  mockWithTeamTenantRls,
  mockRequireRecentSession,
  mockRateLimitCheck,
  mockLockEntry,
  mockLockRow,
  mockGetObject,
  mockPutObject,
  mockDeleteObject,
  mockDeleteBlobs,
  mockLogAuditInTx,
  mockStore,
} = vi.hoisted(() => {
  const mockGetObject = vi.fn();
  const mockPutObject = vi.fn();
  const mockDeleteObject = vi.fn();
  return {
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
    mockEntryFindUnique: vi.fn(),
    mockAttachmentFindUnique: vi.fn(),
    mockWithTeamTenantRls: vi.fn(),
    mockRequireRecentSession: vi.fn(),
    mockRateLimitCheck: vi.fn(),
    mockLockEntry: vi.fn(),
    mockLockRow: vi.fn(),
    mockGetObject,
    mockPutObject,
    mockDeleteObject,
    mockDeleteBlobs: vi.fn(),
    mockLogAuditInTx: vi.fn(),
    mockStore: {
      backend: "s3",
      getObject: mockGetObject,
      putObject: mockPutObject,
      deleteObject: mockDeleteObject,
    },
  };
});

// The in-transaction client: the role re-read and the row update.
const txMock = {
  teamMember: { findFirst: vi.fn() },
  attachment: { update: vi.fn() },
};

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/auth/access/team-auth", async () => ({
  requireTeamPermission: mockRequireTeamPermission,
  // The real role read and permission table: the route re-checks the actor under its locks.
  activeTeamRole: (await vi.importActual<typeof import("@/lib/auth/access/team-auth")>("@/lib/auth/access/team-auth")).activeTeamRole,
  hasTeamPermission: (await vi.importActual<typeof import("@/lib/auth/access/team-auth")>("@/lib/auth/access/team-auth")).hasTeamPermission,
  TeamAuthError: MockTeamAuthError,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamPasswordEntry: { findUnique: mockEntryFindUnique },
    attachment: { findUnique: mockAttachmentFindUnique },
  },
}));
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: mockWithTeamTenantRls,
}));
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: mockRequireRecentSession,
}));
vi.mock("@/lib/security/rate-limiters", () => ({
  teamAttachmentMigrateLimiter: { check: mockRateLimitCheck, clear: vi.fn() },
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditInTx: mockLogAuditInTx,
  teamAuditBase: vi.fn((_req, userId, teamId) => ({ scope: "TEAM", userId, teamId })),
}));
// Raw-SQL row locks; exercised against a real DB in
// team-attachment-rekey.integration.test.ts.
vi.mock("@/lib/team/team-attachment-lock", () => ({
  lockTeamAttachmentEntry: mockLockEntry,
  lockTeamAttachmentRow: mockLockRow,
}));
vi.mock("@/lib/blob-store", () => ({
  getAttachmentBlobStore: () => mockStore,
}));
vi.mock("@/lib/blob-store/cleanup", () => ({
  deleteAttachmentBlobs: mockDeleteBlobs,
}));
vi.mock("@/lib/http/with-request-log", () => ({
  withRequestLog: (fn: (...args: unknown[]) => unknown) => fn,
}));

import { PUT } from "./route";
import { BlobRefInvalidError } from "@/lib/blob-store/object-ref";
import { TeamRotationInProgressError } from "@/lib/team/team-key-rotation-lock";
import { ATTACHMENT_BODY_BASE64_MAX } from "@/lib/validations/common";
import { documentedMetadataKeys } from "@/__tests__/helpers/audit-log-reference";

const TEAM = "11111111-1111-4111-8111-111111111111";
const ENTRY = "22222222-2222-4222-8222-222222222222";
const ATT = "33333333-3333-4333-8333-333333333333";
const ITEM_KEY_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER_ITEM_KEY_ID = "99999999-8888-4777-8666-555555555555";
const GEN = "0123456789abcdef0123456789abcdef";

// The stored legacy body, its ref (S3) and the row holding it.
const OLD_BODY = Buffer.from("old-ciphertext-16b");
const OLD_REF = Buffer.from(JSON.stringify({ key: `team/${TEAM}/${ENTRY}/${ATT}.bin` }));
const NEW_REF = Buffer.from(JSON.stringify({ key: `team/${TEAM}/${ENTRY}/${ATT}/${GEN}.bin` }));
const ROW = {
  filename: "doc.pdf",
  contentType: "application/pdf",
  sizeBytes: 2,
  encryptedData: OLD_REF,
  iv: "1".repeat(24),
  authTag: "2".repeat(32),
  encryptionMode: 1,
  keyVersion: 1,
};
const LOCKED_ENTRY = { teamKeyVersion: 3, tenantId: "tenant-1", itemKeyVersion: 2, itemKeyId: ITEM_KEY_ID };

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    itemKeyId: ITEM_KEY_ID,
    cekKeyVersion: 2,
    snapshot: { iv: ROW.iv, authTag: ROW.authTag },
    clientHash: createHash("sha256").update(OLD_BODY).digest("hex"),
    // Same byte length as OLD_BODY (AES-GCM preserves the plaintext length).
    encryptedData: Buffer.alloc(OLD_BODY.length, 7).toString("base64"),
    iv: "3".repeat(24),
    authTag: "4".repeat(32),
    cekEncrypted: Buffer.alloc(48, 1).toString("base64"),
    cekIv: "5".repeat(24),
    cekAuthTag: "6".repeat(32),
    cekWrapAadVersion: 1,
    filename: ROW.filename,
    contentType: ROW.contentType,
    sizeBytes: ROW.sizeBytes,
    aadVersion: 1,
    ...overrides,
  };
}

function request(body: unknown) {
  return new NextRequest(`http://localhost/api/teams/${TEAM}/passwords/${ENTRY}/attachments/${ATT}/migrate`, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

async function migrate(body: unknown = validBody()) {
  const res = await PUT(request(body), { params: Promise.resolve({ teamId: TEAM, id: ENTRY, attachmentId: ATT }) });
  return { res, json: await res.json() };
}

describe("PUT /api/teams/[teamId]/passwords/[id]/attachments/[attachmentId]/migrate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockRequireRecentSession.mockResolvedValue(null);
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
    mockEntryFindUnique.mockResolvedValue({ teamId: TEAM });
    mockAttachmentFindUnique.mockResolvedValue(ROW);
    mockWithTeamTenantRls.mockImplementation(
      async (_teamId: string, fn: (tenantId: string, tx: typeof txMock) => unknown) => fn("tenant-1", txMock),
    );
    mockLockEntry.mockResolvedValue(LOCKED_ENTRY);
    mockLockRow.mockResolvedValue(ROW);
    txMock.teamMember.findFirst.mockResolvedValue({ role: "ADMIN" });
    txMock.attachment.update.mockResolvedValue({});
    mockStore.backend = "s3";
    mockGetObject.mockResolvedValue(OLD_BODY);
    mockPutObject.mockResolvedValue(NEW_REF);
    mockDeleteObject.mockResolvedValue(undefined);
    mockDeleteBlobs.mockResolvedValue(undefined);
    mockLogAuditInTx.mockResolvedValue(undefined);
  });

  // ── Gates ────────────────────────────────────────────────────────────────

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const { res } = await migrate();
    expect(res.status).toBe(401);
  });

  it("requires TEAM_UPDATE", async () => {
    mockRequireTeamPermission.mockRejectedValue(new MockTeamAuthError("FORBIDDEN", 403));
    const { res, json } = await migrate();
    expect(res.status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
    expect(mockRequireTeamPermission).toHaveBeenCalledWith("user-1", TEAM, "team:update", expect.anything());
  });

  it("returns the step-up refusal before touching anything", async () => {
    mockRequireRecentSession.mockResolvedValue(
      new Response(JSON.stringify({ error: "SESSION_STEP_UP_REQUIRED" }), { status: 403 }),
    );
    const { res, json } = await migrate();
    expect(res.status).toBe(403);
    expect(json.error).toBe("SESSION_STEP_UP_REQUIRED");
    expect(mockRateLimitCheck).not.toHaveBeenCalled();
    expect(mockPutObject).not.toHaveBeenCalled();
  });

  it("rate-limits per (team, user)", async () => {
    mockRateLimitCheck.mockResolvedValue({ allowed: false, retryAfterMs: 5000 });
    const { res } = await migrate();
    expect(res.status).toBe(429);
    expect(mockRateLimitCheck).toHaveBeenCalledWith(`rl:team_attachment_migrate:${TEAM}:user-1`);
  });

  it("returns 404 for an entry of another team", async () => {
    mockEntryFindUnique.mockResolvedValue({ teamId: "other-team" });
    const { res } = await migrate();
    expect(res.status).toBe(404);
    expect(mockPutObject).not.toHaveBeenCalled();
  });

  it("returns 404 ATTACHMENT_NOT_FOUND for an attachment not on the entry", async () => {
    mockAttachmentFindUnique.mockResolvedValue(null);
    const { res, json } = await migrate();
    expect(res.status).toBe(404);
    expect(json.error).toBe("ATTACHMENT_NOT_FOUND");
    expect(mockPutObject).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown field", { extra: 1 }],
    ["a missing clientHash", { clientHash: undefined }],
    ["a malformed snapshot iv", { snapshot: { iv: "x", authTag: ROW.authTag } }],
    ["a non-base64 body", { encryptedData: "!!!!" }],
    ["a cekWrapAadVersion other than the current one", { cekWrapAadVersion: 2 }],
    ["a zero cekKeyVersion", { cekKeyVersion: 0 }],
    ["a non-uuid itemKeyId", { itemKeyId: "nope" }],
  ])("returns 400 for %s, before writing", async (_label, change) => {
    const { res } = await migrate(validBody(change));
    expect(res.status).toBe(400);
    expect(mockPutObject).not.toHaveBeenCalled();
  });

  it("checks a well-formed body near ATTACHMENT_BODY_BASE64_MAX (no regex stack overflow) and reaches the attachment lookup", async () => {
    mockAttachmentFindUnique.mockResolvedValue(null);
    const large = "A".repeat(ATTACHMENT_BODY_BASE64_MAX - (ATTACHMENT_BODY_BASE64_MAX % 4));
    const { res, json } = await migrate(validBody({ encryptedData: large }));
    expect(res.status).toBe(404);
    expect(json.error).toBe("ATTACHMENT_NOT_FOUND");
  });

  // ── Success ──────────────────────────────────────────────────────────────

  it("migrates to mode 2 under the locks with the LOCKED entry's ItemKey id, audits in the transaction, then deletes the old object", async () => {
    const { res, json } = await migrate(validBody({ itemKeyId: ITEM_KEY_ID.toUpperCase() }));
    expect(res.status).toBe(200);
    expect(json).toEqual({ success: true, attachmentId: ATT, encryptionMode: 2 });
    expect(mockLockEntry).toHaveBeenCalledWith(txMock, TEAM, ENTRY);
    expect(mockLockRow).toHaveBeenCalledWith(txMock, ENTRY, ATT);
    expect(txMock.attachment.update).toHaveBeenCalledWith({
      where: { id: ATT, teamPasswordEntryId: ENTRY },
      data: {
        encryptedData: NEW_REF,
        iv: "3".repeat(24),
        authTag: "4".repeat(32),
        aadVersion: 1,
        keyVersion: 3,
        encryptionMode: 2,
        cekEncrypted: Buffer.alloc(48, 1),
        cekIv: "5".repeat(24),
        cekAuthTag: "6".repeat(32),
        cekKeyVersion: 2,
        cekWrapAadVersion: 1,
        cekItemKeyId: ITEM_KEY_ID,
      },
    });
    expect(mockLogAuditInTx).toHaveBeenCalledWith(
      txMock,
      "tenant-1",
      expect.objectContaining({
        action: "TEAM_ATTACHMENT_MIGRATE",
        targetType: "Attachment",
        targetId: ATT,
        metadata: { entryId: ENTRY, fromEncryptionMode: 1, toItemKeyVersion: 2 },
      }),
    );
    // The keys docs/operations/audit-log-reference.md documents for the action.
    const migrateAudit = mockLogAuditInTx.mock.calls.find((c) => c[2].action === "TEAM_ATTACHMENT_MIGRATE");
    expect(Object.keys(migrateAudit?.[2].metadata ?? {}).sort()).toEqual(documentedMetadataKeys("TEAM_ATTACHMENT_MIGRATE"));
    expect(mockDeleteBlobs).toHaveBeenCalledWith([
      { stored: OLD_REF, context: { attachmentId: ATT, entryId: ENTRY, teamId: TEAM } },
    ]);
    expect(mockDeleteObject).not.toHaveBeenCalled();
  });

  it("writes the new body to a fresh generation key before the transaction", async () => {
    await migrate();
    expect(mockPutObject).toHaveBeenCalledWith(
      Buffer.alloc(OLD_BODY.length, 7),
      { attachmentId: ATT, entryId: ENTRY, teamId: TEAM, generation: expect.stringMatching(/^[0-9a-f]{32}$/) },
    );
    expect(mockPutObject.mock.invocationCallOrder[0]).toBeLessThan(mockLockEntry.mock.invocationCallOrder[0]);
  });

  it("hashes the body read through the blob store, not the stored ref", async () => {
    const { res, json } = await migrate(validBody({ clientHash: createHash("sha256").update(OLD_REF).digest("hex") }));
    expect(res.status).toBe(409);
    expect(json.error).toBe("MIGRATE_HASH_MISMATCH");
    expect(mockGetObject).toHaveBeenCalledWith(OLD_REF, { attachmentId: ATT, entryId: ENTRY, teamId: TEAM });
  });

  it("migrates a mode-0 attachment (control for the mode-2 refusal)", async () => {
    mockAttachmentFindUnique.mockResolvedValue({ ...ROW, encryptionMode: 0 });
    mockLockRow.mockResolvedValue({ ...ROW, encryptionMode: 0 });
    const { res } = await migrate();
    expect(res.status).toBe(200);
  });

  // ── Refusals (each deletes the new object; none writes) ─────────────────

  const expectRefused = async (body: unknown, status: number, code: string) => {
    const { res, json } = await migrate(body);
    expect(res.status).toBe(status);
    expect(json.error).toBe(code);
    expect(txMock.attachment.update).not.toHaveBeenCalled();
    expect(mockLogAuditInTx).not.toHaveBeenCalled();
    expect(mockDeleteObject).toHaveBeenCalledWith(NEW_REF, expect.objectContaining({ attachmentId: ATT }));
    expect(mockDeleteBlobs).not.toHaveBeenCalled();
  };

  it("403 ACTOR_NOT_PERMITTED when the actor lost TEAM_UPDATE before the lock", async () => {
    txMock.teamMember.findFirst.mockResolvedValue({ role: "MEMBER" });
    await expectRefused(validBody(), 403, "ACTOR_NOT_PERMITTED");
  });

  it("403 ACTOR_NOT_PERMITTED when the actor's membership is gone under the lock", async () => {
    txMock.teamMember.findFirst.mockResolvedValue(null);
    await expectRefused(validBody(), 403, "ACTOR_NOT_PERMITTED");
  });

  it("409 MIGRATE_NOT_LEGACY first, when the locked row is already mode 2", async () => {
    mockLockRow.mockResolvedValue({ ...ROW, encryptionMode: 2 });
    // Every later check would also refuse.
    mockLockEntry.mockResolvedValue({ ...LOCKED_ENTRY, itemKeyVersion: 0, itemKeyId: null });
    await expectRefused(validBody({ cekKeyVersion: 9 }), 409, "MIGRATE_NOT_LEGACY");
  });

  it("409 ENTRY_UPGRADE_REQUIRED for a v0 entry, before comparing ids", async () => {
    mockLockEntry.mockResolvedValue({ ...LOCKED_ENTRY, itemKeyVersion: 0, itemKeyId: null });
    await expectRefused(validBody(), 409, "ENTRY_UPGRADE_REQUIRED");
  });

  it("409 ITEM_KEY_CHANGED for a stale itemKeyId", async () => {
    mockLockEntry.mockResolvedValue({ ...LOCKED_ENTRY, itemKeyId: OTHER_ITEM_KEY_ID });
    await expectRefused(validBody(), 409, "ITEM_KEY_CHANGED");
  });

  describe("an entry whose ItemKey has no id (written by a previous release during rollout)", () => {
    beforeEach(() => mockLockEntry.mockResolvedValue({ ...LOCKED_ENTRY, itemKeyId: null }));

    it("migrates for a client that read the id as unknown, binding the CEK to no id", async () => {
      const { res } = await migrate(validBody({ itemKeyId: null }));
      expect(res.status).toBe(200);
      expect(txMock.attachment.update.mock.calls[0][0].data.cekItemKeyId).toBeNull();
    });

    it("409 ITEM_KEY_CHANGED for a client that names an id", async () => {
      await expectRefused(validBody(), 409, "ITEM_KEY_CHANGED");
    });
  });

  it("409 ITEM_KEY_CHANGED for a client that read no id when the locked entry has one", async () => {
    await expectRefused(validBody({ itemKeyId: null }), 409, "ITEM_KEY_CHANGED");
  });

  it("409 ITEM_KEY_CHANGED for a stale itemKeyId with a wrong cekKeyVersion (check order)", async () => {
    mockLockEntry.mockResolvedValue({ ...LOCKED_ENTRY, itemKeyId: OTHER_ITEM_KEY_ID });
    await expectRefused(validBody({ cekKeyVersion: 7 }), 409, "ITEM_KEY_CHANGED");
  });

  it("409 CEK_KEY_VERSION_MISMATCH for a current itemKeyId with a wrong cekKeyVersion", async () => {
    await expectRefused(validBody({ cekKeyVersion: 1 }), 409, "CEK_KEY_VERSION_MISMATCH");
  });

  it("409 MIGRATE_CAS_FAILED for a stale snapshot iv", async () => {
    await expectRefused(validBody({ snapshot: { iv: "9".repeat(24), authTag: ROW.authTag } }), 409, "MIGRATE_CAS_FAILED");
  });

  it("409 MIGRATE_CAS_FAILED for a stale snapshot authTag", async () => {
    await expectRefused(validBody({ snapshot: { iv: ROW.iv, authTag: "9".repeat(32) } }), 409, "MIGRATE_CAS_FAILED");
  });

  it("409 MIGRATE_CAS_FAILED when the locked row is not the row the body was read from", async () => {
    // The client's snapshot matches the locked row, but a migrate committed
    // between the server's pre-read and its lock: the hash is stale.
    const locked = { ...ROW, iv: "7".repeat(24), encryptedData: NEW_REF };
    mockLockRow.mockResolvedValue(locked);
    await expectRefused(validBody({ snapshot: { iv: locked.iv, authTag: ROW.authTag } }), 409, "MIGRATE_CAS_FAILED");
  });

  it("409 BLOB_REF_INVALID before uploading the new body when the pre-read ref names another row's object", async () => {
    const foreign = Buffer.from(JSON.stringify({ key: `team/${TEAM}/${ENTRY}/${OTHER_ITEM_KEY_ID}.bin` }));
    mockAttachmentFindUnique.mockResolvedValue({ ...ROW, encryptedData: foreign });
    mockGetObject.mockRejectedValue(new BlobRefInvalidError());
    const { res, json } = await migrate(validBody());
    expect(res.status).toBe(409);
    expect(json.error).toBe("BLOB_REF_INVALID");
    expect(mockPutObject).not.toHaveBeenCalled();
    expect(mockDeleteObject).not.toHaveBeenCalled();
    expect(mockLockEntry).not.toHaveBeenCalled();
  });

  it("409 BLOB_REF_INVALID under the lock when the locked row's ref changed to another row's object since the pre-read", async () => {
    const foreign = Buffer.from(JSON.stringify({ key: `team/${TEAM}/${ENTRY}/${OTHER_ITEM_KEY_ID}.bin` }));
    mockLockRow.mockResolvedValue({ ...ROW, encryptedData: foreign });
    await expectRefused(validBody(), 409, "BLOB_REF_INVALID");
  });

  it("409 MIGRATE_NOT_LEGACY before uploading the new body when the pre-read row is already mode 2", async () => {
    mockAttachmentFindUnique.mockResolvedValue({ ...ROW, encryptionMode: 2 });
    const { res, json } = await migrate(validBody());
    expect(res.status).toBe(409);
    expect(json.error).toBe("MIGRATE_NOT_LEGACY");
    expect(mockGetObject).not.toHaveBeenCalled();
    expect(mockPutObject).not.toHaveBeenCalled();
    expect(mockLockEntry).not.toHaveBeenCalled();
  });

  it("does not check refs on the DB backend (the column is the body)", async () => {
    mockStore.backend = "db";
    mockAttachmentFindUnique.mockResolvedValue({ ...ROW, encryptedData: OLD_BODY });
    mockLockRow.mockResolvedValue({ ...ROW, encryptedData: OLD_BODY });
    const { res } = await migrate();
    expect(res.status).toBe(200);
  });

  it("409 MIGRATE_HASH_MISMATCH when the client hashed other bytes", async () => {
    await expectRefused(validBody({ clientHash: "f".repeat(64) }), 409, "MIGRATE_HASH_MISMATCH");
  });

  it("409 MIGRATE_LENGTH_CHANGED when the new ciphertext length differs", async () => {
    await expectRefused(
      validBody({ encryptedData: Buffer.alloc(OLD_BODY.length + 1, 7).toString("base64") }),
      409,
      "MIGRATE_LENGTH_CHANGED",
    );
  });

  it.each([
    ["filename", { filename: "other.pdf" }],
    ["contentType", { contentType: "image/png" }],
    ["sizeBytes", { sizeBytes: 3 }],
  ])("409 MIGRATE_METADATA_CHANGED when %s differs", async (_field, change) => {
    await expectRefused(validBody(change), 409, "MIGRATE_METADATA_CHANGED");
  });

  it("409 TEAM_KEY_VERSION_MISMATCH while a rotation holds the team row", async () => {
    mockLockEntry.mockRejectedValue(new TeamRotationInProgressError());
    await expectRefused(validBody(), 409, "TEAM_KEY_VERSION_MISMATCH");
  });

  it("404 when the entry is gone under the lock", async () => {
    mockLockEntry.mockResolvedValue(null);
    const { res } = await migrate();
    expect(res.status).toBe(404);
    expect(mockDeleteObject).toHaveBeenCalledWith(NEW_REF, expect.anything());
  });

  it("deletes the new object and rethrows when the transaction fails", async () => {
    txMock.attachment.update.mockRejectedValue(new Error("db down"));
    await expect(
      PUT(request(validBody()), { params: Promise.resolve({ teamId: TEAM, id: ENTRY, attachmentId: ATT }) }),
    ).rejects.toThrow("db down");
    expect(mockDeleteObject).toHaveBeenCalledWith(NEW_REF, expect.anything());
    expect(mockDeleteBlobs).not.toHaveBeenCalled();
  });
});
