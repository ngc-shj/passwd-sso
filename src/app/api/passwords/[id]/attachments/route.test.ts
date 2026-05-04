import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { AAD_VERSION } from "@/lib/crypto/crypto-aad";

const { mockAuth, mockPrismaPasswordEntry, mockPrismaAttachment, mockPrismaUser, mockWithUserTenantRls, mockRateLimitCheck, mockPutObject, mockDeleteObject } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaPasswordEntry: {
    findUnique: vi.fn(),
  },
  mockPrismaAttachment: {
    findMany: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
  },
  mockPrismaUser: {
    findUnique: vi.fn(),
  },
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
  mockRateLimitCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockPutObject: vi.fn(),
  mockDeleteObject: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: vi.fn().mockReturnValue({ check: mockRateLimitCheck, clear: vi.fn() }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordEntry: mockPrismaPasswordEntry,
    attachment: mockPrismaAttachment,
    user: mockPrismaUser,
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/blob-store", () => ({
  getAttachmentBlobStore: () => ({
    putObject: mockPutObject,
    deleteObject: mockDeleteObject,
  }),
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: vi.fn(),
  extractRequestMeta: () => ({ ip: "127.0.0.1" }),
  personalAuditBase: vi.fn((_, userId) => ({ scope: "PERSONAL", userId })),
}));
vi.mock("@/lib/http/with-request-log", () => ({
  withRequestLog: (fn: (...args: unknown[]) => unknown) => fn,
}));

import { GET, POST } from "./route";

function createParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

function createGetRequest(url: string) {
  return new NextRequest(url);
}

function createFormDataRequest(
  url: string,
  fields: Record<string, string | Blob>
): NextRequest {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.append(key, value);
  }
  return new NextRequest(url, {
    method: "POST",
    body: formData,
  });
}

// Mode-2 CEK fields required for all uploads
function validCekFields(): Record<string, string> {
  return {
    cekEncrypted: "Y2Vr", // base64 of "cek"
    cekIv: "a".repeat(24),
    cekAuthTag: "b".repeat(32),
    cekKeyVersion: "1",
    cekWrapAadVersion: "1",
  };
}

const now = new Date("2025-01-01T00:00:00Z");

describe("GET /api/passwords/[id]/attachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(
      createGetRequest("http://localhost:3000/api/passwords/pw-1/attachments"),
      createParams("pw-1")
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when entry not found", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(null);
    const res = await GET(
      createGetRequest("http://localhost:3000/api/passwords/pw-1/attachments"),
      createParams("pw-1")
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 when entry belongs to another user", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue({ userId: "other-user" });
    const res = await GET(
      createGetRequest("http://localhost:3000/api/passwords/pw-1/attachments"),
      createParams("pw-1")
    );
    expect(res.status).toBe(403);
  });

  it("returns attachment list", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue({ userId: "user-1" });
    mockPrismaAttachment.findMany.mockResolvedValue([
      {
        id: "att-1",
        filename: "test.pdf",
        contentType: "application/pdf",
        sizeBytes: 1024,
        createdAt: now,
      },
    ]);

    const res = await GET(
      createGetRequest("http://localhost:3000/api/passwords/pw-1/attachments"),
      createParams("pw-1")
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toHaveLength(1);
    expect(json[0].filename).toBe("test.pdf");
    expect(json[0].sizeBytes).toBe(1024);
  });
});

