import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import { parseResponse } from "../../helpers/request-builder";

const {
  mockAuth,
  mockEntryFindUnique,
  mockAttachmentFindMany,
  mockAttachmentCount,
  mockAttachmentCreate,
  mockPutObject,
  mockDeleteObject,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockEntryFindUnique: vi.fn(),
  mockAttachmentFindMany: vi.fn(),
  mockAttachmentCount: vi.fn(),
  mockAttachmentCreate: vi.fn(),
  mockPutObject: vi.fn(),
  mockDeleteObject: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordEntry: { findUnique: mockEntryFindUnique },
    attachment: {
      findMany: mockAttachmentFindMany,
      count: mockAttachmentCount,
      create: mockAttachmentCreate,
    },
  },
}));
vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "Test" }),
}));
vi.mock("@/lib/with-request-log", () => ({
  withRequestLog: (fn: (...args: unknown[]) => unknown) => fn,
}));
vi.mock("@/lib/blob-store", () => ({
  getAttachmentBlobStore: () => ({
    putObject: mockPutObject,
    deleteObject: mockDeleteObject,
  }),
}));

import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/passwords/[id]/attachments/route";

function createParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

function createGetRequest() {
  return new NextRequest("http://localhost/api/passwords/e1/attachments", {
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
  return new NextRequest("http://localhost/api/passwords/e1/attachments", {
    method: "POST",
    body: formData,
    headers,
  });
}

function validFormFields(): Record<string, string | Blob> {
  return {
    file: new Blob(["hello"], { type: "application/octet-stream" }),
    iv: "a".repeat(24),
    authTag: "b".repeat(32),
    filename: "test.pdf",
    contentType: "application/pdf",
    sizeBytes: "100",
  };
}

describe("GET /api/passwords/[id]/attachments", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(createGetRequest(), createParams("e1"));
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 404 when entry not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockEntryFindUnique.mockResolvedValue(null);
    const res = await GET(createGetRequest(), createParams("e1"));
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it("returns 403 when entry belongs to another user", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockEntryFindUnique.mockResolvedValue({ userId: "other-user" });
    const res = await GET(createGetRequest(), createParams("e1"));
    const { status } = await parseResponse(res);
    expect(status).toBe(403);
  });

  it("returns attachments list", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockEntryFindUnique.mockResolvedValue({ userId: DEFAULT_SESSION.user.id });
    mockAttachmentFindMany.mockResolvedValue([
      { id: "a1", filename: "test.pdf", contentType: "application/pdf", sizeBytes: 100, createdAt: new Date() },
    ]);
    const res = await GET(createGetRequest(), createParams("e1"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json).toHaveLength(1);
    expect(json[0].filename).toBe("test.pdf");
  });
});

