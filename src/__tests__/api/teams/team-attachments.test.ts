import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import { createParams, parseResponse } from "../../helpers/request-builder";

const {
  mockAuth,
  mockRequireTeamPermission,
  mockEntryFindUnique,
  mockAttachmentFindMany,
  mockAttachmentCount,
  mockAttachmentCreate,
  mockPutObject,
  mockDeleteObject,
  mockWithTeamTenantRls,
  mockRateLimitCheck,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTeamPermission: vi.fn(),
  mockEntryFindUnique: vi.fn(),
  mockAttachmentFindMany: vi.fn(),
  mockAttachmentCount: vi.fn(),
  mockAttachmentCreate: vi.fn(),
  mockPutObject: vi.fn(),
  mockDeleteObject: vi.fn(),
  mockWithTeamTenantRls: vi.fn(async (_teamId: string, fn: () => unknown) => fn()),
  mockRateLimitCheck: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/security/rate-limit", () => ({ createRateLimiter: vi.fn(() => ({ check: mockRateLimitCheck, clear: vi.fn() })) }));
vi.mock("@/lib/auth/team-auth", () => {
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
      findMany: mockAttachmentFindMany,
      count: mockAttachmentCount,
      create: mockAttachmentCreate,
    },
  },
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: vi.fn(),
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "Test" }),
  teamAuditBase: vi.fn((_, userId, teamId) => ({ scope: "TEAM", userId, teamId })),
}));
vi.mock("@/lib/blob-store", () => ({
  getAttachmentBlobStore: () => ({
    putObject: mockPutObject,
    deleteObject: mockDeleteObject,
  }),
}));
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: mockWithTeamTenantRls,
}));

import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/teams/[teamId]/passwords/[id]/attachments/route";
import { TeamAuthError } from "@/lib/auth/team-auth";

function makeParams(teamId: string, id: string) {
  return createParams({ teamId: teamId, id });
}

function createGetRequest() {
  return new NextRequest("http://localhost/api/teams/o1/passwords/e1/attachments", {
    method: "GET",
  });
}

function createFormDataRequest(
  fields: Record<string, string | Blob>,
  headers: Record<string, string> = {},
) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.append(key, value);
  }
  return new NextRequest("http://localhost/api/teams/o1/passwords/e1/attachments", {
    method: "POST",
    body: formData,
    headers,
  });
}

function validFormFields(): Record<string, string | Blob> {
  return {
    file: new Blob(["encrypted-data"], { type: "application/octet-stream" }),
    filename: "test.pdf",
    contentType: "application/pdf",
    iv: "a".repeat(24),
    authTag: "b".repeat(32),
    sizeBytes: "5",
    encryptionMode: "1",
  };
}

const TEAM_ENTRY = { teamId: "o1", itemKeyVersion: 1, teamKeyVersion: 1, tenantId: "t1" };

describe("GET /api/teams/[teamId]/passwords/[id]/attachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(createGetRequest(), makeParams("o1", "e1"));
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 403 when lacking permission", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("FORBIDDEN", 403));
    const res = await GET(createGetRequest(), makeParams("o1", "e1"));
    const { status } = await parseResponse(res);
    expect(status).toBe(403);
  });

  it("returns 404 when entry not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(null);
    const res = await GET(createGetRequest(), makeParams("o1", "e1"));
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it("returns 404 when entry belongs to different team", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue({ teamId: "other-team" });
    const res = await GET(createGetRequest(), makeParams("o1", "e1"));
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it("returns attachments list", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue({ teamId: "o1" });
    mockAttachmentFindMany.mockResolvedValue([
      { id: "a1", filename: "test.pdf", contentType: "application/pdf", sizeBytes: 100, createdAt: new Date() },
    ]);
    const res = await GET(createGetRequest(), makeParams("o1", "e1"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json).toHaveLength(1);
    expect(json[0].filename).toBe("test.pdf");
  });
});

