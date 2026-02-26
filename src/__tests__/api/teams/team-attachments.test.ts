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
  mockTeamFindUnique,
  mockPutObject,
  mockDeleteObject,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTeamPermission: vi.fn(),
  mockEntryFindUnique: vi.fn(),
  mockAttachmentFindMany: vi.fn(),
  mockAttachmentCount: vi.fn(),
  mockAttachmentCreate: vi.fn(),
  mockTeamFindUnique: vi.fn(),
  mockPutObject: vi.fn(),
  mockDeleteObject: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/team-auth", () => {
  class TeamAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return { requireTeamPermission: mockRequireTeamPermission, TeamAuthError };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    orgPasswordEntry: { findUnique: mockEntryFindUnique },
    attachment: {
      findMany: mockAttachmentFindMany,
      count: mockAttachmentCount,
      create: mockAttachmentCreate,
    },
    organization: { findUnique: mockTeamFindUnique },
  },
}));
vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "Test" }),
}));
vi.mock("@/lib/blob-store", () => ({
  getAttachmentBlobStore: () => ({
    putObject: mockPutObject,
    deleteObject: mockDeleteObject,
  }),
}));

import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/teams/[teamId]/passwords/[id]/attachments/route";
import { TeamAuthError } from "@/lib/team-auth";

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
  };
}

const TEAM_ENTRY = { orgId: "o1" };

describe("GET /api/teams/[teamId]/passwords/[id]/attachments", () => {
  beforeEach(() => vi.clearAllMocks());

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
    mockEntryFindUnique.mockResolvedValue({ orgId: "other-team" });
    const res = await GET(createGetRequest(), makeParams("o1", "e1"));
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it("returns attachments list", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue({ orgId: "o1" });
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
  beforeEach(() => vi.clearAllMocks());

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

  it("uploads client-encrypted attachment successfully", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(TEAM_ENTRY);
    mockAttachmentCount.mockResolvedValue(0);
    mockTeamFindUnique.mockResolvedValue({ orgKeyVersion: 1 });
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
        }),
      }),
    );
  });
});
