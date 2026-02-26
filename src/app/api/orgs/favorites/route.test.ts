import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockPrismaOrgMember, mockPrismaOrgPasswordFavorite, mockHasOrgPermission } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaOrgMember: { findMany: vi.fn() },
  mockPrismaOrgPasswordFavorite: { findMany: vi.fn() },
  mockHasOrgPermission: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    orgMember: mockPrismaOrgMember,
    orgPasswordFavorite: mockPrismaOrgPasswordFavorite,
  },
}));
vi.mock("@/lib/org-auth", () => ({
  hasOrgPermission: mockHasOrgPermission,
}));

import { GET } from "./route";
import { ENTRY_TYPE, ORG_ROLE } from "@/lib/constants";

describe("GET /api/teams/favorites", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockHasOrgPermission.mockReturnValue(true);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns empty array when no memberships", async () => {
    mockPrismaOrgMember.findMany.mockResolvedValue([]);
    mockPrismaOrgPasswordFavorite.findMany.mockResolvedValue([]);
    const res = await GET();
    const json = await res.json();
    expect(json).toEqual([]);
  });

  it("returns favorited entries with encrypted overviews (E2E mode)", async () => {
    const now = new Date("2025-01-01T00:00:00Z");
    mockPrismaOrgMember.findMany.mockResolvedValue([
      { orgId: "org-1", role: ORG_ROLE.MEMBER },
    ]);
    mockPrismaOrgPasswordFavorite.findMany.mockResolvedValue([
      {
        orgPasswordEntry: {
          id: "pw-1",
          orgId: "org-1",
          entryType: ENTRY_TYPE.LOGIN,
          deletedAt: null,
          isArchived: false,
          encryptedOverview: "cipher",
          overviewIv: "a".repeat(24),
          overviewAuthTag: "b".repeat(32),
          aadVersion: 1,
          orgKeyVersion: 1,
          org: { id: "org-1", name: "My Org" },
          tags: [],
          createdBy: { id: "u1", name: "User", image: null },
          updatedBy: { id: "u1", name: "User" },
          createdAt: now,
          updatedAt: now,
        },
      },
    ]);

    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toHaveLength(1);
    // E2E mode: encrypted fields returned as-is for client decryption
    expect(json[0].encryptedOverview).toBe("cipher");
    expect(json[0].overviewIv).toBe("a".repeat(24));
    expect(json[0].overviewAuthTag).toBe("b".repeat(32));
    expect(json[0].aadVersion).toBe(1);
    expect(json[0].orgKeyVersion).toBe(1);
    expect(json[0].entryType).toBe(ENTRY_TYPE.LOGIN);
    expect(json[0].isFavorite).toBe(true);
    // No decrypted title/username fields
    expect(json[0].title).toBeUndefined();
  });

  it("filters out deleted and archived entries", async () => {
    const now = new Date("2025-01-01T00:00:00Z");
    mockPrismaOrgMember.findMany.mockResolvedValue([
      { orgId: "org-1", role: ORG_ROLE.MEMBER },
    ]);
    mockPrismaOrgPasswordFavorite.findMany.mockResolvedValue([
      {
        orgPasswordEntry: {
          id: "pw-del",
          orgId: "org-1",
          entryType: ENTRY_TYPE.LOGIN,
          deletedAt: now,
          isArchived: false,
          encryptedOverview: "c",
          overviewIv: "a".repeat(24),
          overviewAuthTag: "b".repeat(32),
          aadVersion: 1,
          orgKeyVersion: 1,
          org: { id: "org-1", name: "My Org" },
          tags: [],
          createdBy: { id: "u1", name: "User", image: null },
          updatedBy: null,
          createdAt: now,
          updatedAt: now,
        },
      },
      {
        orgPasswordEntry: {
          id: "pw-arch",
          orgId: "org-1",
          entryType: ENTRY_TYPE.LOGIN,
          deletedAt: null,
          isArchived: true,
          encryptedOverview: "c",
          overviewIv: "a".repeat(24),
          overviewAuthTag: "b".repeat(32),
          aadVersion: 1,
          orgKeyVersion: 1,
          org: { id: "org-1", name: "My Org" },
          tags: [],
          createdBy: { id: "u1", name: "User", image: null },
          updatedBy: null,
          createdAt: now,
          updatedAt: now,
        },
      },
    ]);

    const res = await GET();
    const json = await res.json();
    expect(json).toEqual([]);
  });
});
