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
  prisma: { passwordEntry: mockPrismaPasswordEntry },
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
});

describe("POST /api/passwords", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
  });

  const validBody = {
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
});
