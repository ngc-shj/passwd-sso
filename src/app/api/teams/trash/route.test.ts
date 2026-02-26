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
vi.mock("@/lib/org-auth", () => ({
  hasOrgPermission: mockHasOrgPermission,
}));

import { GET } from "./route";
import { ENTRY_TYPE, ORG_ROLE } from "@/lib/constants";

describe("GET /api/teams/trash", () => {
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

  it("returns trashed entries with encrypted overviews (E2E mode)", async () => {
    const now = new Date("2025-01-01T00:00:00Z");
    const deletedAt = new Date("2025-01-02T00:00:00Z");
    mockPrismaOrgMember.findMany.mockResolvedValue([
      { orgId: "org-1", role: ORG_ROLE.ADMIN },
    ]);
    mockPrismaOrgPasswordEntry.findMany.mockResolvedValue([
      {
        id: "pw-1",
        orgId: "org-1",
        entryType: ENTRY_TYPE.LOGIN,
        isArchived: false,
        deletedAt,
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
    expect(json[0].entryType).toBe(ENTRY_TYPE.LOGIN);
    expect(json[0].deletedAt).toBeDefined();
    expect(json[0].orgKeyVersion).toBe(1);
    // Should NOT contain decrypted fields
    expect(json[0].title).toBeUndefined();
  });
});
