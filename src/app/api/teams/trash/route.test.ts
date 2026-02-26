import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockPrismaTeamMember, mockPrismaTeamPasswordEntry, mockHasTeamPermission } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaTeamMember: { findMany: vi.fn() },
  mockPrismaTeamPasswordEntry: { findMany: vi.fn() },
  mockHasTeamPermission: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    orgMember: mockPrismaTeamMember,
    orgPasswordEntry: mockPrismaTeamPasswordEntry,
  },
}));
vi.mock("@/lib/team-auth", () => ({
  hasTeamPermission: mockHasTeamPermission,
}));

import { GET } from "./route";
import { ENTRY_TYPE, TEAM_ROLE } from "@/lib/constants";

describe("GET /api/teams/trash", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockHasTeamPermission.mockReturnValue(true);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns empty array when no readable teams", async () => {
    mockPrismaTeamMember.findMany.mockResolvedValue([]);
    const res = await GET();
    const json = await res.json();
    expect(json).toEqual([]);
  });

  it("returns trashed entries with encrypted overviews (E2E mode)", async () => {
    const now = new Date("2025-01-01T00:00:00Z");
    const deletedAt = new Date("2025-01-02T00:00:00Z");
    mockPrismaTeamMember.findMany.mockResolvedValue([
      { orgId: "team-1", role: TEAM_ROLE.ADMIN },
    ]);
    mockPrismaTeamPasswordEntry.findMany.mockResolvedValue([
      {
        id: "pw-1",
        orgId: "team-1",
        entryType: ENTRY_TYPE.LOGIN,
        isArchived: false,
        deletedAt,
        encryptedOverview: "encrypted-overview",
        overviewIv: "aabbccddee001122",
        overviewAuthTag: "aabbccddee0011223344556677889900",
        aadVersion: 1,
        orgKeyVersion: 1,
        org: { id: "team-1", name: "My Team" },
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
