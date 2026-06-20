import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import { parseResponse } from "../../helpers/request-builder";

const {
  mockAuth,
  mockEntryFindUnique,
  mockAttachmentFindMany,
  mockAttachmentCount,
  mockAttachmentCreate,
  mockUserFindUnique,
  mockTransaction,
  mockExecuteRaw,
  mockPutObject,
  mockDeleteObject,
  mockWithUserTenantRls,
  mockRateLimitCheck,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockEntryFindUnique: vi.fn(),
  mockAttachmentFindMany: vi.fn(),
  mockAttachmentCount: vi.fn(),
  mockAttachmentCreate: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockTransaction: vi.fn(),
  mockExecuteRaw: vi.fn(),
  mockPutObject: vi.fn(),
  mockDeleteObject: vi.fn(),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
  mockRateLimitCheck: vi.fn(),
}));

// Tx mock — upload now wraps user.findUnique + attachment.create in a tx.
const txMock = {
  $executeRaw: mockExecuteRaw,
  user: { findUnique: mockUserFindUnique },
  attachment: { create: mockAttachmentCreate },
};

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/security/rate-limit", () => ({ createRateLimiter: vi.fn(() => ({ check: mockRateLimitCheck, clear: vi.fn() })) }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordEntry: { findUnique: mockEntryFindUnique },
    attachment: {
      findMany: mockAttachmentFindMany,
      count: mockAttachmentCount,
      create: mockAttachmentCreate,
    },
    user: { findUnique: mockUserFindUnique },
    $transaction: mockTransaction,
  },
}));
vi.mock("@/lib/vault/rotate-key-server", () => {
  class LegacyAttachmentInconsistentVersionError extends Error {
    constructor() {
      super("ATTACHMENT_INCONSISTENT_VERSION");
      this.name = "LegacyAttachmentInconsistentVersionError";
    }
  }
  return { LegacyAttachmentInconsistentVersionError };
});
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: vi.fn(),
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "Test" }),
  personalAuditBase: vi.fn((_, userId) => ({ scope: "PERSONAL", userId })),
}));
vi.mock("@/lib/http/with-request-log", () => ({
  withRequestLog: (fn: (...args: unknown[]) => unknown) => fn,
}));
vi.mock("@/lib/blob-store", () => ({
  getAttachmentBlobStore: () => ({
    putObject: mockPutObject,
    deleteObject: mockDeleteObject,
  }),
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));

vi.mock("@/lib/quota/resource-quotas", () => ({
  assertQuotaAvailable: vi.fn().mockResolvedValue(undefined),
  QuotaExceededError: class extends Error {},
}));

import { NextRequest } from "next/server";
vi.mock("@/lib/quota/resource-quotas", () => ({
  assertQuotaAvailable: vi.fn().mockResolvedValue(undefined),
  QuotaExceededError: class extends Error {},
}));

import { GET, POST } from "@/app/api/passwords/[id]/attachments/route";

vi.mock("@/lib/quota/resource-quotas", () => ({
  assertQuotaAvailable: vi.fn().mockResolvedValue(undefined),
  QuotaExceededError: class extends Error {},
}));

function createParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

vi.mock("@/lib/quota/resource-quotas", () => ({
  assertQuotaAvailable: vi.fn().mockResolvedValue(undefined),
  QuotaExceededError: class extends Error {},
}));

function createGetRequest() {
  return new NextRequest("http://localhost/api/passwords/e1/attachments", {
    method: "GET",
  });
}

vi.mock("@/lib/quota/resource-quotas", () => ({
  assertQuotaAvailable: vi.fn().mockResolvedValue(undefined),
  QuotaExceededError: class extends Error {},
}));

async function createFormDataRequest(
  fields: Record<string, string | Blob>,
  headers: Record<string, string> = {},
) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.append(key, value);
  }
  // Serialize once to set Content-Length, mirroring a real browser upload —
  // the route gates on it via rejectOversizedMultipart (fail-closed if absent).
  // An explicit `headers` override (e.g. a too-large content-length test) wins.
  const encoded = new Request("http://localhost", { method: "POST", body: formData });
  const bytes = new Uint8Array(await encoded.arrayBuffer());
  return new NextRequest("http://localhost/api/passwords/e1/attachments", {
    method: "POST",
    body: bytes,
    headers: {
      "content-type": encoded.headers.get("content-type") ?? "multipart/form-data",
      "content-length": String(bytes.length),
      ...headers,
    },
  });
}

vi.mock("@/lib/quota/resource-quotas", () => ({
  assertQuotaAvailable: vi.fn().mockResolvedValue(undefined),
  QuotaExceededError: class extends Error {},
}));

function validFormFields(): Record<string, string | Blob> {
  return {
    file: new Blob(["hello"], { type: "application/octet-stream" }),
    iv: "a".repeat(24),
    authTag: "b".repeat(32),
    filename: "test.pdf",
    contentType: "application/pdf",
    sizeBytes: "100",
    // Mode-2 CEK fields required since Phase B (B2)
    cekEncrypted: "Y2Vr",  // base64 of "cek"
    cekIv: "a".repeat(24),
    cekAuthTag: "b".repeat(32),
    cekKeyVersion: "1",
    cekWrapAadVersion: "1",
  };
}

vi.mock("@/lib/quota/resource-quotas", () => ({
  assertQuotaAvailable: vi.fn().mockResolvedValue(undefined),
  QuotaExceededError: class extends Error {},
}));

