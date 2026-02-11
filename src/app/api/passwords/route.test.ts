import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaPasswordEntry } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaPasswordEntry: {
    findMany: vi.fn(),
    create: vi.fn(),
    deleteMany: vi.fn(),
  },
}));
vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { passwordEntry: mockPrismaPasswordEntry, auditLog: { create: vi.fn().mockResolvedValue({}) } },
}));

import { GET, POST } from "./route";

const now = new Date("2025-01-01T00:00:00Z");

const mockEntry = {
  id: "pw-1",
  encryptedOverview: "overview-cipher",
  overviewIv: "overview-iv",
  overviewAuthTag: "overview-tag",
  encryptedBlob: "blob-cipher",
  blobIv: "blob-iv",
  blobAuthTag: "blob-tag",
  keyVersion: 1,
  aadVersion: 0,
  entryType: "LOGIN",
  isFavorite: false,
  isArchived: false,
  tags: [{ id: "t1" }],
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
};

describe("GET /api/passwords", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockPrismaPasswordEntry.deleteMany.mockResolvedValue({ count: 0 });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(createRequest("GET", "http://localhost:3000/api/passwords"));
    expect(res.status).toBe(401);
  });

  it("returns password entries with encrypted overviews and entryType", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([mockEntry]);
    const res = await GET(createRequest("GET", "http://localhost:3000/api/passwords"));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toHaveLength(1);
    expect(json[0].encryptedOverview).toEqual({
      ciphertext: "overview-cipher",
      iv: "overview-iv",
      authTag: "overview-tag",
    });
    expect(json[0].entryType).toBe("LOGIN");
    expect(json[0].tagIds).toEqual(["t1"]);
    // Should not include blob by default
    expect(json[0].encryptedBlob).toBeUndefined();
  });

  it("returns SECURE_NOTE entryType", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([
      { ...mockEntry, id: "pw-note", entryType: "SECURE_NOTE" },
    ]);
    const res = await GET(createRequest("GET", "http://localhost:3000/api/passwords"));
    const json = await res.json();
    expect(json[0].entryType).toBe("SECURE_NOTE");
  });

  it("includes blob when include=blob", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([mockEntry]);
    const res = await GET(createRequest("GET", "http://localhost:3000/api/passwords", {
      searchParams: { include: "blob" },
    }));
    const json = await res.json();
    expect(json[0].encryptedBlob).toEqual({
      ciphertext: "blob-cipher",
      iv: "blob-iv",
      authTag: "blob-tag",
    });
  });

  it("returns empty array when no entries", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([]);
    const res = await GET(createRequest("GET", "http://localhost:3000/api/passwords"));
    const json = await res.json();
    expect(json).toEqual([]);
  });

  it("filters by entryType when type query param is provided", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([]);
    await GET(createRequest("GET", "http://localhost:3000/api/passwords", {
      searchParams: { type: "CREDIT_CARD" },
    }));
    expect(mockPrismaPasswordEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ entryType: "CREDIT_CARD" }),
      })
    );
  });

  it("does not filter by entryType when type param is absent", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([]);
    await GET(createRequest("GET", "http://localhost:3000/api/passwords"));
    const call = mockPrismaPasswordEntry.findMany.mock.calls[0][0];
    expect(call.where).not.toHaveProperty("entryType");
  });

  it("filters by trash when trash=true", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([]);
    await GET(createRequest("GET", "http://localhost:3000/api/passwords", {
      searchParams: { trash: "true" },
    }));
    expect(mockPrismaPasswordEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ deletedAt: { not: null } }),
      })
    );
  });

  it("returns aadVersion in response entries", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([
      { ...mockEntry, aadVersion: 1 },
    ]);
    const res = await GET(createRequest("GET", "http://localhost:3000/api/passwords"));
    const json = await res.json();
    expect(json[0].aadVersion).toBe(1);
  });

  it("returns aadVersion=0 for legacy entries", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([mockEntry]);
    const res = await GET(createRequest("GET", "http://localhost:3000/api/passwords"));
    const json = await res.json();
    expect(json[0].aadVersion).toBe(0);
  });

  it("excludes deleted items by default", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([]);
    await GET(createRequest("GET", "http://localhost:3000/api/passwords"));
    expect(mockPrismaPasswordEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ deletedAt: null }),
      })
    );
  });

  it("filters by archived when archived=true", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([]);
    await GET(createRequest("GET", "http://localhost:3000/api/passwords", {
      searchParams: { archived: "true" },
    }));
    expect(mockPrismaPasswordEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isArchived: true }),
      })
    );
  });

  it("excludes archived items by default", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([]);
    await GET(createRequest("GET", "http://localhost:3000/api/passwords"));
    expect(mockPrismaPasswordEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isArchived: false }),
      })
    );
  });

  it("filters by favorites when favorites=true", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([]);
    await GET(createRequest("GET", "http://localhost:3000/api/passwords", {
      searchParams: { favorites: "true" },
    }));
    expect(mockPrismaPasswordEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isFavorite: true }),
      })
    );
  });

  it("filters by tag when tag param is provided", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([]);
    await GET(createRequest("GET", "http://localhost:3000/api/passwords", {
      searchParams: { tag: "tag-123" },
    }));
    expect(mockPrismaPasswordEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tags: { some: { id: "tag-123" } },
        }),
      })
    );
  });
});

