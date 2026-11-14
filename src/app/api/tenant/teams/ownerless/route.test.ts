import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const {
  mockAuth,
  mockRequireTenantPermission,
  mockTeamFindMany,
  mockTenantMemberFindMany,
  mockDepartureFindMany,
  mockBuildDisplay,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTenantPermission: vi.fn(),
  mockTeamFindMany: vi.fn(),
  mockTenantMemberFindMany: vi.fn(),
  mockDepartureFindMany: vi.fn(),
  mockBuildDisplay: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/auth/access/tenant-auth", () => ({ requireTenantPermission: mockRequireTenantPermission }));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: async (_prisma: unknown, _tenantId: string, fn: (tx: unknown) => unknown) =>
    fn({
      team: { findMany: mockTeamFindMany },
      tenantMember: { findMany: mockTenantMemberFindMany },
      tenantMemberDeparture: { findMany: mockDepartureFindMany },
    }),
}));
vi.mock("@/lib/team/team-member-display", () => ({ buildTeamMemberDisplayItems: mockBuildDisplay }));

import { GET } from "./route";
import { TEAM_ROLE } from "@/lib/constants";
import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";

const ADMITTED = new Date("2026-01-01T00:00:00.000Z");
const BEFORE = new Date("2025-12-01T00:00:00.000Z");
const AFTER = new Date("2026-02-01T00:00:00.000Z");

type MemberFixture = { userId: string; role: string; admittedAt?: Date | null; createdAt?: Date };

function team(id: string, members: MemberFixture[]) {
  return {
    id,
    name: id,
    slug: id,
    members: members.map((m, i) => ({
      id: `${id}-m${i}`,
      userId: m.userId,
      role: m.role,
      admittedAt: m.admittedAt ?? null,
      createdAt: m.createdAt ?? ADMITTED,
    })),
  };
}

// The tenant rows readTenantRows reads: active rows unless given a deactivation.
function seedTenant(
  rows: { userId: string; deactivatedAt?: Date | null }[],
  departures: { userId: string; departedAt: Date }[] = [],
) {
  // Two shapes: the stamped-user pre-read (no userId filter) and readTenantRows (userId in).
  type Args = { where: { userId?: { in: string[] }; deactivatedAt?: unknown } };
  const wanted = (args: Args, userId: string) => args.where.userId === undefined || args.where.userId.in.includes(userId);
  mockTenantMemberFindMany.mockImplementation(async (args: Args) =>
    rows.filter((r) => wanted(args, r.userId) && (args.where.deactivatedAt === undefined || (r.deactivatedAt ?? null) !== null))
      .map((r) => ({ userId: r.userId, role: "MEMBER", deactivatedAt: r.deactivatedAt ?? null })));
  mockDepartureFindMany.mockImplementation(async (args: Args) =>
    departures.filter((d) => wanted(args, d.userId)));
}

async function listed() {
  const json = await (await GET(createRequest("GET", "http://localhost:3000/api/tenant/teams/ownerless"))).json();
  return json.teams as { id: string; members: { userId: string }[] }[];
}

