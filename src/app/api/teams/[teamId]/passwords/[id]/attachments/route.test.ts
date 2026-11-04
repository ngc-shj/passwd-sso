import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockAuth,
  mockRequireTeamPermission,
  mockPrismaTeamPasswordEntry,
  mockPrismaAttachment,
  mockPrismaTeam,
  mockExecuteRaw,
  MockTeamAuthError,
  mockWithTeamTenantRls,
  mockRateLimitCheck,
  mockLockEntry,
  mockPutObject,
  mockDeleteObject,
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
    findMany: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
  },
  mockPrismaTeam: {
    findUnique: vi.fn(),
  },
  mockExecuteRaw: vi.fn().mockResolvedValue(1),
  mockWithTeamTenantRls: vi.fn(),
  mockLockEntry: vi.fn(),
  mockPutObject: vi.fn(),
  mockDeleteObject: vi.fn(),
  MockTeamAuthError: class MockTeamAuthError extends Error {
    status: number;
    constructor(message: string, status = 403) {
      super(message);
      this.name = "TeamAuthError";
      this.status = status;
    }
  },
  mockRateLimitCheck: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: vi.fn().mockReturnValue({ check: mockRateLimitCheck, clear: vi.fn() }),
}));
vi.mock("@/lib/auth/access/team-auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/access/team-auth")>("@/lib/auth/access/team-auth");
  return {
    requireTeamPermission: mockRequireTeamPermission,
    activeTeamRole: actual.activeTeamRole,
    canWriteTeamEntry: actual.canWriteTeamEntry,
    hasTeamPermission: actual.hasTeamPermission,
    TeamAuthError: MockTeamAuthError,
  };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamPasswordEntry: mockPrismaTeamPasswordEntry,
    attachment: mockPrismaAttachment,
    team: mockPrismaTeam,
    // The cap-check + create now run under a per-entry advisory lock inside one
    // withTeamTenantRls callback (TOCTOU fix); the route calls prisma.$executeRaw
    // for the lock before count/create.
    $executeRaw: mockExecuteRaw,
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: mockWithTeamTenantRls,
}));
// The team → entry row locks are raw SQL against a real transaction
// (team-attachment-rekey.integration.test.ts); here they return the locked
// entry's key identity.
vi.mock("@/lib/team/team-attachment-lock", () => ({
  lockTeamAttachmentEntry: mockLockEntry,
}));
vi.mock("@/lib/blob-store", () => ({
  getAttachmentBlobStore: () => ({
    backend: "db",
    putObject: mockPutObject,
    deleteObject: mockDeleteObject,
  }),
}));

import { GET, POST } from "./route";
import { TeamRotationInProgressError } from "@/lib/team/team-key-rotation-lock";

// The transaction client withTeamTenantRls hands the upload callback.
const tx = {
  attachment: mockPrismaAttachment,
  $executeRaw: mockExecuteRaw,
  teamMember: { findFirst: mockTeamMemberFindFirst },
};

function createParams(teamId: string, id: string) {
  return { params: Promise.resolve({ teamId: teamId, id }) };
}

function createRequest(method: string, url: string) {
  return new NextRequest(url, { method });
}

async function createFormDataRequest(
  url: string,
  fields: Record<string, string | Blob>,
  headers?: Record<string, string>
): Promise<NextRequest> {
  const formData = new FormData();
  for (const [k, v] of Object.entries(fields)) formData.append(k, v);
  // Serialize once to set Content-Length, mirroring a real browser upload —
  // the route gates on it via rejectOversizedMultipart (fail-closed if absent).
  // An explicit `headers` override (e.g. a too-large content-length test) wins.
  const encoded = new Request("http://localhost", { method: "POST", body: formData });
  const bytes = new Uint8Array(await encoded.arrayBuffer());
  return new NextRequest(url, {
    method: "POST",
    body: bytes,
    headers: {
      "content-type": encoded.headers.get("content-type") ?? "multipart/form-data",
      "content-length": String(bytes.length),
      ...headers,
    },
  });
}

