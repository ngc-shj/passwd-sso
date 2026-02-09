import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockPrismaOrgMember, mockPrismaOrgPasswordEntry, mockUnwrapOrgKey, mockDecryptServerData, mockHasOrgPermission } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaOrgMember: { findMany: vi.fn() },
  mockPrismaOrgPasswordEntry: { findMany: vi.fn() },
  mockUnwrapOrgKey: vi.fn(),
  mockDecryptServerData: vi.fn(),
  mockHasOrgPermission: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    orgMember: mockPrismaOrgMember,
    orgPasswordEntry: mockPrismaOrgPasswordEntry,
  },
}));
vi.mock("@/lib/crypto-server", () => ({
  unwrapOrgKey: mockUnwrapOrgKey,
  decryptServerData: mockDecryptServerData,
}));
vi.mock("@/lib/org-auth", () => ({
  hasOrgPermission: mockHasOrgPermission,
}));

import { GET } from "./route";

describe("GET /api/orgs/trash", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockHasOrgPermission.mockReturnValue(true);
    mockUnwrapOrgKey.mockReturnValue(Buffer.alloc(32));
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns empty array when no readable orgs", async () => {
    mockPrismaOrgMember.findMany.mockResolvedValue([]);
    const res = await GET();
    const json = await res.json();
    expect(json).toEqual([]);
  });

  it("returns trashed entries with decrypted overviews", async () => {
    const now = new Date("2025-01-01T00:00:00Z");
    const deletedAt = new Date("2025-01-02T00:00:00Z");
    mockPrismaOrgMember.findMany.mockResolvedValue([
      { orgId: "org-1", role: "ADMIN" },
    ]);
    mockPrismaOrgPasswordEntry.findMany.mockResolvedValue([
      {
        id: "pw-1",
        orgId: "org-1",
        isArchived: false,
        deletedAt,
        encryptedOverview: "cipher",
        overviewIv: "iv",
        overviewAuthTag: "tag",
        org: { id: "org-1", name: "My Org", encryptedOrgKey: "ek", orgKeyIv: "iv", orgKeyAuthTag: "tag" },
        tags: [],
        createdBy: { id: "u1", name: "User", image: null },
        updatedBy: { id: "u1", name: "User" },
        favorites: [],
        createdAt: now,
        updatedAt: now,
      },
    ]);
    mockDecryptServerData.mockReturnValue(
      JSON.stringify({ title: "Trashed PW", username: "admin", urlHost: null })
    );

    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toHaveLength(1);
    expect(json[0].title).toBe("Trashed PW");
    expect(json[0].deletedAt).toBeDefined();
  });
});