describe("POST /api/passwords/[id]/attachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockPrismaPasswordEntry.findUnique.mockResolvedValue({ userId: "user-1", tenantId: "tenant-1" });
    mockPrismaAttachment.count.mockResolvedValue(0);
    // Default current user keyVersion — matches `validCekFields().cekKeyVersion = "1"`
    mockPrismaUser.findUnique.mockResolvedValue({ keyVersion: 1 });
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
    mockPutObject.mockResolvedValue(Buffer.from("stored-bytes"));
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createFormDataRequest("http://localhost:3000/api/passwords/pw-1/attachments", {
        file: new Blob(["data"]),
        iv: "a".repeat(24),
        authTag: "b".repeat(32),
        filename: "test.pdf",
        contentType: "application/pdf",
        sizeBytes: "100",
        ...validCekFields(),
      }),
      createParams("pw-1")
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 when attachment limit reached", async () => {
    mockPrismaAttachment.count.mockResolvedValue(20);
    const res = await POST(
      createFormDataRequest("http://localhost:3000/api/passwords/pw-1/attachments", {
        file: new Blob(["data"]),
        iv: "a".repeat(24),
        authTag: "b".repeat(32),
        filename: "test.pdf",
        contentType: "application/pdf",
        sizeBytes: "100",
        ...validCekFields(),
      }),
      createParams("pw-1")
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("ATTACHMENT_LIMIT_EXCEEDED");
  });

  it("returns 400 for invalid extension (EXTENSION_NOT_ALLOWED)", async () => {
    const res = await POST(
      createFormDataRequest("http://localhost:3000/api/passwords/pw-1/attachments", {
        file: new Blob(["data"]),
        iv: "a".repeat(24),
        authTag: "b".repeat(32),
        filename: "test.exe",
        contentType: "application/pdf",
        sizeBytes: "100",
        ...validCekFields(),
      }),
      createParams("pw-1")
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("EXTENSION_NOT_ALLOWED");
  });

  it("returns 400 for file too large (FILE_TOO_LARGE)", async () => {
    const res = await POST(
      createFormDataRequest("http://localhost:3000/api/passwords/pw-1/attachments", {
        file: new Blob(["data"]),
        iv: "a".repeat(24),
        authTag: "b".repeat(32),
        filename: "test.pdf",
        contentType: "application/pdf",
        sizeBytes: String(11 * 1024 * 1024), // 11MB
        ...validCekFields(),
      }),
      createParams("pw-1")
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("FILE_TOO_LARGE");
  });

  it("returns 400 for invalid content type (CONTENT_TYPE_NOT_ALLOWED)", async () => {
    const res = await POST(
      createFormDataRequest("http://localhost:3000/api/passwords/pw-1/attachments", {
        file: new Blob(["data"]),
        iv: "a".repeat(24),
        authTag: "b".repeat(32),
        filename: "test.pdf",
        contentType: "application/zip",
        sizeBytes: "100",
        ...validCekFields(),
      }),
      createParams("pw-1")
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("CONTENT_TYPE_NOT_ALLOWED");
  });

  it("returns 400 for invalid iv format (INVALID_IV_FORMAT)", async () => {
    const res = await POST(
      createFormDataRequest("http://localhost:3000/api/passwords/pw-1/attachments", {
        file: new Blob(["data"]),
        iv: "short",
        authTag: "b".repeat(32),
        filename: "test.pdf",
        contentType: "application/pdf",
        sizeBytes: "100",
        ...validCekFields(),
      }),
      createParams("pw-1")
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("INVALID_IV_FORMAT");
  });

  // ── B2: mode-2 CEK required ───────────────────────────────────────────

  it("rejects upload missing cekEncrypted → 400 INVALID_REQUEST", async () => {
    // No CEK fields at all
    const res = await POST(
      createFormDataRequest("http://localhost:3000/api/passwords/pw-1/attachments", {
        file: new Blob(["data"]),
        iv: "a".repeat(24),
        authTag: "b".repeat(32),
        filename: "test.pdf",
        contentType: "application/pdf",
        sizeBytes: "100",
      }),
      createParams("pw-1")
    );
    expect(res.status).toBe(400);
  });

  it("uploads with full mode-2 CEK fields → 201, row has encryptionMode: 2", async () => {
    const clientId = "550e8400-e29b-41d4-a716-446655440099";
    mockPrismaAttachment.create.mockResolvedValue({
      id: clientId,
      filename: "test.pdf",
      contentType: "application/pdf",
      sizeBytes: 100,
      createdAt: now,
    });

    const res = await POST(
      createFormDataRequest("http://localhost:3000/api/passwords/pw-1/attachments", {
        id: clientId,
        file: new Blob(["encrypted-data"]),
        iv: "a".repeat(24),
        authTag: "b".repeat(32),
        filename: "test.pdf",
        contentType: "application/pdf",
        sizeBytes: "100",
        aadVersion: "1",
        ...validCekFields(),
      }),
      createParams("pw-1")
    );
    expect(res.status).toBe(201);
    expect(mockPrismaAttachment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          encryptionMode: 2,
          cekIv: "a".repeat(24),
          cekAuthTag: "b".repeat(32),
          cekKeyVersion: 1,
          cekWrapAadVersion: 1,
        }),
      }),
    );
  });

  it("request keyVersion field is ignored — server unconditionally sets encryptionMode: 2", async () => {
    const clientId = "550e8400-e29b-41d4-a716-446655440098";
    mockPrismaAttachment.create.mockResolvedValue({
      id: clientId,
      filename: "test.pdf",
      contentType: "application/pdf",
      sizeBytes: 100,
      createdAt: now,
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await POST(
      createFormDataRequest("http://localhost:3000/api/passwords/pw-1/attachments", {
        id: clientId,
        file: new Blob(["encrypted-data"]),
        iv: "a".repeat(24),
        authTag: "b".repeat(32),
        filename: "test.pdf",
        contentType: "application/pdf",
        sizeBytes: "100",
        keyVersion: "99", // ignored per I3.3
        ...validCekFields(),
      }),
      createParams("pw-1")
    );
    expect(res.status).toBe(201);
    // Server must set encryptionMode: 2 regardless of submitted keyVersion
    expect(mockPrismaAttachment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ encryptionMode: 2 }),
      }),
    );
    // keyVersion must NOT appear in the persisted data (server omits it)
    const createCall = mockPrismaAttachment.create.mock.calls[0][0];
    expect(createCall.data).not.toHaveProperty("keyVersion");
    // Warning log should fire when keyVersion is submitted
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("stores client-generated id and aadVersion from FormData", async () => {
    const clientId = "550e8400-e29b-41d4-a716-446655440000";
    mockPrismaAttachment.create.mockResolvedValue({
      id: clientId,
      filename: "test.pdf",
      contentType: "application/pdf",
      sizeBytes: 100,
      createdAt: now,
    });

    const res = await POST(
      createFormDataRequest("http://localhost:3000/api/passwords/pw-1/attachments", {
        id: clientId,
        file: new Blob(["encrypted-data"]),
        iv: "a".repeat(24),
        authTag: "b".repeat(32),
        filename: "test.pdf",
        contentType: "application/pdf",
        sizeBytes: "100",
        aadVersion: "1",
        ...validCekFields(),
      }),
      createParams("pw-1")
    );
    expect(res.status).toBe(201);
    expect(mockPrismaAttachment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          id: clientId,
          aadVersion: 1,
        }),
      }),
    );
  });

  it("returns 400 when actual file blob exceeds MAX_FILE_SIZE", async () => {
    const hugeBlob = new Blob([new Uint8Array(11 * 1024 * 1024)]); // 11MB
    const res = await POST(
      createFormDataRequest("http://localhost:3000/api/passwords/pw-1/attachments", {
        file: hugeBlob,
        iv: "a".repeat(24),
        authTag: "b".repeat(32),
        filename: "test.pdf",
        contentType: "application/pdf",
        sizeBytes: "100",
        ...validCekFields(),
      }),
      createParams("pw-1")
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("FILE_TOO_LARGE");
  });

  it("returns 413 when Content-Length exceeds 2x MAX_FILE_SIZE", async () => {
    const req = new NextRequest(
      "http://localhost:3000/api/passwords/pw-1/attachments",
      {
        method: "POST",
        headers: { "content-length": String(30 * 1024 * 1024) },
      }
    );
    const res = await POST(req, createParams("pw-1"));
    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json.error).toBe("PAYLOAD_TOO_LARGE");
  });

  it("defaults aadVersion to AAD_VERSION when not provided", async () => {
    mockPrismaAttachment.create.mockResolvedValue({
      id: "att-legacy",
      filename: "test.pdf",
      contentType: "application/pdf",
      sizeBytes: 100,
      createdAt: now,
    });

    await POST(
      createFormDataRequest("http://localhost:3000/api/passwords/pw-1/attachments", {
        file: new Blob(["encrypted-data"]),
        iv: "a".repeat(24),
        authTag: "b".repeat(32),
        filename: "test.pdf",
        contentType: "application/pdf",
        sizeBytes: "100",
        ...validCekFields(),
      }),
      createParams("pw-1")
    );
    expect(mockPrismaAttachment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          aadVersion: AAD_VERSION,
        }),
      }),
    );
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimitCheck.mockResolvedValueOnce({ allowed: false, retryAfterMs: 30_000 });
    const res = await POST(
      createFormDataRequest("http://localhost:3000/api/passwords/pw-1/attachments", {
        file: new Blob(["data"]),
        iv: "a".repeat(24),
        authTag: "b".repeat(32),
        filename: "test.pdf",
        contentType: "application/pdf",
        sizeBytes: "100",
        ...validCekFields(),
      }),
      createParams("pw-1")
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
  });

  it("falls back to server-generated UUID when clientId is not a valid UUID", async () => {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    mockPrismaAttachment.create.mockImplementation(async (args: { data: { id: string } }) =>
      ({
        id: args.data.id,
        filename: "test.pdf",
        contentType: "application/pdf",
        sizeBytes: 100,
        createdAt: now,
      })
    );

    const res = await POST(
      createFormDataRequest("http://localhost:3000/api/passwords/pw-1/attachments", {
        id: "../../../etc/passwd",
        file: new Blob(["encrypted-data"]),
        iv: "a".repeat(24),
        authTag: "b".repeat(32),
        filename: "test.pdf",
        contentType: "application/pdf",
        sizeBytes: "100",
        ...validCekFields(),
      }),
      createParams("pw-1")
    );
    expect(res.status).toBe(201);
    const [[callArgs]] = mockPrismaAttachment.create.mock.calls;
    const usedId = callArgs.data.id;
    expect(usedId).not.toBe("../../../etc/passwd");
    expect(UUID_RE.test(usedId)).toBe(true);
  });

  it("uses valid client-supplied UUID when provided", async () => {
    const clientId = "550e8400-e29b-41d4-a716-446655440000";
    mockPrismaAttachment.create.mockResolvedValue({
      id: clientId,
      filename: "test.pdf",
      contentType: "application/pdf",
      sizeBytes: 100,
      createdAt: now,
    });

    const res = await POST(
      createFormDataRequest("http://localhost:3000/api/passwords/pw-1/attachments", {
        id: clientId,
        file: new Blob(["encrypted-data"]),
        iv: "a".repeat(24),
        authTag: "b".repeat(32),
        filename: "test.pdf",
        contentType: "application/pdf",
        sizeBytes: "100",
        ...validCekFields(),
      }),
      createParams("pw-1")
    );
    expect(res.status).toBe(201);
    expect(mockPrismaAttachment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          id: clientId,
        }),
      }),
    );
  });

  // Fix #2: server-side cekKeyVersion validation against user.keyVersion

  it("rejects upload when cekKeyVersion does not match user.keyVersion → 409 ATTACHMENT_INCONSISTENT_VERSION", async () => {
    // User has keyVersion 2 (e.g., a recent rotation in another tab),
    // but the client submits cekKeyVersion = 1.
    mockPrismaUser.findUnique.mockResolvedValueOnce({ keyVersion: 2 });

    const res = await POST(
      createFormDataRequest("http://localhost:3000/api/passwords/pw-1/attachments", {
        file: new Blob(["encrypted-data"]),
        iv: "a".repeat(24),
        authTag: "b".repeat(32),
        filename: "test.pdf",
        contentType: "application/pdf",
        sizeBytes: "100",
        ...validCekFields(),
      }),
      createParams("pw-1"),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("ATTACHMENT_INCONSISTENT_VERSION");
    // Must reject before persisting anything to the blob store / DB.
    expect(mockPutObject).not.toHaveBeenCalled();
    expect(mockPrismaAttachment.create).not.toHaveBeenCalled();
  });

  it("rejects upload when user record is missing → 404", async () => {
    mockPrismaUser.findUnique.mockResolvedValueOnce(null);

    const res = await POST(
      createFormDataRequest("http://localhost:3000/api/passwords/pw-1/attachments", {
        file: new Blob(["encrypted-data"]),
        iv: "a".repeat(24),
        authTag: "b".repeat(32),
        filename: "test.pdf",
        contentType: "application/pdf",
        sizeBytes: "100",
        ...validCekFields(),
      }),
      createParams("pw-1"),
    );
    expect(res.status).toBe(404);
    expect(mockPrismaAttachment.create).not.toHaveBeenCalled();
  });

  it("rejects upload with oversized cekEncrypted → 400 VALIDATION_ERROR", async () => {
    const longCek = "A".repeat(257);
    const res = await POST(
      createFormDataRequest("http://localhost:3000/api/passwords/pw-1/attachments", {
        file: new Blob(["encrypted-data"]),
        iv: "a".repeat(24),
        authTag: "b".repeat(32),
        filename: "test.pdf",
        contentType: "application/pdf",
        sizeBytes: "100",
        ...validCekFields(),
        cekEncrypted: longCek,
      }),
      createParams("pw-1"),
    );
    expect(res.status).toBe(400);
    expect(mockPrismaAttachment.create).not.toHaveBeenCalled();
  });
});