describe("GET /api/tenant/teams/ownerless", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "admin-1" } });
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant-1", role: "ADMIN" });
    mockTeamFindMany.mockResolvedValue([]);
    seedTenant([]);
    mockBuildDisplay.mockImplementation(async (rows: { userId: string; role: string }[]) =>
      rows.map((r) => ({ userId: r.userId, role: r.role, name: null, email: `${r.userId}@test.com` })));
  });

  it("requires TEAM_OWNER_ASSIGN", async () => {
    const { TenantAuthError } = await vi.importActual<typeof import("@/lib/auth/access/tenant-auth")>("@/lib/auth/access/tenant-auth");
    mockRequireTenantPermission.mockRejectedValue(new TenantAuthError("FORBIDDEN", 403));

    const res = await GET(createRequest("GET", "http://localhost:3000/api/tenant/teams/ownerless"));

    expect(res.status).toBe(403);
    expect(mockRequireTenantPermission).toHaveBeenCalledWith("admin-1", TENANT_PERMISSION.TEAM_OWNER_ASSIGN);
    expect(mockTeamFindMany).not.toHaveBeenCalled();
  });

  it("lists the actor tenant's teams with no active OWNER, with their active members", async () => {
    mockTeamFindMany.mockResolvedValue([
      { id: "team-1", name: "Core", slug: "core", members: [{ id: "m1", userId: "u1", role: "ADMIN", admittedAt: null, createdAt: new Date() }] },
    ]);
    seedTenant([{ userId: "u1" }]);
    mockBuildDisplay.mockResolvedValue([{ userId: "u1", role: "ADMIN", name: "Ann", email: "ann@test.com" }]);

    const res = await GET(createRequest("GET", "http://localhost:3000/api/tenant/teams/ownerless"));
    const json = await res.json();

    expect(json.teams).toEqual([
      { id: "team-1", name: "Core", slug: "core", members: [{ userId: "u1", role: "ADMIN", name: "Ann", email: "ann@test.com" }] },
    ]);
    // The query pre-filters on an OWNER who never left this tenant (no
    // departure stamp), read first rather than through the User relation; the
    // exact leftover comparison runs on the result.
    expect(mockTenantMemberFindMany.mock.calls[0][0]).toEqual({
      where: { tenantId: "tenant-1", deactivatedAt: { not: null } },
      select: { userId: true },
    });
    expect(mockDepartureFindMany.mock.calls[0][0]).toEqual({ where: { tenantId: "tenant-1" }, select: { userId: true } });
    expect(mockTeamFindMany.mock.calls[0][0].where).toEqual({
      tenantId: "tenant-1",
      members: {
        none: { role: TEAM_ROLE.OWNER, deactivatedAt: null, userId: { notIn: expect.any(Array) } },
      },
    });
    expect(JSON.stringify(mockTeamFindMany.mock.calls[0][0].where)).not.toContain("user\"");
    expect(mockTeamFindMany.mock.calls[0][0].select.members.where).toEqual({ deactivatedAt: null });
  });

  it("offers only members active in the actor's tenant — a guest from another tenant is not a candidate", async () => {
    mockTeamFindMany.mockResolvedValue([
      team("team-1", [{ userId: "local", role: "ADMIN" }, { userId: "guest", role: "MEMBER" }]),
    ]);
    seedTenant([{ userId: "local" }]);

    const json = await (await GET(createRequest("GET", "http://localhost:3000/api/tenant/teams/ownerless"))).json();

    expect(json.teams[0].members.map((m: { userId: string }) => m.userId)).toEqual(["local"]);
    expect(mockTenantMemberFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: "tenant-1", userId: { in: ["local", "guest"] } },
    }));
  });

  it("does not offer a tenant ADMIN themselves (the owner route refuses it), but offers the tenant OWNER", async () => {
    mockTeamFindMany.mockResolvedValue([team("team-1", [{ userId: "admin-1", role: "ADMIN" }, { userId: "other", role: "MEMBER" }])]);
    seedTenant([{ userId: "admin-1" }, { userId: "other" }]);

    const asAdmin = await (await GET(createRequest("GET", "http://localhost:3000/api/tenant/teams/ownerless"))).json();
    expect(asAdmin.teams[0].members.map((m: { userId: string }) => m.userId)).toEqual(["other"]);

    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant-1", role: "OWNER" });
    const asOwner = await (await GET(createRequest("GET", "http://localhost:3000/api/tenant/teams/ownerless"))).json();
    expect(asOwner.teams[0].members.map((m: { userId: string }) => m.userId)).toEqual(["admin-1", "other"]);
  });

  describe("a leftover OWNER counts as absent", () => {
    it("lists a team whose only OWNER is a leftover (departed after admission), without offering them", async () => {
      mockTeamFindMany.mockResolvedValue([team("t", [{ userId: "owner", role: "OWNER" }, { userId: "live", role: "MEMBER" }])]);
      seedTenant([{ userId: "owner" }, { userId: "live" }], [{ userId: "owner", departedAt: AFTER }]);

      const teams = await listed();

      expect(teams.map((t) => t.id)).toEqual(["t"]);
      expect(teams[0].members.map((m) => m.userId)).toEqual(["live"]);
    });

    it("lists a team whose OWNER departed exactly at admission (boundary)", async () => {
      mockTeamFindMany.mockResolvedValue([team("t", [{ userId: "owner", role: "OWNER", admittedAt: ADMITTED, createdAt: BEFORE }])]);
      seedTenant([{ userId: "owner" }], [{ userId: "owner", departedAt: ADMITTED }]);

      expect((await listed()).map((t) => t.id)).toEqual(["t"]);
    });

    it("lists a team whose OWNER's tenant row is deactivated but whose team row was missed", async () => {
      mockTeamFindMany.mockResolvedValue([team("t", [{ userId: "owner", role: "OWNER" }])]);
      seedTenant([{ userId: "owner", deactivatedAt: AFTER }]);

      expect((await listed()).map((t) => t.id)).toEqual(["t"]);
    });

    it("does not list a team whose OWNER is active and not a leftover", async () => {
      mockTeamFindMany.mockResolvedValue([team("t", [{ userId: "owner", role: "OWNER" }])]);
      seedTenant([{ userId: "owner" }]);

      expect(await listed()).toEqual([]);
    });

    it("does not list a team with a leftover OWNER row AND a live one", async () => {
      mockTeamFindMany.mockResolvedValue([team("t", [{ userId: "gone", role: "OWNER" }, { userId: "owner", role: "OWNER" }])]);
      seedTenant([{ userId: "gone" }, { userId: "owner" }], [{ userId: "gone", departedAt: AFTER }]);

      expect(await listed()).toEqual([]);
    });

    it("does not list a team whose OWNER was re-admitted after their departure", async () => {
      mockTeamFindMany.mockResolvedValue([team("t", [{ userId: "owner", role: "OWNER", admittedAt: AFTER, createdAt: BEFORE }])]);
      seedTenant([{ userId: "owner" }], [{ userId: "owner", departedAt: ADMITTED }]);

      expect(await listed()).toEqual([]);
    });

    it("does not list a team whose OWNER is a guest with no tenant row here", async () => {
      mockTeamFindMany.mockResolvedValue([team("t", [{ userId: "guest", role: "OWNER" }])]);
      seedTenant([]);

      expect(await listed()).toEqual([]);
    });

    it("offers a re-admitted member but not a leftover one", async () => {
      mockTeamFindMany.mockResolvedValue([team("t", [
        { userId: "back", role: "ADMIN", admittedAt: AFTER, createdAt: BEFORE },
        { userId: "left", role: "MEMBER" },
      ])]);
      seedTenant([{ userId: "back" }, { userId: "left" }], [
        { userId: "back", departedAt: ADMITTED },
        { userId: "left", departedAt: AFTER },
      ]);

      expect((await listed())[0].members.map((m) => m.userId)).toEqual(["back"]);
    });

    it("reads the tenant rows of every candidate team's members in one read", async () => {
      mockTeamFindMany.mockResolvedValue([
        team("a", [{ userId: "u1", role: "ADMIN" }]),
        team("b", [{ userId: "u2", role: "ADMIN" }, { userId: "u1", role: "MEMBER" }]),
      ]);
      seedTenant([{ userId: "u1" }, { userId: "u2" }]);

      await listed();

      // One stamped-user pre-read and one readTenantRows for all candidates, not one per team.
      expect(mockTenantMemberFindMany).toHaveBeenCalledTimes(2);
      expect(mockDepartureFindMany).toHaveBeenCalledTimes(2);
      expect(mockDepartureFindMany.mock.calls[1][0].where.userId.in).toEqual(["u1", "u2"]);
    });

    it("propagates a failed tenant-row read instead of treating it as \"not leftover\"", async () => {
      mockTeamFindMany.mockResolvedValue([team("t", [{ userId: "owner", role: "OWNER" }])]);
      mockDepartureFindMany.mockRejectedValue(new Error("db down"));

      await expect(GET(createRequest("GET", "http://localhost:3000/api/tenant/teams/ownerless"))).rejects.toThrow("db down");
    });
  });
});