describe("POST /api/passwords", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
  });

  const validBody = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    encryptedBlob: { ciphertext: "blob", iv: "a".repeat(24), authTag: "b".repeat(32) },
    encryptedOverview: { ciphertext: "over", iv: "c".repeat(24), authTag: "d".repeat(32) },
    keyVersion: 1,
  };

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(createRequest("POST", "http://localhost:3000/api/passwords", {
      body: validBody,
    }));
    expect(res.status).toBe(401);
  });

  it("returns 400 on invalid body", async () => {
    const res = await POST(createRequest("POST", "http://localhost:3000/api/passwords", {
      body: { encryptedBlob: "not-an-object" },
    }));
    expect(res.status).toBe(400);
  });

  it("creates password entry (201)", async () => {
    mockPrismaPasswordEntry.create.mockResolvedValue({
      id: "new-pw",
      encryptedOverview: "over",
      overviewIv: "c".repeat(24),
      overviewAuthTag: "d".repeat(32),
      keyVersion: 1,
      entryType: "LOGIN",
      tags: [],
      createdAt: now,
      updatedAt: now,
    });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/passwords", {
      body: validBody,
    }));
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json.id).toBe("new-pw");
    expect(json.entryType).toBe("LOGIN");
    expect(json.tagIds).toEqual([]);
  });

  it("creates entry with client-generated id and aadVersion", async () => {
    const clientId = "550e8400-e29b-41d4-a716-446655440000";
    mockPrismaPasswordEntry.create.mockResolvedValue({
      id: clientId,
      encryptedOverview: "over",
      overviewIv: "c".repeat(24),
      overviewAuthTag: "d".repeat(32),
      keyVersion: 1,
      aadVersion: 1,
      entryType: "LOGIN",
      tags: [],
      createdAt: now,
      updatedAt: now,
    });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/passwords", {
      body: { ...validBody, id: clientId, aadVersion: 1 },
    }));
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json.id).toBe(clientId);
    expect(json.aadVersion).toBe(1);
    expect(mockPrismaPasswordEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          id: clientId,
          aadVersion: 1,
        }),
      }),
    );
  });

  it("creates entry without id (legacy aadVersion=0)", async () => {
    mockPrismaPasswordEntry.create.mockResolvedValue({
      id: "new-pw",
      encryptedOverview: "over",
      overviewIv: "c".repeat(24),
      overviewAuthTag: "d".repeat(32),
      keyVersion: 1,
      aadVersion: 0,
      entryType: "LOGIN",
      tags: [],
      createdAt: now,
      updatedAt: now,
    });

    const { id: _, ...bodyWithoutId } = validBody;
    const res = await POST(createRequest("POST", "http://localhost:3000/api/passwords", {
      body: { ...bodyWithoutId, aadVersion: 0 },
    }));
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json.aadVersion).toBe(0);
    const createCall = mockPrismaPasswordEntry.create.mock.calls[0][0];
    expect(createCall.data).not.toHaveProperty("id");
  });

  it("creates SECURE_NOTE entry (201)", async () => {
    mockPrismaPasswordEntry.create.mockResolvedValue({
      id: "new-note",
      encryptedOverview: "over",
      overviewIv: "c".repeat(24),
      overviewAuthTag: "d".repeat(32),
      keyVersion: 1,
      entryType: "SECURE_NOTE",
      tags: [],
      createdAt: now,
      updatedAt: now,
    });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/passwords", {
      body: { ...validBody, entryType: "SECURE_NOTE" },
    }));
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json.entryType).toBe("SECURE_NOTE");
  });

  it("creates CREDIT_CARD entry (201)", async () => {
    mockPrismaPasswordEntry.create.mockResolvedValue({
      id: "new-card",
      encryptedOverview: "over",
      overviewIv: "c".repeat(24),
      overviewAuthTag: "d".repeat(32),
      keyVersion: 1,
      entryType: "CREDIT_CARD",
      tags: [],
      createdAt: now,
      updatedAt: now,
    });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/passwords", {
      body: { ...validBody, entryType: "CREDIT_CARD" },
    }));
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json.entryType).toBe("CREDIT_CARD");
  });

  it("returns CREDIT_CARD entryType in GET", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([
      { ...mockEntry, id: "pw-card", entryType: "CREDIT_CARD" },
    ]);
    mockPrismaPasswordEntry.deleteMany.mockResolvedValue({ count: 0 });
    const res = await GET(createRequest("GET", "http://localhost:3000/api/passwords"));
    const json = await res.json();
    expect(json[0].entryType).toBe("CREDIT_CARD");
  });

  it("creates IDENTITY entry (201)", async () => {
    mockPrismaPasswordEntry.create.mockResolvedValue({
      id: "new-identity",
      encryptedOverview: "over",
      overviewIv: "c".repeat(24),
      overviewAuthTag: "d".repeat(32),
      keyVersion: 1,
      entryType: "IDENTITY",
      tags: [],
      createdAt: now,
      updatedAt: now,
    });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/passwords", {
      body: { ...validBody, entryType: "IDENTITY" },
    }));
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json.entryType).toBe("IDENTITY");
  });

  it("returns IDENTITY entryType in GET", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([
      { ...mockEntry, id: "pw-identity", entryType: "IDENTITY" },
    ]);
    mockPrismaPasswordEntry.deleteMany.mockResolvedValue({ count: 0 });
    const res = await GET(createRequest("GET", "http://localhost:3000/api/passwords"));
    const json = await res.json();
    expect(json[0].entryType).toBe("IDENTITY");
  });

  it("creates PASSKEY entry (201)", async () => {
    mockPrismaPasswordEntry.create.mockResolvedValue({
      id: "new-passkey",
      encryptedOverview: "over",
      overviewIv: "c".repeat(24),
      overviewAuthTag: "d".repeat(32),
      keyVersion: 1,
      entryType: "PASSKEY",
      tags: [],
      createdAt: now,
      updatedAt: now,
    });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/passwords", {
      body: { ...validBody, entryType: "PASSKEY" },
    }));
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json.entryType).toBe("PASSKEY");
  });

  it("returns PASSKEY entryType in GET", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([
      { ...mockEntry, id: "pw-passkey", entryType: "PASSKEY" },
    ]);
    mockPrismaPasswordEntry.deleteMany.mockResolvedValue({ count: 0 });
    const res = await GET(createRequest("GET", "http://localhost:3000/api/passwords"));
    const json = await res.json();
    expect(json[0].entryType).toBe("PASSKEY");
  });

  it("ignores invalid entryType query param", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([]);
    mockPrismaPasswordEntry.deleteMany.mockResolvedValue({ count: 0 });
    await GET(createRequest("GET", "http://localhost:3000/api/passwords", {
      searchParams: { type: "INVALID_TYPE" },
    }));
    const call = mockPrismaPasswordEntry.findMany.mock.calls[0][0];
    expect(call.where).not.toHaveProperty("entryType");
  });

  it("filters by entryType PASSKEY", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([]);
    await GET(createRequest("GET", "http://localhost:3000/api/passwords", {
      searchParams: { type: "PASSKEY" },
    }));
    expect(mockPrismaPasswordEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ entryType: "PASSKEY" }),
      })
    );
  });
});