// Valid hex strings for client-encrypted fields
const VALID_IV = "a".repeat(24);
const VALID_AUTH_TAG = "b".repeat(32);

// Asserts the per-entry advisory lock ($executeRaw with pg_advisory_xact_lock)
// was acquired inside the upload callback. Mutation-kill: deleting the lock line
// from the production locked path leaves $executeRaw uncalled with that SQL.
function expectAdvisoryLockAcquired(mock: ReturnType<typeof vi.fn>) {
  expect(
    mock.mock.calls.some((c) => String(c[0]).includes("pg_advisory_xact_lock")),
  ).toBe(true);
}

describe("GET /api/teams/[teamId]/passwords/[id]/attachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithTeamTenantRls.mockImplementation(async (_teamId: string, fn: () => unknown) => fn());
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", "http://localhost/api/teams/team-1/passwords/pw-1/attachments"),
      createParams("team-1", "pw-1"),
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when entry does not belong to team", async () => {
    mockPrismaTeamPasswordEntry.findUnique.mockResolvedValue({
      teamId: "other-team",
    });
    const res = await GET(
      createRequest("GET", "http://localhost/api/teams/team-1/passwords/pw-1/attachments"),
      createParams("team-1", "pw-1"),
    );
    expect(res.status).toBe(404);
  });

  it("returns team auth error when permission denied", async () => {
    mockRequireTeamPermission.mockRejectedValue(
      new MockTeamAuthError("FORBIDDEN", 403),
    );
    const res = await GET(
      createRequest("GET", "http://localhost/api/teams/team-1/passwords/pw-1/attachments"),
      createParams("team-1", "pw-1"),
    );
    const json = await res.json();
    expect(res.status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
  });

  it("returns attachment metadata list", async () => {
    mockPrismaTeamPasswordEntry.findUnique.mockResolvedValue({ teamId: "team-1" });
    mockPrismaAttachment.findMany.mockResolvedValue([
      {
        id: "att-1",
        filename: "doc.pdf",
        contentType: "application/pdf",
        sizeBytes: 1234,
        createdAt: new Date(),
      },
    ]);
    const res = await GET(
      createRequest("GET", "http://localhost/api/teams/team-1/passwords/pw-1/attachments"),
      createParams("team-1", "pw-1"),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toHaveLength(1);
    expect(json[0].filename).toBe("doc.pdf");
  });
});

const ATTACHMENT_ID = "11111111-2222-4333-8444-555555555555";
const ITEM_KEY_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER_ITEM_KEY_ID = "99999999-8888-4777-8666-555555555555";
const STORED = new Uint8Array([7, 7, 7]);
const LOCKED_ENTRY = {
  teamKeyVersion: 3,
  tenantId: "t1",
  itemKeyVersion: 2,
  itemKeyId: ITEM_KEY_ID,
  entryTeamKeyVersion: 3,
  createdById: "user-1",
};

// A complete mode-2 upload: body under a fresh CEK, the CEK wrapped under the
// entry's ItemKey (version 2, id ITEM_KEY_ID).
function validFields(overrides: Record<string, string | Blob | undefined> = {}): Record<string, string | Blob> {
  const fields: Record<string, string | Blob | undefined> = {
    id: ATTACHMENT_ID,
    file: new Blob(["abc"]),
    filename: "doc.pdf",
    contentType: "application/pdf",
    iv: VALID_IV,
    authTag: VALID_AUTH_TAG,
    sizeBytes: "3",
    aadVersion: "1",
    encryptionMode: "2",
    itemKeyId: ITEM_KEY_ID,
    cekKeyVersion: "2",
    cekEncrypted: Buffer.from(new Uint8Array(48)).toString("base64"),
    cekIv: "c".repeat(24),
    cekAuthTag: "d".repeat(32),
    cekWrapAadVersion: "1",
    ...overrides,
  };
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Record<string, string | Blob>;
}

async function upload(fields: Record<string, string | Blob> = validFields()) {
  const res = await POST(
    await createFormDataRequest("http://localhost/api/teams/team-1/passwords/pw-1/attachments", fields),
    createParams("team-1", "pw-1"),
  );
  return { res, json: await res.json() };
}

