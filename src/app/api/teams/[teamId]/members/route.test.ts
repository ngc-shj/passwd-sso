import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaTeamMember, mockPrismaTenantMember, mockRequireTeamMember, TeamAuthError, mockWithTeamTenantRls, mockWithBypassRls } = vi.hoisted(() => {
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
    mockPrismaTeamMember: { findMany: vi.fn() },
    mockPrismaTenantMember: { findMany: vi.fn() },
    mockRequireTeamMember: vi.fn(),
    TeamAuthError: _TeamAuthError,
    mockWithTeamTenantRls: vi.fn(async (_teamId: string, fn: () => unknown) => fn()),
    mockWithBypassRls: vi.fn(async (_prisma: unknown, fn: () => unknown) => fn()),
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { teamMember: mockPrismaTeamMember, tenantMember: mockPrismaTenantMember },
}));
vi.mock("@/lib/team-auth", () => ({
  requireTeamMember: mockRequireTeamMember,
  TeamAuthError,
}));
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: mockWithTeamTenantRls,
}));
vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: mockWithBypassRls,
}));

import { GET } from "./route";
import { TEAM_ROLE } from "@/lib/constants";

const TEAM_ID = "team-123";
const now = new Date("2025-01-01T00:00:00Z");

describe("GET /api/teams/[teamId]/members", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireTeamMember.mockResolvedValue({ role: TEAM_ROLE.OWNER });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/members`),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when not a member", async () => {
    mockRequireTeamMember.mockRejectedValue(new TeamAuthError("NOT_FOUND", 404));
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/members`),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("returns list of members with tenantName", async () => {
    mockPrismaTeamMember.findMany.mockResolvedValue([
      {
        id: "m1",
        userId: "u1",
        role: TEAM_ROLE.OWNER,
        createdAt: now,
        user: { id: "u1", name: "Owner", email: "owner@test.com", image: null },
      },
      {
        id: "m2",
        userId: "u2",
        role: TEAM_ROLE.MEMBER,
        createdAt: now,
        user: { id: "u2", name: "Member", email: "member@test.com", image: null },
      },
    ]);
    mockPrismaTenantMember.findMany.mockResolvedValue([
      { userId: "u1", tenant: { name: "Acme Corp" } },
      { userId: "u2", tenant: { name: "External Org" } },
    ]);

    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/members`),
      createParams({ teamId: TEAM_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toHaveLength(2);
    expect(json[0].role).toBe(TEAM_ROLE.OWNER);
    expect(json[0].tenantName).toBe("Acme Corp");
    expect(json[1].role).toBe(TEAM_ROLE.MEMBER);
    expect(json[1].tenantName).toBe("External Org");
  });

  it("returns tenantName null when member has no tenant", async () => {
    mockPrismaTeamMember.findMany.mockResolvedValue([
      {
        id: "m1",
        userId: "u1",
        role: TEAM_ROLE.OWNER,
        createdAt: now,
        user: { id: "u1", name: "Owner", email: "owner@test.com", image: null },
      },
    ]);
    mockPrismaTenantMember.findMany.mockResolvedValue([]);

    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/members`),
      createParams({ teamId: TEAM_ID }),
    );
    const json = await res.json();
    expect(json[0].tenantName).toBeNull();
  });

  it("uses withBypassRls for tenant member lookup", async () => {
    mockPrismaTeamMember.findMany.mockResolvedValue([]);
    mockPrismaTenantMember.findMany.mockResolvedValue([]);

    await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/members`),
      createParams({ teamId: TEAM_ID }),
    );
    expect(mockWithBypassRls).toHaveBeenCalledTimes(1);
    expect(mockWithBypassRls).toHaveBeenCalledWith(expect.anything(), expect.any(Function));
  });
});
