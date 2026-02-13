import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockAuth,
  mockRequireOrgPermission,
  mockPrismaOrgPasswordEntry,
  mockPrismaAttachment,
  mockEncryptServerBinary,
  MockOrgAuthError,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireOrgPermission: vi.fn(),
  mockPrismaOrgPasswordEntry: {
    findUnique: vi.fn(),
  },
  mockPrismaAttachment: {
    findMany: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
  },
  mockEncryptServerBinary: vi.fn(),
  MockOrgAuthError: class MockOrgAuthError extends Error {
    status: number;
    constructor(message: string, status = 403) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/org-auth", () => ({
  requireOrgPermission: mockRequireOrgPermission,
  OrgAuthError: MockOrgAuthError,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    orgPasswordEntry: mockPrismaOrgPasswordEntry,
    attachment: mockPrismaAttachment,
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));
vi.mock("@/lib/crypto-server", () => ({
  unwrapOrgKey: vi.fn(() => new Uint8Array([1, 2, 3])),
  encryptServerBinary: mockEncryptServerBinary,
}));
vi.mock("@/lib/crypto-aad", () => ({
  buildAttachmentAAD: vi.fn(() => "aad"),
  AAD_VERSION: 1,
}));

import { GET, POST } from "./route";

function createParams(orgId: string, id: string) {
  return { params: Promise.resolve({ orgId, id }) };
}

function createRequest(method: string, url: string) {
  return new NextRequest(url, { method });
}

function createFormDataRequest(
  url: string,
  fields: Record<string, string | Blob>,
  headers?: Record<string, string>
): NextRequest {
  const formData = new FormData();
  for (const [k, v] of Object.entries(fields)) formData.append(k, v);
  return new NextRequest(url, { method: "POST", body: formData, headers });
}

describe("GET /api/orgs/[orgId]/passwords/[id]/attachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireOrgPermission.mockResolvedValue(undefined);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", "http://localhost/api/orgs/org-1/passwords/pw-1/attachments"),
      createParams("org-1", "pw-1"),
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when entry does not belong to org", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      orgId: "other-org",
    });
    const res = await GET(
      createRequest("GET", "http://localhost/api/orgs/org-1/passwords/pw-1/attachments"),
      createParams("org-1", "pw-1"),
    );
    expect(res.status).toBe(404);
  });

  it("returns org auth error when permission denied", async () => {
    mockRequireOrgPermission.mockRejectedValue(
      new MockOrgAuthError("FORBIDDEN", 403),
    );
    const res = await GET(
      createRequest("GET", "http://localhost/api/orgs/org-1/passwords/pw-1/attachments"),
      createParams("org-1", "pw-1"),
    );
    const json = await res.json();
    expect(res.status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
  });

  it("returns attachment metadata list", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({ orgId: "org-1" });
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
      createRequest("GET", "http://localhost/api/orgs/org-1/passwords/pw-1/attachments"),
      createParams("org-1", "pw-1"),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toHaveLength(1);
    expect(json[0].filename).toBe("doc.pdf");
  });
});

