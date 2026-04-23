import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const {
  mockAuth,
  mockPrismaTeam,
  mockPrismaTeamMember,
  mockPrismaTeamInvitation,
  mockPrismaUser,
  mockRequireTeamPermission,
  TeamAuthError,
  mockWithTeamTenantRls,
} = vi.hoisted(() => {
  class _TeamAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "TeamAuthError";
      this.status = status;
    }
  }
  return {
    mockAuth: vi.fn(),
    mockPrismaTeam: { findUnique: vi.fn() },
    mockPrismaTeamMember: { findMany: vi.fn() },
    mockPrismaTeamInvitation: { findMany: vi.fn() },
    mockPrismaUser: { findMany: vi.fn() },
    mockRequireTeamPermission: vi.fn(),
    TeamAuthError: _TeamAuthError,
    mockWithTeamTenantRls: vi.fn(async (_teamId: string, fn: (tenantId: string) => unknown) => fn("tenant-456")),
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    team: mockPrismaTeam,
    teamMember: mockPrismaTeamMember,
    teamInvitation: mockPrismaTeamInvitation,
    user: mockPrismaUser,
  },
}));
vi.mock("@/lib/auth/team-auth", () => ({
  requireTeamPermission: mockRequireTeamPermission,
  TeamAuthError,
}));
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: mockWithTeamTenantRls,
}));

import { GET } from "./route";

const TEAM_ID = "team-123";
const TENANT_ID = "tenant-456";

describe("GET /api/teams/[teamId]/members/search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockPrismaTeam.findUnique.mockResolvedValue({ tenantId: TENANT_ID });
    mockPrismaTeamMember.findMany.mockResolvedValue([]);
    mockPrismaTeamInvitation.findMany.mockResolvedValue([]);
    mockPrismaUser.findMany.mockResolvedValue([]);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/members/search`, {
        searchParams: { q: "test" },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when insufficient permission", async () => {
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("FORBIDDEN", 403));
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/members/search`, {
        searchParams: { q: "test" },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 when q is empty", async () => {
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/members/search`),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when q exceeds 100 characters", async () => {
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/members/search`, {
        searchParams: { q: "a".repeat(101) },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("returns empty array when team not found", async () => {
    mockPrismaTeam.findUnique.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/members/search`, {
        searchParams: { q: "test" },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual([]);
  });

  it("returns matching tenant members", async () => {
    mockPrismaUser.findMany.mockResolvedValue([
      { id: "u1", name: "Alice", email: "alice@test.com", image: null },
    ]);

    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/members/search`, {
        searchParams: { q: "ali" },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual([
      { userId: "u1", name: "Alice", email: "alice@test.com", image: null },
    ]);
  });

  it("excludes active team members", async () => {
    mockPrismaTeamMember.findMany.mockResolvedValue([{ userId: "u1" }]);
    mockPrismaUser.findMany.mockResolvedValue([]);

    await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/members/search`, {
        searchParams: { q: "test" },
      }),
      createParams({ teamId: TEAM_ID }),
    );

    // The user query should have notIn containing u1
    const userCall = mockPrismaUser.findMany.mock.calls[0][0];
    expect(userCall.where.id?.notIn).toContain("u1");
  });

  it("excludes users with pending invitations", async () => {
    mockPrismaTeamInvitation.findMany.mockResolvedValue([
      { email: "pending@test.com" },
    ]);
    // First findMany is the search query (for resolving emails); second is the main search
    mockPrismaUser.findMany
      .mockResolvedValueOnce([{ id: "u2" }]) // email→userId resolution
      .mockResolvedValueOnce([]); // main search

    await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/members/search`, {
        searchParams: { q: "test" },
      }),
      createParams({ teamId: TEAM_ID }),
    );

    // The email→userId resolution query should include tenantId
    const emailResolveCall = mockPrismaUser.findMany.mock.calls[0][0];
    expect(emailResolveCall.where.tenantId).toBe(TENANT_ID);

    // The main search query should exclude u2
    const mainSearchCall = mockPrismaUser.findMany.mock.calls[1][0];
    expect(mainSearchCall.where.id?.notIn).toContain("u2");
  });

  it("uses withTeamTenantRls", async () => {
    await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/members/search`, {
        searchParams: { q: "test" },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(mockWithTeamTenantRls).toHaveBeenCalledWith(TEAM_ID, expect.any(Function));
  });
});
