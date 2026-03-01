import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockPrismaTeamMember, mockWithBypassRls } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaTeamMember: { findMany: vi.fn() },
  mockWithBypassRls: vi.fn(async (_prisma: unknown, fn: () => unknown) => fn()),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamMember: mockPrismaTeamMember,
  },
}));
vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: mockWithBypassRls,
}));

import { GET } from "./route";

describe("GET /api/teams/pending-key-distributions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "admin-user" } });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns empty array when user is not admin of any E2E team", async () => {
    mockPrismaTeamMember.findMany.mockResolvedValueOnce([]); // admin memberships
    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual([]);
  });

  it("returns pending members for admin teams", async () => {
    // First call: admin memberships
    mockPrismaTeamMember.findMany.mockResolvedValueOnce([
      { teamId: "team-1" },
      { teamId: "team-2" },
    ]);
    // Second call: pending members
    mockPrismaTeamMember.findMany.mockResolvedValueOnce([
      {
        id: "member-1",
        teamId: "team-1",
        userId: "pending-user",
        user: { ecdhPublicKey: "pub-key", name: "Test User", email: "test@test.com" },
        team: { teamKeyVersion: 1 },
      },
    ]);

    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toHaveLength(1);
    expect(json[0]).toEqual({
      memberId: "member-1",
      teamId: "team-1",
      userId: "pending-user",
      ecdhPublicKey: "pub-key",
      teamKeyVersion: 1,
    });
    // PII (name, email) must NOT be included in response (S-16)
    expect(json[0]).not.toHaveProperty("name");
    expect(json[0]).not.toHaveProperty("email");
  });

  it("queries for pending members with correct filters", async () => {
    mockPrismaTeamMember.findMany
      .mockResolvedValueOnce([{ teamId: "team-1" }])
      .mockResolvedValueOnce([]);

    await GET();

    // Second findMany call should filter by keyDistributed: false and ecdhPublicKey not null
    expect(mockPrismaTeamMember.findMany).toHaveBeenNthCalledWith(2,
      expect.objectContaining({
        where: expect.objectContaining({
          keyDistributed: false,
          user: { ecdhPublicKey: { not: null } },
        }),
      }),
    );
  });
});