describe("POST /api/orgs/[orgId]/passwords/[id]/attachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireOrgPermission.mockResolvedValue(undefined);
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      orgId: "org-1",
      org: {
        encryptedOrgKey: "aa",
        orgKeyIv: "bb",
        orgKeyAuthTag: "cc",
      },
    });
    mockPrismaAttachment.count.mockResolvedValue(0);
    mockEncryptServerBinary.mockReturnValue({
      ciphertext: new Uint8Array([9, 8, 7]),
      iv: "a".repeat(24),
      authTag: "b".repeat(32),
    });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createFormDataRequest("http://localhost/api/orgs/org-1/passwords/pw-1/attachments", {
        file: new Blob(["abc"]),
        filename: "doc.pdf",
        contentType: "application/pdf",
      }),
      createParams("org-1", "pw-1"),
    );
    expect(res.status).toBe(401);
  });

  it("returns org auth error when update permission denied", async () => {
    mockRequireOrgPermission.mockRejectedValue(
      new MockOrgAuthError("FORBIDDEN", 403),
    );
    const res = await POST(
      createFormDataRequest("http://localhost/api/orgs/org-1/passwords/pw-1/attachments", {
        file: new Blob(["abc"]),
        filename: "doc.pdf",
        contentType: "application/pdf",
      }),
      createParams("org-1", "pw-1"),
    );
    const json = await res.json();
    expect(res.status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
  });

  it("returns 404 when entry does not belong to org", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({ orgId: "other-org" });
    const res = await POST(
      createFormDataRequest("http://localhost/api/orgs/org-1/passwords/pw-1/attachments", {
        file: new Blob(["abc"]),
        filename: "doc.pdf",
        contentType: "application/pdf",
      }),
      createParams("org-1", "pw-1"),
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await POST(
      createFormDataRequest("http://localhost/api/orgs/org-1/passwords/pw-1/attachments", {
        filename: "doc.pdf",
      }),
      createParams("org-1", "pw-1"),
    );
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error).toBe("MISSING_REQUIRED_FIELDS");
  });

  it("returns 400 when content type is not allowed", async () => {
    const res = await POST(
      createFormDataRequest("http://localhost/api/orgs/org-1/passwords/pw-1/attachments", {
        file: new Blob(["abc"]),
        filename: "doc.pdf",
        contentType: "application/zip",
      }),
      createParams("org-1", "pw-1"),
    );
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error).toBe("CONTENT_TYPE_NOT_ALLOWED");
  });

  it("returns 400 when attachment limit is exceeded", async () => {
    mockPrismaAttachment.count.mockResolvedValue(20);
    const res = await POST(
      createFormDataRequest("http://localhost/api/orgs/org-1/passwords/pw-1/attachments", {
        file: new Blob(["abc"]),
        filename: "doc.pdf",
        contentType: "application/pdf",
      }),
      createParams("org-1", "pw-1"),
    );
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error).toBe("ATTACHMENT_LIMIT_EXCEEDED");
  });

  it("returns 413 when declared content-length is too large", async () => {
    const res = await POST(
      createFormDataRequest(
        "http://localhost/api/orgs/org-1/passwords/pw-1/attachments",
        {
          file: new Blob(["abc"]),
          filename: "doc.pdf",
          contentType: "application/pdf",
        },
        { "content-length": String(30 * 1024 * 1024) },
      ),
      createParams("org-1", "pw-1"),
    );
    const json = await res.json();
    expect(res.status).toBe(413);
    expect(json.error).toBe("PAYLOAD_TOO_LARGE");
  });

  it("returns 400 when actual file size exceeds max", async () => {
    const huge = new Blob([new Uint8Array(11 * 1024 * 1024)]);
    const res = await POST(
      createFormDataRequest("http://localhost/api/orgs/org-1/passwords/pw-1/attachments", {
        file: huge,
        filename: "doc.pdf",
        contentType: "application/pdf",
      }),
      createParams("org-1", "pw-1"),
    );
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error).toBe("FILE_TOO_LARGE");
  });

  it("returns 400 when formData parsing fails", async () => {
    const req = {
      headers: new Headers(),
      formData: vi.fn().mockRejectedValue(new Error("bad form")),
    } as unknown as NextRequest;
    const res = await POST(req, createParams("org-1", "pw-1"));
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error).toBe("INVALID_FORM_DATA");
  });

  it("returns 400 for invalid extension", async () => {
    const res = await POST(
      createFormDataRequest("http://localhost/api/orgs/org-1/passwords/pw-1/attachments", {
        file: new Blob(["abc"]),
        filename: "bad.exe",
        contentType: "application/pdf",
      }),
      createParams("org-1", "pw-1"),
    );
    expect(res.status).toBe(400);
  });

  it("creates attachment with blob-store data", async () => {
    mockPrismaAttachment.create.mockResolvedValue({
      id: "att-1",
      filename: "doc.pdf",
      contentType: "application/pdf",
      sizeBytes: 3,
      createdAt: new Date(),
    });
    const res = await POST(
      createFormDataRequest("http://localhost/api/orgs/org-1/passwords/pw-1/attachments", {
        file: new Blob(["abc"]),
        filename: "doc.pdf",
        contentType: "application/pdf",
      }),
      createParams("org-1", "pw-1"),
    );
    expect(res.status).toBe(201);
    expect(mockPrismaAttachment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          encryptedData: expect.any(Uint8Array),
        }),
      }),
    );
  });
});
