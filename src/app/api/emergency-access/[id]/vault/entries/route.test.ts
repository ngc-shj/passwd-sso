import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaGrant, mockPrismaEntry } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaGrant: {
    findUnique: vi.fn(),
  },
  mockPrismaEntry: {
    findMany: vi.fn(),
  },
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    emergencyAccessGrant: mockPrismaGrant,
    passwordEntry: mockPrismaEntry,
  },
}));

import { GET } from "./route";

describe("GET /api/emergency-access/[id]/vault/entries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "grantee-1" } });
    mockPrismaGrant.findUnique.mockResolvedValue({
      id: "grant-1",
      ownerId: "owner-1",
      granteeId: "grantee-1",
      status: "ACTIVATED",
    });
    mockPrismaEntry.findMany.mockResolvedValue([]);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", "http://localhost/api/emergency-access/grant-1/vault/entries"),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when grant not found", async () => {
    mockPrismaGrant.findUnique.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", "http://localhost/api/emergency-access/grant-1/vault/entries"),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when not grantee", async () => {
    mockAuth.mockResolvedValue({ user: { id: "other-user" } });
    const res = await GET(
      createRequest("GET", "http://localhost/api/emergency-access/grant-1/vault/entries"),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 when not ACTIVATED", async () => {
    mockPrismaGrant.findUnique.mockResolvedValue({
      id: "grant-1",
      ownerId: "owner-1",
      granteeId: "grantee-1",
      status: "IDLE",
    });
    const res = await GET(
      createRequest("GET", "http://localhost/api/emergency-access/grant-1/vault/entries"),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(403);
  });

  it("returns 403 when STALE", async () => {
    mockPrismaGrant.findUnique.mockResolvedValue({
      id: "grant-1",
      ownerId: "owner-1",
      granteeId: "grantee-1",
      status: "STALE",
    });
    const res = await GET(
      createRequest("GET", "http://localhost/api/emergency-access/grant-1/vault/entries"),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(403);
  });

  it("returns encrypted entries for ACTIVATED grant", async () => {
    const mockEntries = [
      {
        id: "entry-1",
        encryptedBlob: "blob-data",
        blobIv: "a".repeat(24),
        blobAuthTag: "b".repeat(32),
        encryptedOverview: "overview-data",
        overviewIv: "c".repeat(24),
        overviewAuthTag: "d".repeat(32),
        keyVersion: 1,
        entryType: "LOGIN",
        isFavorite: false,
        isArchived: false,
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-02"),
      },
    ];
    mockPrismaEntry.findMany.mockResolvedValue(mockEntries);

    const res = await GET(
      createRequest("GET", "http://localhost/api/emergency-access/grant-1/vault/entries"),
      createParams({ id: "grant-1" })
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toHaveLength(1);
    expect(json[0].id).toBe("entry-1");
    expect(json[0].encryptedBlob).toBe("blob-data");
    expect(json[0].entryType).toBe("LOGIN");
  });

  it("queries only non-deleted entries for the owner", async () => {
    mockPrismaEntry.findMany.mockResolvedValue([]);

    await GET(
      createRequest("GET", "http://localhost/api/emergency-access/grant-1/vault/entries"),
      createParams({ id: "grant-1" })
    );

    expect(mockPrismaEntry.findMany).toHaveBeenCalledWith({
      where: {
        userId: "owner-1",
        deletedAt: null,
      },
      select: expect.objectContaining({
        id: true,
        encryptedBlob: true,
        keyVersion: true,
        entryType: true,
      }),
      orderBy: { updatedAt: "desc" },
    });
  });

  it("returns empty array when no entries", async () => {
    mockPrismaEntry.findMany.mockResolvedValue([]);

    const res = await GET(
      createRequest("GET", "http://localhost/api/emergency-access/grant-1/vault/entries"),
      createParams({ id: "grant-1" })
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual([]);
  });
});