describe("GET /api/passwords/[id]/attachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
  });

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

  it("returns 404 when entry belongs to another user (A01-4: no existence oracle)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockEntryFindUnique.mockResolvedValue({ userId: "other-user" });
    const res = await GET(createGetRequest(), createParams("e1"));
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
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

vi.mock("@/lib/quota/resource-quotas", () => ({
  assertQuotaAvailable: vi.fn().mockResolvedValue(undefined),
  QuotaExceededError: class extends Error {},
}));

describe("POST /api/passwords/[id]/attachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
    // Default current user keyVersion — matches the "1" in validFormFields().
    // Tests that exercise the upload happy path rely on this match; tests
    // exercising the keyVersion-mismatch case override per call.
    mockUserFindUnique.mockResolvedValue({ keyVersion: 1 });
    // Wire the tx callback so user.findUnique + attachment.create resolve
    // through the same mocks they used pre-tx.
    mockTransaction.mockImplementation(async (fn: (tx: typeof txMock) => unknown) => fn(txMock));
    mockExecuteRaw.mockResolvedValue(undefined);
    // deleteObject must return a Promise — the route's tx-failure cleanup
    // calls `.catch()` on its return value.
    mockDeleteObject.mockResolvedValue(undefined);
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const req = await createFormDataRequest(validFormFields());
    const res = await POST(req, createParams("e1"));
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 404 when entry not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockEntryFindUnique.mockResolvedValue(null);
    const req = await createFormDataRequest(validFormFields());
    const res = await POST(req, createParams("e1"));
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it("returns 404 when entry belongs to another user (A01-4: no existence oracle)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockEntryFindUnique.mockResolvedValue({ userId: "other-user" });
    const req = await createFormDataRequest(validFormFields());
    const res = await POST(req, createParams("e1"));
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it("returns 400 when attachment limit exceeded", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockEntryFindUnique.mockResolvedValue({ userId: DEFAULT_SESSION.user.id });
    mockAttachmentCount.mockResolvedValue(20);
    const req = await createFormDataRequest(validFormFields());
    const res = await POST(req, createParams("e1"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("ATTACHMENT_LIMIT_EXCEEDED");
  });

  it("returns 413 when content-length too large", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockEntryFindUnique.mockResolvedValue({ userId: DEFAULT_SESSION.user.id });
    mockAttachmentCount.mockResolvedValue(0);
    const req = await createFormDataRequest(validFormFields(), {
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
    const body = "not form data";
    const req = new NextRequest("http://localhost/api/passwords/e1/attachments", {
      method: "POST",
      body,
      // Valid content-length so the multipart size gate passes and we reach
      // formData() — this test exercises the parse-failure path specifically.
      headers: {
        "content-type": "text/plain",
        "content-length": String(Buffer.byteLength(body)),
      },
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
    const req = await createFormDataRequest({ file: new Blob(["x"]) });
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
    const req = await createFormDataRequest(fields);
    const res = await POST(req, createParams("e1"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("INVALID_ENCRYPTION_FORMAT");
  });

  it("returns 400 for invalid authTag format", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockEntryFindUnique.mockResolvedValue({ userId: DEFAULT_SESSION.user.id });
    mockAttachmentCount.mockResolvedValue(0);
    const fields = validFormFields();
    fields.authTag = "bad-tag";
    const req = await createFormDataRequest(fields);
    const res = await POST(req, createParams("e1"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("INVALID_ENCRYPTION_FORMAT");
  });

  it("returns 400 for extension not allowed", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockEntryFindUnique.mockResolvedValue({ userId: DEFAULT_SESSION.user.id });
    mockAttachmentCount.mockResolvedValue(0);
    const fields = validFormFields();
    fields.filename = "malware.exe";
    const req = await createFormDataRequest(fields);
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
    const req = await createFormDataRequest(fields);
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
    const req = await createFormDataRequest(fields);
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
    const req = await createFormDataRequest(fields);
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
    const req = await createFormDataRequest(fields);
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
    const req = await createFormDataRequest(validFormFields());
    const res = await POST(req, createParams("e1"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(201);
    expect(json.filename).toBe("test.pdf");
  });

  it("rejects upload with malformed base64 in cekEncrypted (R19 mirror of route.test.ts) → 400", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockEntryFindUnique.mockResolvedValue({ userId: DEFAULT_SESSION.user.id });
    mockAttachmentCount.mockResolvedValue(0);
    const fields = { ...validFormFields(), cekEncrypted: "Y2V-" };
    const req = await createFormDataRequest(fields);
    const res = await POST(req, createParams("e1"));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
    expect(mockAttachmentCreate).not.toHaveBeenCalled();
  });

  it("normalizes uppercase UUID clientId to lowercase for AAD consistency", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockEntryFindUnique.mockResolvedValue({ userId: DEFAULT_SESSION.user.id });
    mockAttachmentCount.mockResolvedValue(0);
    mockPutObject.mockResolvedValue(Buffer.from("stored"));
    const uppercaseId = "550E8400-E29B-41D4-A716-446655440000";
    const created = {
      id: uppercaseId.toLowerCase(),
      filename: "test.pdf",
      contentType: "application/pdf",
      sizeBytes: 100,
      createdAt: new Date(),
    };
    mockAttachmentCreate.mockResolvedValue(created);
    const fields = { ...validFormFields(), id: uppercaseId };
    const req = await createFormDataRequest(fields);
    const res = await POST(req, createParams("e1"));
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
});
