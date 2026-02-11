import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockAuth, mockPrismaPasswordEntry, mockPrismaAttachment } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaPasswordEntry: {
    findUnique: vi.fn(),
  },
  mockPrismaAttachment: {
    findMany: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
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

const now = new Date("2025-01-01T00:00:00Z");

describe("GET /api/passwords/[id]/attachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
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
    mockPrismaPasswordEntry.findUnique.mockResolvedValue({ userId: "user-1" });
    mockPrismaAttachment.count.mockResolvedValue(0);
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
      }),
      createParams("pw-1")
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Maximum");
  });

  it("returns 400 for invalid extension", async () => {
    const res = await POST(
      createFormDataRequest("http://localhost:3000/api/passwords/pw-1/attachments", {
        file: new Blob(["data"]),
        iv: "a".repeat(24),
        authTag: "b".repeat(32),
        filename: "test.exe",
        contentType: "application/pdf",
        sizeBytes: "100",
      }),
      createParams("pw-1")
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("extension");
  });

  it("returns 400 for file too large", async () => {
    const res = await POST(
      createFormDataRequest("http://localhost:3000/api/passwords/pw-1/attachments", {
        file: new Blob(["data"]),
        iv: "a".repeat(24),
        authTag: "b".repeat(32),
        filename: "test.pdf",
        contentType: "application/pdf",
        sizeBytes: String(11 * 1024 * 1024), // 11MB
      }),
      createParams("pw-1")
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("size");
  });

  it("returns 400 for invalid content type", async () => {
    const res = await POST(
      createFormDataRequest("http://localhost:3000/api/passwords/pw-1/attachments", {
        file: new Blob(["data"]),
        iv: "a".repeat(24),
        authTag: "b".repeat(32),
        filename: "test.pdf",
        contentType: "application/zip",
        sizeBytes: "100",
      }),
      createParams("pw-1")
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Content type");
  });

  it("returns 400 for invalid iv format", async () => {
    const res = await POST(
      createFormDataRequest("http://localhost:3000/api/passwords/pw-1/attachments", {
        file: new Blob(["data"]),
        iv: "short",
        authTag: "b".repeat(32),
        filename: "test.pdf",
        contentType: "application/pdf",
        sizeBytes: "100",
      }),
      createParams("pw-1")
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("iv");
  });

  it("creates attachment successfully", async () => {
    mockPrismaAttachment.create.mockResolvedValue({
      id: "att-new",
      filename: "test.pdf",
      contentType: "application/pdf",
      sizeBytes: 100,
      createdAt: now,
    });

    const res = await POST(
      createFormDataRequest("http://localhost:3000/api/passwords/pw-1/attachments", {
        file: new Blob(["encrypted-data"]),
        iv: "a".repeat(24),
        authTag: "b".repeat(32),
        filename: "test.pdf",
        contentType: "application/pdf",
        sizeBytes: "100",
      }),
      createParams("pw-1")
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.id).toBe("att-new");
    expect(json.filename).toBe("test.pdf");
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
    // Declare sizeBytes as small, but upload a huge blob
    const hugeBlob = new Blob([new Uint8Array(11 * 1024 * 1024)]); // 11MB
    const res = await POST(
      createFormDataRequest("http://localhost:3000/api/passwords/pw-1/attachments", {
        file: hugeBlob,
        iv: "a".repeat(24),
        authTag: "b".repeat(32),
        filename: "test.pdf",
        contentType: "application/pdf",
        sizeBytes: "100", // declared small
      }),
      createParams("pw-1")
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("size");
  });

  it("defaults aadVersion to 0 when not provided", async () => {
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
      }),
      createParams("pw-1")
    );
    expect(mockPrismaAttachment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          aadVersion: 0,
        }),
      }),
    );
  });
});