describe("POST /api/passwords/[id]/attachments", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const req = createFormDataRequest(validFormFields());
    const res = await POST(req, createParams("e1"));
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 404 when entry not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockEntryFindUnique.mockResolvedValue(null);
    const req = createFormDataRequest(validFormFields());
    const res = await POST(req, createParams("e1"));
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it("returns 403 when entry belongs to another user", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockEntryFindUnique.mockResolvedValue({ userId: "other-user" });
    const req = createFormDataRequest(validFormFields());
    const res = await POST(req, createParams("e1"));
    const { status } = await parseResponse(res);
    expect(status).toBe(403);
  });

  it("returns 400 when attachment limit exceeded", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockEntryFindUnique.mockResolvedValue({ userId: DEFAULT_SESSION.user.id });
    mockAttachmentCount.mockResolvedValue(20);
    const req = createFormDataRequest(validFormFields());
    const res = await POST(req, createParams("e1"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("ATTACHMENT_LIMIT_EXCEEDED");
  });

  it("returns 413 when content-length too large", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockEntryFindUnique.mockResolvedValue({ userId: DEFAULT_SESSION.user.id });
    mockAttachmentCount.mockResolvedValue(0);
    const req = createFormDataRequest(validFormFields(), {
      "content-length": String(100 * 1024 * 1024),
    });
    const res = await POST(req, createParams("e1"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(413);
    expect(json.error).toBe("PAYLOAD_TOO_LARGE");
  });

  it("returns 400 for invalid form data", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockEntryFindUnique.mockResolvedValue({ userId: DEFAULT_SESSION.user.id });
    mockAttachmentCount.mockResolvedValue(0);
    const req = new NextRequest("http://localhost/api/passwords/e1/attachments", {
      method: "POST",
      body: "not form data",
      headers: { "content-type": "text/plain" },
    });
    const res = await POST(req, createParams("e1"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("INVALID_FORM_DATA");
  });

  it("returns 400 when required fields are missing", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockEntryFindUnique.mockResolvedValue({ userId: DEFAULT_SESSION.user.id });
    mockAttachmentCount.mockResolvedValue(0);
    const req = createFormDataRequest({ file: new Blob(["x"]) });
    const res = await POST(req, createParams("e1"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("MISSING_REQUIRED_FIELDS");
  });

  it("returns 400 for invalid IV format", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockEntryFindUnique.mockResolvedValue({ userId: DEFAULT_SESSION.user.id });
    mockAttachmentCount.mockResolvedValue(0);
    const fields = validFormFields();
    fields.iv = "bad-iv";
    const req = createFormDataRequest(fields);
    const res = await POST(req, createParams("e1"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("INVALID_IV_FORMAT");
  });

  it("returns 400 for invalid authTag format", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockEntryFindUnique.mockResolvedValue({ userId: DEFAULT_SESSION.user.id });
    mockAttachmentCount.mockResolvedValue(0);
    const fields = validFormFields();
    fields.authTag = "bad-tag";
    const req = createFormDataRequest(fields);
    const res = await POST(req, createParams("e1"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("INVALID_AUTH_TAG_FORMAT");
  });

  it("returns 400 for extension not allowed", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockEntryFindUnique.mockResolvedValue({ userId: DEFAULT_SESSION.user.id });
    mockAttachmentCount.mockResolvedValue(0);
    const fields = validFormFields();
    fields.filename = "malware.exe";
    const req = createFormDataRequest(fields);
    const res = await POST(req, createParams("e1"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("EXTENSION_NOT_ALLOWED");
  });

  it("returns 400 for content type not allowed", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockEntryFindUnique.mockResolvedValue({ userId: DEFAULT_SESSION.user.id });
    mockAttachmentCount.mockResolvedValue(0);
    const fields = validFormFields();
    fields.contentType = "application/x-executable";
    const req = createFormDataRequest(fields);
    const res = await POST(req, createParams("e1"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("CONTENT_TYPE_NOT_ALLOWED");
  });

  it("returns 400 for filename with path traversal characters", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockEntryFindUnique.mockResolvedValue({ userId: DEFAULT_SESSION.user.id });
    mockAttachmentCount.mockResolvedValue(0);
    const fields = validFormFields();
    fields.filename = "../etc/passwd.pdf";
    const req = createFormDataRequest(fields);
    const res = await POST(req, createParams("e1"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("INVALID_FILENAME");
  });

  it("returns 400 for filename with CRLF characters", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockEntryFindUnique.mockResolvedValue({ userId: DEFAULT_SESSION.user.id });
    mockAttachmentCount.mockResolvedValue(0);
    const fields = validFormFields();
    fields.filename = "test\r\n.pdf";
    const req = createFormDataRequest(fields);
    const res = await POST(req, createParams("e1"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("INVALID_FILENAME");
  });

  it("returns 400 for Windows reserved device name", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockEntryFindUnique.mockResolvedValue({ userId: DEFAULT_SESSION.user.id });
    mockAttachmentCount.mockResolvedValue(0);
    const fields = validFormFields();
    fields.filename = "CON.pdf";
    const req = createFormDataRequest(fields);
    const res = await POST(req, createParams("e1"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("INVALID_FILENAME");
  });

  it("uploads attachment successfully", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockEntryFindUnique.mockResolvedValue({ userId: DEFAULT_SESSION.user.id });
    mockAttachmentCount.mockResolvedValue(0);
    mockPutObject.mockResolvedValue(Buffer.from("stored"));
    const created = {
      id: "a1",
      filename: "test.pdf",
      contentType: "application/pdf",
      sizeBytes: 100,
      createdAt: new Date(),
    };
    mockAttachmentCreate.mockResolvedValue(created);
    const req = createFormDataRequest(validFormFields());
    const res = await POST(req, createParams("e1"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(201);
    expect(json.filename).toBe("test.pdf");
  });
});
