import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaPasswordEntry, mockPrismaHistory } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaPasswordEntry: {
    findUnique: vi.fn(),
  },
  mockPrismaHistory: {
    findMany: vi.fn(),
  },
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordEntry: mockPrismaPasswordEntry,
    passwordEntryHistory: mockPrismaHistory,
  },
}));

import { GET } from "./route";

const ENTRY_ID = "entry-123";
const now = new Date("2025-06-01T00:00:00Z");

describe("GET /api/passwords/[id]/history", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/passwords/${ENTRY_ID}/history`),
      createParams({ id: ENTRY_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when entry not found", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/passwords/${ENTRY_ID}/history`),
      createParams({ id: ENTRY_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 when entry belongs to another user", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue({ userId: "other-user" });
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/passwords/${ENTRY_ID}/history`),
      createParams({ id: ENTRY_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("returns history entries in descending order", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue({ userId: "user-1" });
    mockPrismaHistory.findMany.mockResolvedValue([
      {
        id: "h2",
        entryId: ENTRY_ID,
        encryptedBlob: "blob2",
        blobIv: "iv2",
        blobAuthTag: "tag2",
        keyVersion: 1,
        aadVersion: 1,
        changedAt: new Date("2025-06-02T00:00:00Z"),
      },
      {
        id: "h1",
        entryId: ENTRY_ID,
        encryptedBlob: "blob1",
        blobIv: "iv1",
        blobAuthTag: "tag1",
        keyVersion: 1,
        aadVersion: 0,
        changedAt: now,
      },
    ]);

    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/passwords/${ENTRY_ID}/history`),
      createParams({ id: ENTRY_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toHaveLength(2);
    expect(json[0].id).toBe("h2");
    expect(json[0].encryptedBlob).toEqual({
      ciphertext: "blob2",
      iv: "iv2",
      authTag: "tag2",
    });
    expect(json[1].id).toBe("h1");
  });

  it("returns empty array when no history", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue({ userId: "user-1" });
    mockPrismaHistory.findMany.mockResolvedValue([]);

    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/passwords/${ENTRY_ID}/history`),
      createParams({ id: ENTRY_ID }),
    );
    const json = await res.json();
    expect(json).toEqual([]);
  });
});