describe("POST /api/teams/[teamId]/passwords/[id]/attachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const req = createFormDataRequest(validFormFields());
    const res = await POST(req, makeParams("o1", "e1"));
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 403 when lacking permission", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("FORBIDDEN", 403));
    const req = createFormDataRequest(validFormFields());
    const res = await POST(req, makeParams("o1", "e1"));
    const { status } = await parseResponse(res);
    expect(status).toBe(403);
  });

  it("returns 404 when entry not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(null);
    const req = createFormDataRequest(validFormFields());
    const res = await POST(req, makeParams("o1", "e1"));
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it("returns 400 when attachment limit exceeded", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(TEAM_ENTRY);
    mockAttachmentCount.mockResolvedValue(20);
    const req = createFormDataRequest(validFormFields());
    const res = await POST(req, makeParams("o1", "e1"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("ATTACHMENT_LIMIT_EXCEEDED");
  });

  it("returns 413 when content-length too large", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(TEAM_ENTRY);
    mockAttachmentCount.mockResolvedValue(0);
    const req = createFormDataRequest(validFormFields(), {
      "content-length": String(100 * 1024 * 1024),
    });
    const res = await POST(req, makeParams("o1", "e1"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(413);
    expect(json.error).toBe("PAYLOAD_TOO_LARGE");
  });

  it("returns 400 when required fields are missing", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(TEAM_ENTRY);
    mockAttachmentCount.mockResolvedValue(0);
    const req = createFormDataRequest({ file: new Blob(["x"]) });
    const res = await POST(req, makeParams("o1", "e1"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("MISSING_REQUIRED_FIELDS");
  });

  it("returns 400 for extension not allowed", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(TEAM_ENTRY);
    mockAttachmentCount.mockResolvedValue(0);
    const fields = validFormFields();
    fields.filename = "malware.exe";
    const req = createFormDataRequest(fields);
    const res = await POST(req, makeParams("o1", "e1"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("EXTENSION_NOT_ALLOWED");
  });

  it("returns 400 for content type not allowed", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(TEAM_ENTRY);
    mockAttachmentCount.mockResolvedValue(0);
    const fields = validFormFields();
    fields.contentType = "application/x-executable";
    const req = createFormDataRequest(fields);
    const res = await POST(req, makeParams("o1", "e1"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("CONTENT_TYPE_NOT_ALLOWED");
  });

  it("returns 400 for invalid iv format", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(TEAM_ENTRY);
    mockAttachmentCount.mockResolvedValue(0);
    const fields = { ...validFormFields(), iv: "bad-iv" };
    const req = createFormDataRequest(fields);
    const res = await POST(req, makeParams("o1", "e1"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("INVALID_IV_FORMAT");
  });

  it("returns 400 for invalid authTag format", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(TEAM_ENTRY);
    mockAttachmentCount.mockResolvedValue(0);
    const fields = { ...validFormFields(), authTag: "bad-tag" };
    const req = createFormDataRequest(fields);
    const res = await POST(req, makeParams("o1", "e1"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("INVALID_AUTH_TAG_FORMAT");
  });

  it("returns 400 for filename with path traversal characters", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(TEAM_ENTRY);
    mockAttachmentCount.mockResolvedValue(0);
    const fields = validFormFields();
    fields.filename = "../etc/passwd.pdf";
    const req = createFormDataRequest(fields);
    const res = await POST(req, makeParams("o1", "e1"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("INVALID_FILENAME");
  });

  it("returns 400 for filename with CRLF characters", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(TEAM_ENTRY);
    mockAttachmentCount.mockResolvedValue(0);
    const fields = validFormFields();
    fields.filename = "test\r\n.pdf";
    const req = createFormDataRequest(fields);
    const res = await POST(req, makeParams("o1", "e1"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("INVALID_FILENAME");
  });

  it("returns 400 for Windows reserved device name", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(TEAM_ENTRY);
    mockAttachmentCount.mockResolvedValue(0);
    const fields = validFormFields();
    fields.filename = "CON.pdf";
    const req = createFormDataRequest(fields);
    const res = await POST(req, makeParams("o1", "e1"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("INVALID_FILENAME");
  });

  it("uploads client-encrypted attachment successfully with encryptionMode=1", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(TEAM_ENTRY);
    mockAttachmentCount.mockResolvedValue(0);
    mockPutObject.mockResolvedValue(Buffer.from("stored"));
    const created = {
      id: "a1",
      filename: "test.pdf",
      contentType: "application/pdf",
      sizeBytes: 5,
      createdAt: new Date(),
    };
    mockAttachmentCreate.mockResolvedValue(created);
    const req = createFormDataRequest(validFormFields());
    const res = await POST(req, makeParams("o1", "e1"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(201);
    expect(json.filename).toBe("test.pdf");
    expect(mockAttachmentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          iv: "a".repeat(24),
          authTag: "b".repeat(32),
          sizeBytes: 5,
          encryptionMode: 1,
        }),
      }),
    );
  });

  it("rejects encryptionMode=0", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(TEAM_ENTRY);
    mockAttachmentCount.mockResolvedValue(0);
    const fields = { ...validFormFields(), encryptionMode: "0" };
    const req = createFormDataRequest(fields);
    const res = await POST(req, makeParams("o1", "e1"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("rejects invalid encryptionMode", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(TEAM_ENTRY);
    mockAttachmentCount.mockResolvedValue(0);
    const fields = { ...validFormFields(), encryptionMode: "2" };
    const req = createFormDataRequest(fields);
    const res = await POST(req, makeParams("o1", "e1"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("rejects missing encryptionMode", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(TEAM_ENTRY);
    mockAttachmentCount.mockResolvedValue(0);
    const fields = validFormFields();
    delete fields.encryptionMode;
    const req = createFormDataRequest(fields);
    const res = await POST(req, makeParams("o1", "e1"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("MISSING_REQUIRED_FIELDS");
  });

  it("rejects upload when entry has itemKeyVersion=0", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue({ ...TEAM_ENTRY, itemKeyVersion: 0 });
    const req = createFormDataRequest(validFormFields());
    const res = await POST(req, makeParams("o1", "e1"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("ITEM_KEY_REQUIRED");
  });

  it("rejects invalid client-provided attachmentId (non-UUID)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(TEAM_ENTRY);
    mockAttachmentCount.mockResolvedValue(0);
    const fields = { ...validFormFields(), id: "not-a-uuid" };
    const req = createFormDataRequest(fields);
    const res = await POST(req, makeParams("o1", "e1"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("accepts valid UUID v4 as client-provided attachmentId", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(TEAM_ENTRY);
    mockAttachmentCount.mockResolvedValue(0);
    mockPutObject.mockResolvedValue(Buffer.from("stored"));
    mockAttachmentCreate.mockResolvedValue({
      id: "550e8400-e29b-41d4-a716-446655440000",
      filename: "test.pdf",
      contentType: "application/pdf",
      sizeBytes: 5,
      createdAt: new Date(),
    });
    const fields = { ...validFormFields(), id: "550e8400-e29b-41d4-a716-446655440000" };
    const req = createFormDataRequest(fields);
    const res = await POST(req, makeParams("o1", "e1"));
    const { status } = await parseResponse(res);
    expect(status).toBe(201);
  });

  it("normalizes uppercase UUID clientId to lowercase for AAD consistency", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(TEAM_ENTRY);
    mockAttachmentCount.mockResolvedValue(0);
    mockPutObject.mockResolvedValue(Buffer.from("stored"));
    const uppercaseId = "550E8400-E29B-41D4-A716-446655440000";
    mockAttachmentCreate.mockResolvedValue({
      id: uppercaseId.toLowerCase(),
      filename: "test.pdf",
      contentType: "application/pdf",
      sizeBytes: 5,
      createdAt: new Date(),
    });
    const fields = { ...validFormFields(), id: uppercaseId };
    const req = createFormDataRequest(fields);
    const res = await POST(req, makeParams("o1", "e1"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(201);
    expect(json.id).toBe(uppercaseId.toLowerCase());
    // Verify the attachment was created with a lowercase ID (normalized)
    expect(mockAttachmentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          id: uppercaseId.toLowerCase(),
        }),
      })
    );
  });

  it("rejects invalid aadVersion", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(TEAM_ENTRY);
    mockAttachmentCount.mockResolvedValue(0);
    const fields = { ...validFormFields(), aadVersion: "2" };
    const req = createFormDataRequest(fields);
    const res = await POST(req, makeParams("o1", "e1"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("rejects upload when entry has no itemKeyVersion field", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    const entryWithoutItemKey = { teamId: "o1", teamKeyVersion: 1, tenantId: "t1" };
    mockEntryFindUnique.mockResolvedValue(entryWithoutItemKey);
    const req = createFormDataRequest(validFormFields());
    const res = await POST(req, makeParams("o1", "e1"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("ITEM_KEY_REQUIRED");
  });
});
