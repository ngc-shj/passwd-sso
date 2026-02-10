import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockAuth, mockPrismaPasswordEntry, mockPrismaAttachment } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaPasswordEntry: {
    findUnique: vi.fn(),
  },
  mockPrismaAttachment: {
    findUnique: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordEntry: mockPrismaPasswordEntry,
    attachment: mockPrismaAttachment,
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));

import { GET, DELETE } from "./route";

function createParams(id: string, attachmentId: string) {
  return { params: Promise.resolve({ id, attachmentId }) };
}

function createRequest(method: string, url: string) {
  return new NextRequest(url, { method });
}

const now = new Date("2025-01-01T00:00:00Z");

describe("GET /api/passwords/[id]/attachments/[attachmentId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
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
    mockPrismaAttachment.findUnique.mockResolvedValue({
      id: "att-1",
      filename: "test.pdf",
      contentType: "application/pdf",
      sizeBytes: 100,
      encryptedData: Buffer.from("encrypted-content"),
      iv: "a".repeat(24),
      authTag: "b".repeat(32),
      keyVersion: 1,
    });

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
});

describe("DELETE /api/passwords/[id]/attachments/[attachmentId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await DELETE(
      createRequest("DELETE", "http://localhost:3000/api/passwords/pw-1/attachments/att-1"),
      createParams("pw-1", "att-1")
    );
    expect(res.status).toBe(401);
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
