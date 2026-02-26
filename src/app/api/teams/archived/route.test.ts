import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockPrismaOrgMember, mockPrismaOrgPasswordEntry, mockHasOrgPermission } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaOrgMember: { findMany: vi.fn() },
  mockPrismaOrgPasswordEntry: { findMany: vi.fn() },
  mockHasOrgPermission: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    orgMember: mockPrismaOrgMember,
    orgPasswordEntry: mockPrismaOrgPasswordEntry,
  },
}));
vi.mock("@/lib/team-auth", () => ({
  hasOrgPermission: mockHasOrgPermission,
}));

import { GET } from "./route";
import { TEAM_ROLE } from "@/lib/constants";

describe("GET /api/teams/archived", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockHasOrgPermission.mockReturnValue(true);
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

  it("returns archived entries with encrypted overviews (E2E mode)", async () => {
    const now = new Date("2025-01-01T00:00:00Z");
    mockPrismaOrgMember.findMany.mockResolvedValue([
      { orgId: "org-1", role: TEAM_ROLE.MEMBER },
    ]);
    mockPrismaOrgPasswordEntry.findMany.mockResolvedValue([
      {
        id: "pw-1",
        orgId: "org-1",
        entryType: "LOGIN",
        isArchived: true,
        deletedAt: null,
        encryptedOverview: "encrypted-overview",
        overviewIv: "aabbccddee001122",
        overviewAuthTag: "aabbccddee0011223344556677889900",
        aadVersion: 1,
        orgKeyVersion: 1,
        org: { id: "org-1", name: "My Org" },
        tags: [],
        createdBy: { id: "u1", name: "User", image: null },
        updatedBy: { id: "u1", name: "User" },
        favorites: [],
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toHaveLength(1);
    expect(json[0].encryptedOverview).toBe("encrypted-overview");
    expect(json[0].overviewIv).toBe("aabbccddee001122");
    expect(json[0].overviewAuthTag).toBe("aabbccddee0011223344556677889900");
    expect(json[0].aadVersion).toBe(1);
    expect(json[0].orgKeyVersion).toBe(1);
    expect(json[0].isArchived).toBe(true);
    expect(json[0].orgId).toBe("org-1");
    expect(json[0].orgName).toBe("My Org");
    // Should NOT contain decrypted fields
    expect(json[0].title).toBeUndefined();
    expect(json[0].username).toBeUndefined();
  });
});
