import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import { createParams } from "../../helpers/request-builder";

const {
  mockAuth,
  mockRequireOrgPermission,
  mockEntryFindUnique,
  mockAttachmentFindUnique,
  mockAttachmentDelete,
  mockUnwrapOrgKey,
  mockDecryptServerBinary,
  mockGetObject,
  mockDeleteObject,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireOrgPermission: vi.fn(),
  mockEntryFindUnique: vi.fn(),
  mockAttachmentFindUnique: vi.fn(),
  mockAttachmentDelete: vi.fn(),
  mockUnwrapOrgKey: vi.fn(),
  mockDecryptServerBinary: vi.fn(),
  mockGetObject: vi.fn(),
  mockDeleteObject: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/org-auth", () => {
  class OrgAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return { requireOrgPermission: mockRequireOrgPermission, OrgAuthError };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    orgPasswordEntry: { findUnique: mockEntryFindUnique },
    attachment: {
      findUnique: mockAttachmentFindUnique,
      delete: mockAttachmentDelete,
    },
  },
}));
vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "Test" }),
}));
vi.mock("@/lib/crypto-server", () => ({
  unwrapOrgKey: mockUnwrapOrgKey,
  decryptServerBinary: mockDecryptServerBinary,
}));
vi.mock("@/lib/crypto-aad", () => ({
  buildAttachmentAAD: () => "test-aad",
  AAD_VERSION: 1,
}));
vi.mock("@/lib/blob-store", () => ({
  getAttachmentBlobStore: () => ({
    getObject: mockGetObject,
    deleteObject: mockDeleteObject,
  }),
}));

import { NextRequest } from "next/server";
import { GET, DELETE } from "@/app/api/orgs/[orgId]/passwords/[id]/attachments/[attachmentId]/route";
import { OrgAuthError } from "@/lib/org-auth";

function makeParams(orgId: string, id: string, attachmentId: string) {
  return createParams({ orgId, id, attachmentId });
}

function createGetRequest() {
  return new NextRequest(
    "http://localhost/api/orgs/o1/passwords/e1/attachments/a1",
    { method: "GET" },
  );
}

function createDeleteRequest() {
  return new NextRequest(
    "http://localhost/api/orgs/o1/passwords/e1/attachments/a1",
    { method: "DELETE" },
  );
}

const ORG_ENTRY = {
  orgId: "o1",
  org: {
    encryptedOrgKey: "enc-key",
    orgKeyIv: "iv",
    orgKeyAuthTag: "tag",
  },
};

const ATTACHMENT = {
  id: "a1",
  filename: "test.pdf",
  contentType: "application/pdf",
  sizeBytes: 100,
  iv: "a".repeat(24),
  authTag: "b".repeat(32),
  encryptedData: "blob-key",
  aadVersion: 1,
};