describe("POST /api/teams/[teamId]/passwords/[id]/attachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireTeamPermission.mockResolvedValue({ role: "MEMBER" });
    mockPrismaTeamPasswordEntry.findUnique.mockResolvedValue({ teamId: "team-1", createdById: "user-1" });
    mockPrismaAttachment.count.mockResolvedValue(0);
    mockPrismaAttachment.create.mockResolvedValue({
      id: ATTACHMENT_ID,
      filename: "doc.pdf",
      contentType: "application/pdf",
      sizeBytes: 3,
      createdAt: new Date(),
    });
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
    mockLockEntry.mockResolvedValue(LOCKED_ENTRY);
    mockTeamMemberFindFirst.mockResolvedValue({ role: "MEMBER" });
    mockPutObject.mockResolvedValue(STORED);
    mockDeleteObject.mockResolvedValue(undefined);
    mockWithTeamTenantRls.mockImplementation(
      async (_teamId: string, fn: (tenantId: string, client: typeof tx) => unknown) => fn("t1", tx),
    );
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const { res } = await upload();
    expect(res.status).toBe(401);
  });

  it("returns team auth error when update permission denied", async () => {
    mockRequireTeamPermission.mockRejectedValue(
      new MockTeamAuthError("FORBIDDEN", 403),
    );
    const { res, json } = await upload();
    expect(res.status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
  });

  it("returns 404 when entry does not belong to team", async () => {
    mockPrismaTeamPasswordEntry.findUnique.mockResolvedValue({ teamId: "other-team" });
    const { res } = await upload();
    expect(res.status).toBe(404);
    expect(mockPutObject).not.toHaveBeenCalled();
  });

  it("returns 400 when required fields are missing", async () => {
    const { res, json } = await upload({ filename: "doc.pdf" });
    expect(res.status).toBe(400);
    expect(json.error).toBe("MISSING_REQUIRED_FIELDS");
  });

  it("returns 400 when content type is not allowed", async () => {
    const { res, json } = await upload(validFields({ contentType: "application/zip" }));
    expect(res.status).toBe(400);
    expect(json.error).toBe("CONTENT_TYPE_NOT_ALLOWED");
  });

  it("returns 413 when declared content-length is too large", async () => {
    const res = await POST(
      await createFormDataRequest(
        "http://localhost/api/teams/team-1/passwords/pw-1/attachments",
        validFields(),
        { "content-length": String(30 * 1024 * 1024) },
      ),
      createParams("team-1", "pw-1"),
    );
    const json = await res.json();
    expect(res.status).toBe(413);
    expect(json.error).toBe("PAYLOAD_TOO_LARGE");
  });

  it("returns 400 when actual file size exceeds max", async () => {
    const { res, json } = await upload(
      validFields({ file: new Blob([new Uint8Array(11 * 1024 * 1024)]), sizeBytes: "100" }),
    );
    expect(res.status).toBe(400);
    expect(json.error).toBe("FILE_TOO_LARGE");
  });

  it("returns 400 when formData parsing fails", async () => {
    const req = {
      // Valid content-length so the multipart size gate passes and we reach
      // formData() — this test exercises the parse-failure path specifically.
      headers: new Headers({ "content-length": "100" }),
      formData: vi.fn().mockRejectedValue(new Error("bad form")),
    } as unknown as NextRequest;
    const res = await POST(req, createParams("team-1", "pw-1"));
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error).toBe("INVALID_FORM_DATA");
  });

  it("returns 400 for invalid extension", async () => {
    const { res } = await upload(validFields({ filename: "bad.exe" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid iv format", async () => {
    const { res, json } = await upload(validFields({ iv: "bad-iv" }));
    expect(res.status).toBe(400);
    expect(json.error).toBe("INVALID_ENCRYPTION_FORMAT");
  });

  it("returns 400 for invalid authTag format", async () => {
    const { res, json } = await upload(validFields({ authTag: "bad-tag" }));
    expect(res.status).toBe(400);
    expect(json.error).toBe("INVALID_ENCRYPTION_FORMAT");
  });

  it("creates a mode-2 attachment with the CEK identity and team key version of the LOCKED entry", async () => {
    // The client spells the id in upper case: the stored id comes from the
    // locked row, never from the request.
    const { res } = await upload(validFields({ itemKeyId: ITEM_KEY_ID.toUpperCase() }));
    expect(res.status).toBe(201);
    expectAdvisoryLockAcquired(mockExecuteRaw);
    expect(mockLockEntry).toHaveBeenCalledWith(tx, "team-1", "pw-1");
    expect(mockPrismaAttachment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          id: ATTACHMENT_ID,
          iv: VALID_IV,
          authTag: VALID_AUTH_TAG,
          sizeBytes: 3,
          encryptionMode: 2,
          aadVersion: 1,
          keyVersion: 3,
          cekIv: "c".repeat(24),
          cekAuthTag: "d".repeat(32),
          cekKeyVersion: 2,
          cekWrapAadVersion: 1,
          cekItemKeyId: ITEM_KEY_ID,
          tenantId: "t1",
          teamPasswordEntryId: "pw-1",
          encryptedData: Buffer.from(STORED),
        }),
      }),
    );
    expect(mockDeleteObject).not.toHaveBeenCalled();
  });

  it("writes the body to a fresh generation key before the transaction", async () => {
    await upload();
    await upload();
    const [first, second] = mockPutObject.mock.calls.map((c) => c[1]);
    expect(first).toMatchObject({ attachmentId: ATTACHMENT_ID, entryId: "pw-1", teamId: "team-1" });
    expect(first.generation).toMatch(/^[0-9a-f]{32}$/);
    expect(second.generation).toMatch(/^[0-9a-f]{32}$/);
    expect(first.generation).not.toBe(second.generation);
    expect(mockPutObject.mock.invocationCallOrder[0]).toBeLessThan(
      mockWithTeamTenantRls.mock.invocationCallOrder[1],
    );
  });

  it.each(["0", "1", "3"])("rejects encryptionMode=%s (mode 2 only)", async (mode) => {
    const { res, json } = await upload(validFields({ encryptionMode: mode }));
    expect(res.status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
    expect(mockPutObject).not.toHaveBeenCalled();
  });

  it("returns 400 when encryptionMode is missing", async () => {
    const { res, json } = await upload(validFields({ encryptionMode: undefined }));
    expect(res.status).toBe(400);
    expect(json.error).toBe("MISSING_REQUIRED_FIELDS");
  });

  it.each(["id", "itemKeyId", "cekKeyVersion", "cekEncrypted", "cekIv", "cekAuthTag", "cekWrapAadVersion"])(
    "returns 400 MISSING_REQUIRED_FIELDS without %s",
    async (field) => {
      const { res, json } = await upload(validFields({ [field]: undefined }));
      expect(res.status).toBe(400);
      expect(json.error).toBe("MISSING_REQUIRED_FIELDS");
      expect(mockPutObject).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["a non-v4 attachment id", { id: "not-a-uuid" }],
    ["a malformed itemKeyId", { itemKeyId: "nope" }],
    ["a malformed cekIv", { cekIv: "x".repeat(24) }],
    ["a malformed cekAuthTag", { cekAuthTag: "d".repeat(31) }],
    ["a zero cekKeyVersion", { cekKeyVersion: "0" }],
    ["a non-numeric cekKeyVersion", { cekKeyVersion: "2a" }],
    ["a cekWrapAadVersion other than the current one", { cekWrapAadVersion: "2" }],
    ["a non-base64 cekEncrypted", { cekEncrypted: "!!!!" }],
    ["an oversized cekEncrypted", { cekEncrypted: "A".repeat(260) }],
    ["an aadVersion other than 1", { aadVersion: "2" }],
  ])("returns 400 VALIDATION_ERROR for %s", async (_label, change) => {
    const { res, json } = await upload(validFields(change));
    expect(res.status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 409 ENTRY_UPGRADE_REQUIRED when the locked entry is v0, before comparing ids", async () => {
    mockLockEntry.mockResolvedValue({ ...LOCKED_ENTRY, itemKeyVersion: 0, itemKeyId: null });
    const { res, json } = await upload(validFields({ itemKeyId: OTHER_ITEM_KEY_ID }));
    expect(res.status).toBe(409);
    expect(json.error).toBe("ENTRY_UPGRADE_REQUIRED");
    expect(mockPrismaAttachment.create).not.toHaveBeenCalled();
    expect(mockDeleteObject).toHaveBeenCalledWith(STORED, expect.objectContaining({ attachmentId: ATTACHMENT_ID }));
  });

  it("returns 409 ITEM_KEY_CHANGED when the locked entry holds another ItemKey", async () => {
    mockLockEntry.mockResolvedValue({ ...LOCKED_ENTRY, itemKeyId: OTHER_ITEM_KEY_ID });
    const { res, json } = await upload();
    expect(res.status).toBe(409);
    expect(json.error).toBe("ITEM_KEY_CHANGED");
    expect(mockPrismaAttachment.create).not.toHaveBeenCalled();
    expect(mockDeleteObject).toHaveBeenCalledTimes(1);
  });

  it("returns 409 ITEM_KEY_CHANGED when the locked entry's ItemKey id is NULL", async () => {
    mockLockEntry.mockResolvedValue({ ...LOCKED_ENTRY, itemKeyId: null });
    const { res, json } = await upload();
    expect(res.status).toBe(409);
    expect(json.error).toBe("ITEM_KEY_CHANGED");
  });

  it("checks the ItemKey id before cekKeyVersion (stale id + wrong version → ITEM_KEY_CHANGED)", async () => {
    mockLockEntry.mockResolvedValue({ ...LOCKED_ENTRY, itemKeyId: OTHER_ITEM_KEY_ID });
    const { json } = await upload(validFields({ cekKeyVersion: "5" }));
    expect(json.error).toBe("ITEM_KEY_CHANGED");
  });

  it("returns 409 CEK_KEY_VERSION_MISMATCH when cekKeyVersion is not the locked itemKeyVersion", async () => {
    const { res, json } = await upload(validFields({ cekKeyVersion: "1" }));
    expect(res.status).toBe(409);
    expect(json.error).toBe("CEK_KEY_VERSION_MISMATCH");
    expect(mockPrismaAttachment.create).not.toHaveBeenCalled();
    expect(mockDeleteObject).toHaveBeenCalledTimes(1);
  });

  it("returns 409 ENTRY_REKEY_REQUIRED when the locked entry's ItemKey is wrapped under an older team key, writing nothing", async () => {
    mockLockEntry.mockResolvedValue({ ...LOCKED_ENTRY, entryTeamKeyVersion: 2 });
    const { res, json } = await upload();
    expect(res.status).toBe(409);
    expect(json.error).toBe("ENTRY_REKEY_REQUIRED");
    expect(mockPrismaAttachment.create).not.toHaveBeenCalled();
    expect(mockDeleteObject).toHaveBeenCalledTimes(1);
  });

  it("checks cekKeyVersion before the re-key rule (wrong version on an off-version entry → CEK_KEY_VERSION_MISMATCH)", async () => {
    mockLockEntry.mockResolvedValue({ ...LOCKED_ENTRY, entryTeamKeyVersion: 2 });
    const { json } = await upload(validFields({ cekKeyVersion: "1" }));
    expect(json.error).toBe("CEK_KEY_VERSION_MISMATCH");
  });

  it("control: an entry at team key version 0 on a team at version 1 is current (normalised) → 201", async () => {
    mockLockEntry.mockResolvedValue({ ...LOCKED_ENTRY, teamKeyVersion: 1, entryTeamKeyVersion: 0 });
    const { res } = await upload();
    expect(res.status).toBe(201);
  });

  it("returns 403 ONLY_OWN_ENTRIES for a MEMBER on another member's entry before anything is stored", async () => {
    mockPrismaTeamPasswordEntry.findUnique.mockResolvedValue({ teamId: "team-1", createdById: "other-user" });
    const { res, json } = await upload();
    expect(res.status).toBe(403);
    expect(json.error).toBe("ONLY_OWN_ENTRIES");
    expect(mockPutObject).not.toHaveBeenCalled();
    expect(mockLockEntry).not.toHaveBeenCalled();
  });

  it("returns 403 ACTOR_NOT_PERMITTED for a MEMBER when the locked entry's creator is another member, and deletes the written object", async () => {
    mockLockEntry.mockResolvedValue({ ...LOCKED_ENTRY, createdById: "other-user" });
    const { res, json } = await upload();
    expect(res.status).toBe(403);
    expect(json.error).toBe("ACTOR_NOT_PERMITTED");
    expect(mockPrismaAttachment.create).not.toHaveBeenCalled();
    expect(mockDeleteObject).toHaveBeenCalledTimes(1);
  });

  it("control: an ADMIN uploads to another member's entry → 201", async () => {
    mockRequireTeamPermission.mockResolvedValue({ role: "ADMIN" });
    mockTeamMemberFindFirst.mockResolvedValue({ role: "ADMIN" });
    mockPrismaTeamPasswordEntry.findUnique.mockResolvedValue({ teamId: "team-1", createdById: "other-user" });
    mockLockEntry.mockResolvedValue({ ...LOCKED_ENTRY, createdById: "other-user" });
    const { res } = await upload();
    expect(res.status).toBe(201);
  });

  it("returns 400 ATTACHMENT_LIMIT_EXCEEDED under the advisory lock and deletes the written object", async () => {
    mockPrismaAttachment.count.mockResolvedValue(20);
    const { res, json } = await upload();
    expect(res.status).toBe(400);
    expect(json.error).toBe("ATTACHMENT_LIMIT_EXCEEDED");
    expectAdvisoryLockAcquired(mockExecuteRaw);
    expect(mockDeleteObject).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no longer an active member", null],
    ["demoted to VIEWER", { role: "VIEWER" }],
  ])("returns 403 ACTOR_NOT_PERMITTED when the actor is %s under the team lock, and deletes the written object", async (_label, membership) => {
    mockTeamMemberFindFirst.mockResolvedValue(membership);
    const { res, json } = await upload();
    expect(res.status).toBe(403);
    expect(json.error).toBe("ACTOR_NOT_PERMITTED");
    expect(mockTeamMemberFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { teamId: "team-1", userId: "user-1", deactivatedAt: null } }),
    );
    expect(mockPrismaAttachment.create).not.toHaveBeenCalled();
    expect(mockDeleteObject).toHaveBeenCalledTimes(1);
  });

  it("returns 404 when the entry is gone under the lock", async () => {
    mockLockEntry.mockResolvedValue(null);
    const { res } = await upload();
    expect(res.status).toBe(404);
    expect(mockDeleteObject).toHaveBeenCalledTimes(1);
  });

  it("returns 409 TEAM_KEY_VERSION_MISMATCH when a rotation holds the team row", async () => {
    mockLockEntry.mockRejectedValue(new TeamRotationInProgressError());
    const { res, json } = await upload();
    expect(res.status).toBe(409);
    expect(json.error).toBe("TEAM_KEY_VERSION_MISMATCH");
    expect(mockDeleteObject).toHaveBeenCalledTimes(1);
  });

  it("deletes the written object and rethrows when the transaction fails", async () => {
    mockPrismaAttachment.create.mockRejectedValue(new Error("db down"));
    await expect(
      POST(
        await createFormDataRequest("http://localhost/api/teams/team-1/passwords/pw-1/attachments", validFields()),
        createParams("team-1", "pw-1"),
      ),
    ).rejects.toThrow("db down");
    expect(mockDeleteObject).toHaveBeenCalledWith(STORED, expect.objectContaining({ teamId: "team-1" }));
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimitCheck.mockResolvedValueOnce({ allowed: false, retryAfterMs: 30_000 });
    const { res } = await upload();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
  });
});
