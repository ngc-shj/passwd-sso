import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockPrismaTeamMember, mockPrismaTeamPasswordFavorite, mockHasTeamPermission } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaTeamMember: { findMany: vi.fn() },
  mockPrismaTeamPasswordFavorite: { findMany: vi.fn() },
  mockHasTeamPermission: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamMember: mockPrismaTeamMember,
    teamPasswordFavorite: mockPrismaTeamPasswordFavorite,
  },
}));
vi.mock("@/lib/team-auth", () => ({
  hasTeamPermission: mockHasTeamPermission,
}));

import { GET } from "./route";
import { ENTRY_TYPE, TEAM_ROLE } from "@/lib/constants";

describe("GET /api/teams/favorites", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockHasTeamPermission.mockReturnValue(true);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns empty array when no memberships", async () => {
    mockPrismaTeamMember.findMany.mockResolvedValue([]);
    mockPrismaTeamPasswordFavorite.findMany.mockResolvedValue([]);
    const res = await GET();
    const json = await res.json();
    expect(json).toEqual([]);
  });

  it("returns favorited entries with encrypted overviews (E2E mode)", async () => {
    const now = new Date("2025-01-01T00:00:00Z");
    mockPrismaTeamMember.findMany.mockResolvedValue([
      { teamId: "team-1", role: TEAM_ROLE.MEMBER },
    ]);
    mockPrismaTeamPasswordFavorite.findMany.mockResolvedValue([
      {
        teamPasswordEntry: {
          id: "pw-1",
          teamId: "team-1",
          entryType: ENTRY_TYPE.LOGIN,
          deletedAt: null,
          isArchived: false,
          encryptedOverview: "cipher",
          overviewIv: "a".repeat(24),
          overviewAuthTag: "b".repeat(32),
          aadVersion: 1,
          teamKeyVersion: 1,
          team: { id: "team-1", name: "My Team" },
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
    expect(json[0].teamKeyVersion).toBe(1);
    expect(json[0].entryType).toBe(ENTRY_TYPE.LOGIN);
    expect(json[0].isFavorite).toBe(true);
    // No decrypted title/username fields
    expect(json[0].title).toBeUndefined();
  });

  it("filters out deleted and archived entries", async () => {
    const now = new Date("2025-01-01T00:00:00Z");
    mockPrismaTeamMember.findMany.mockResolvedValue([
      { teamId: "team-1", role: TEAM_ROLE.MEMBER },
    ]);
    mockPrismaTeamPasswordFavorite.findMany.mockResolvedValue([
      {
        teamPasswordEntry: {
          id: "pw-del",
          teamId: "team-1",
          entryType: ENTRY_TYPE.LOGIN,
          deletedAt: now,
          isArchived: false,
          encryptedOverview: "c",
          overviewIv: "a".repeat(24),
          overviewAuthTag: "b".repeat(32),
          aadVersion: 1,
          teamKeyVersion: 1,
          team: { id: "team-1", name: "My Team" },
          tags: [],
          createdBy: { id: "u1", name: "User", image: null },
          updatedBy: null,
          createdAt: now,
          updatedAt: now,
        },
      },
      {
        teamPasswordEntry: {
          id: "pw-arch",
          teamId: "team-1",
          entryType: ENTRY_TYPE.LOGIN,
          deletedAt: null,
          isArchived: true,
          encryptedOverview: "c",
          overviewIv: "a".repeat(24),
          overviewAuthTag: "b".repeat(32),
          aadVersion: 1,
          teamKeyVersion: 1,
          team: { id: "team-1", name: "My Team" },
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