describe("GET /api/orgs/[orgId]/passwords/[id]/attachments/[attachmentId]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(createGetRequest(), makeParams("o1", "e1", "a1"));
    expect(res.status).toBe(401);
  });

  it("returns 403 when lacking permission", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireOrgPermission.mockRejectedValue(new OrgAuthError("FORBIDDEN", 403));
    const res = await GET(createGetRequest(), makeParams("o1", "e1", "a1"));
    expect(res.status).toBe(403);
  });

  it("returns 404 when entry not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireOrgPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(null);
    const res = await GET(createGetRequest(), makeParams("o1", "e1", "a1"));
    expect(res.status).toBe(404);
  });

  it("returns 404 when entry belongs to different org", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireOrgPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue({ orgId: "other-org", org: ORG_ENTRY.org });
    const res = await GET(createGetRequest(), makeParams("o1", "e1", "a1"));
    expect(res.status).toBe(404);
  });

  it("returns 404 when attachment not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireOrgPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(ORG_ENTRY);
    mockAttachmentFindUnique.mockResolvedValue(null);
    const res = await GET(createGetRequest(), makeParams("o1", "e1", "a1"));
    expect(res.status).toBe(404);
  });

  it("returns decrypted file with RFC 5987 Content-Disposition", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireOrgPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(ORG_ENTRY);
    mockAttachmentFindUnique.mockResolvedValue(ATTACHMENT);
    mockUnwrapOrgKey.mockReturnValue(Buffer.alloc(32));
    mockGetObject.mockResolvedValue(Buffer.from("encrypted-data"));
    mockDecryptServerBinary.mockReturnValue(Buffer.from("decrypted-data"));

    const res = await GET(createGetRequest(), makeParams("o1", "e1", "a1"));
    expect(res.status).toBe(200);

    const disposition = res.headers.get("Content-Disposition");
    // ASCII fallback
    expect(disposition).toContain('filename="download"');
    // RFC 5987 UTF-8 encoded filename
    expect(disposition).toContain("filename*=UTF-8''test.pdf");
    // Content-Type and Content-Length
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Length")).toBe("100");
    // Security headers
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cache-Control")).toBe(
      "private, no-cache, no-store, must-revalidate",
    );
  });

  it("encodes non-ASCII filename in Content-Disposition", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireOrgPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(ORG_ENTRY);
    mockAttachmentFindUnique.mockResolvedValue({
      ...ATTACHMENT,
      filename: "テスト文書.pdf",
    });
    mockUnwrapOrgKey.mockReturnValue(Buffer.alloc(32));
    mockGetObject.mockResolvedValue(Buffer.from("encrypted-data"));
    mockDecryptServerBinary.mockReturnValue(Buffer.from("decrypted-data"));

    const res = await GET(createGetRequest(), makeParams("o1", "e1", "a1"));
    expect(res.status).toBe(200);

    const disposition = res.headers.get("Content-Disposition");
    // ASCII fallback for non-ASCII filenames
    expect(disposition).toContain('filename="download"');
    // RFC 5987 UTF-8 percent-encoded
    expect(disposition).toContain(
      `filename*=UTF-8''${encodeURIComponent("テスト文書.pdf")}`,
    );
  });
});

describe("DELETE /api/orgs/[orgId]/passwords/[id]/attachments/[attachmentId]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await DELETE(createDeleteRequest(), makeParams("o1", "e1", "a1"));
    expect(res.status).toBe(401);
  });

  it("returns 403 when lacking permission", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireOrgPermission.mockRejectedValue(new OrgAuthError("FORBIDDEN", 403));
    const res = await DELETE(createDeleteRequest(), makeParams("o1", "e1", "a1"));
    expect(res.status).toBe(403);
  });

  it("returns 404 when entry not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireOrgPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue(null);
    const res = await DELETE(createDeleteRequest(), makeParams("o1", "e1", "a1"));
    expect(res.status).toBe(404);
  });

  it("returns 404 when entry belongs to different org", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireOrgPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue({ orgId: "other-org" });
    const res = await DELETE(createDeleteRequest(), makeParams("o1", "e1", "a1"));
    expect(res.status).toBe(404);
  });

  it("returns 404 when attachment not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireOrgPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue({ orgId: "o1" });
    mockAttachmentFindUnique.mockResolvedValue(null);
    const res = await DELETE(createDeleteRequest(), makeParams("o1", "e1", "a1"));
    expect(res.status).toBe(404);
  });

  it("deletes attachment successfully", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireOrgPermission.mockResolvedValue(undefined);
    mockEntryFindUnique.mockResolvedValue({ orgId: "o1" });
    mockAttachmentFindUnique.mockResolvedValue({
      id: "a1",
      filename: "test.pdf",
      encryptedData: "blob-key",
    });
    mockDeleteObject.mockResolvedValue(undefined);
    mockAttachmentDelete.mockResolvedValue({});

    const res = await DELETE(createDeleteRequest(), makeParams("o1", "e1", "a1"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockDeleteObject).toHaveBeenCalledWith("blob-key", {
      attachmentId: "a1",
      entryId: "e1",
      orgId: "o1",
    });
    expect(mockAttachmentDelete).toHaveBeenCalledWith({ where: { id: "a1" } });
  });
});
