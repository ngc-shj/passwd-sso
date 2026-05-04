import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockAuth, mockPrismaPasswordEntry, mockPrismaAttachment, mockWithUserTenantRls, mockGetObject, mockDeleteObject } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaPasswordEntry: {
    findUnique: vi.fn(),
  },
  mockPrismaAttachment: {
    findUnique: vi.fn(),
    delete: vi.fn(),
  },
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
  mockGetObject: vi.fn(),
  mockDeleteObject: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordEntry: mockPrismaPasswordEntry,
    attachment: mockPrismaAttachment,
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/blob-store", () => ({
  getAttachmentBlobStore: () => ({
    getObject: mockGetObject,
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

import { GET, DELETE } from "./route";

function createParams(id: string, attachmentId: string) {
  return { params: Promise.resolve({ id, attachmentId }) };
}

function createRequest(method: string, url: string) {
  return new NextRequest(url, { method });
}

// Base mode-0 attachment row (legacy, no CEK fields)
const mode0Attachment = {
  id: "att-1",
  filename: "test.pdf",
  contentType: "application/pdf",
  sizeBytes: 100,
  encryptedData: Buffer.from("encrypted-content"),
  iv: "a".repeat(24),
  authTag: "b".repeat(32),
  keyVersion: 1,
  aadVersion: 0,
  encryptionMode: 0,
  cekEncrypted: null,
  cekIv: null,
  cekAuthTag: null,
  cekKeyVersion: null,
  cekWrapAadVersion: null,
};

// Mode-2 attachment row (CEK indirection)
const mode2Attachment = {
  id: "att-2",
  filename: "secret.pdf",
  contentType: "application/pdf",
  sizeBytes: 200,
  encryptedData: Buffer.from("encrypted-content-mode2"),
  iv: "c".repeat(24),
  authTag: "d".repeat(32),
  keyVersion: null,
  aadVersion: 1,
  encryptionMode: 2,
  cekEncrypted: Buffer.from("fake-cek-bytes"),
  cekIv: "e".repeat(24),
  cekAuthTag: "f".repeat(32),
  cekKeyVersion: 3,
  cekWrapAadVersion: 1,
};

describe("GET /api/passwords/[id]/attachments/[attachmentId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockGetObject.mockResolvedValue(Buffer.from("encrypted-content"));
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", "http://localhost:3000/api/passwords/pw-1/attachments/att-1"),
      createParams("pw-1", "att-1")
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when entry not found", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", "http://localhost:3000/api/passwords/pw-1/attachments/att-1"),
      createParams("pw-1", "att-1")
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 when entry belongs to another user", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue({ userId: "other-user" });
    const res = await GET(
      createRequest("GET", "http://localhost:3000/api/passwords/pw-1/attachments/att-1"),
      createParams("pw-1", "att-1")
    );
    expect(res.status).toBe(403);
  });

  it("returns 404 when attachment not found", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue({ userId: "user-1" });
    mockPrismaAttachment.findUnique.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", "http://localhost:3000/api/passwords/pw-1/attachments/att-1"),
      createParams("pw-1", "att-1")
    );
    expect(res.status).toBe(404);
  });

  it("returns encrypted attachment data", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue({ userId: "user-1" });
    mockPrismaAttachment.findUnique.mockResolvedValue(mode0Attachment);

    const res = await GET(
      createRequest("GET", "http://localhost:3000/api/passwords/pw-1/attachments/att-1"),
      createParams("pw-1", "att-1")
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.filename).toBe("test.pdf");
    expect(json.encryptedData).toBeTruthy(); // base64 encoded
    expect(json.iv).toBe("a".repeat(24));
    expect(json.authTag).toBe("b".repeat(32));
  });

  it("returns aadVersion in response", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue({ userId: "user-1" });
    mockPrismaAttachment.findUnique.mockResolvedValue({ ...mode0Attachment, aadVersion: 1 });
    mockGetObject.mockResolvedValue(Buffer.from("encrypted-content"));

    const res = await GET(
      createRequest("GET", "http://localhost:3000/api/passwords/pw-1/attachments/att-1"),
      createParams("pw-1", "att-1")
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.aadVersion).toBe(1);
  });

  // ── Phase B: CEK fields in response ─────────────────────────────────

  it("GET returns CEK fields populated when encryptionMode = 2", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue({ userId: "user-1" });
    mockPrismaAttachment.findUnique.mockResolvedValue(mode2Attachment);
    mockGetObject.mockResolvedValue(Buffer.from("encrypted-content-mode2"));

    const res = await GET(
      createRequest("GET", "http://localhost:3000/api/passwords/pw-1/attachments/att-2"),
      createParams("pw-1", "att-2")
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.encryptionMode).toBe(2);
    // cekEncrypted is base64 encoded
    expect(typeof json.cekEncrypted).toBe("string");
    expect(json.cekEncrypted).toBeTruthy();
    expect(json.cekIv).toBe("e".repeat(24));
    expect(json.cekAuthTag).toBe("f".repeat(32));
    expect(json.cekKeyVersion).toBe(3);
    expect(json.cekWrapAadVersion).toBe(1);
  });

  it("GET returns CEK fields as null when encryptionMode = 0", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue({ userId: "user-1" });
    mockPrismaAttachment.findUnique.mockResolvedValue(mode0Attachment);
    mockGetObject.mockResolvedValue(Buffer.from("encrypted-content"));

    const res = await GET(
      createRequest("GET", "http://localhost:3000/api/passwords/pw-1/attachments/att-1"),
      createParams("pw-1", "att-1")
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.encryptionMode).toBe(0);
    expect(json.cekEncrypted).toBeNull();
    expect(json.cekIv).toBeNull();
    expect(json.cekAuthTag).toBeNull();
    expect(json.cekKeyVersion).toBeNull();
    expect(json.cekWrapAadVersion).toBeNull();
  });
});

describe("DELETE /api/passwords/[id]/attachments/[attachmentId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockDeleteObject.mockResolvedValue(undefined);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await DELETE(
      createRequest("DELETE", "http://localhost:3000/api/passwords/pw-1/attachments/att-1"),
      createParams("pw-1", "att-1")
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when attachment belongs to another user's entry", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue({ userId: "other-user" });
    const res = await DELETE(
      createRequest("DELETE", "http://localhost:3000/api/passwords/pw-1/attachments/att-1"),
      createParams("pw-1", "att-1")
    );
    expect(res.status).toBe(403);
  });

  it("returns 404 when attachment not found", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue({ userId: "user-1" });
    mockPrismaAttachment.findUnique.mockResolvedValue(null);
    const res = await DELETE(
      createRequest("DELETE", "http://localhost:3000/api/passwords/pw-1/attachments/att-1"),
      createParams("pw-1", "att-1")
    );
    expect(res.status).toBe(404);
  });

  it("deletes attachment successfully", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue({ userId: "user-1" });
    mockPrismaAttachment.findUnique.mockResolvedValue({
      id: "att-1",
      filename: "test.pdf",
      encryptedData: Buffer.from("content"),
    });
    mockPrismaAttachment.delete.mockResolvedValue({});

    const res = await DELETE(
      createRequest("DELETE", "http://localhost:3000/api/passwords/pw-1/attachments/att-1"),
      createParams("pw-1", "att-1")
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(mockPrismaAttachment.delete).toHaveBeenCalledWith({
      where: { id: "att-1" },
    });
  });
});
