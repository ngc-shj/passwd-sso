import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockPrismaTeamMember, mockPrismaTenantMember, mockPrismaTenantMemberDeparture, mockWithBypassRls } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaTeamMember: { findMany: vi.fn() },
  mockPrismaTenantMember: { findMany: vi.fn() },
  mockPrismaTenantMemberDeparture: { findMany: vi.fn() },
  mockWithBypassRls: vi.fn(async (prisma: unknown, fn: (tx: unknown) => unknown) => fn(prisma)),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamMember: mockPrismaTeamMember,
    tenantMember: mockPrismaTenantMember,
    tenantMemberDeparture: mockPrismaTenantMemberDeparture,
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));

import { GET } from "./route";

describe("GET /api/teams/pending-key-distributions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "admin-user" } });
    mockPrismaTenantMember.findMany.mockResolvedValue([]);
    mockPrismaTenantMemberDeparture.findMany.mockResolvedValue([]);
  });

  const T_ADMITTED = new Date("2025-01-01T00:00:00Z");
  const T_DEPARTED = new Date("2025-06-01T00:00:00Z");
  const adminOf = (teamId: string, tenantId = "tenant-1") => ({
    teamId,
    userId: "admin-user",
    tenantId,
    admittedAt: null,
    createdAt: T_ADMITTED,
  });
  const pendingOf = (id: string, teamId: string, userId: string, tenantId = "tenant-1") => ({
    id,
    teamId,
    userId,
    tenantId,
    admittedAt: null,
    createdAt: T_ADMITTED,
    user: { ecdhPublicKey: `pub-${userId}` },
    team: { teamKeyVersion: 1 },
  });
  const departures = (byTenant: Record<string, string[]>) =>
    mockPrismaTenantMemberDeparture.findMany.mockImplementation(
      async ({ where }: { where: { tenantId: string } }) =>
        (byTenant[where.tenantId] ?? []).map((userId) => ({ userId, departedAt: T_DEPARTED })),
    );

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
      adminOf("team-1"),
      adminOf("team-2"),
    ]);
    // Second call: pending members
    mockPrismaTeamMember.findMany.mockResolvedValueOnce([
      {
        id: "member-1",
        teamId: "team-1",
        userId: "pending-user",
        tenantId: "tenant-1",
        admittedAt: null,
        createdAt: T_ADMITTED,
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
      .mockResolvedValueOnce([adminOf("team-1")])
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

  it("contributes no team for a leftover admin: the actor left the team's tenant after admission", async () => {
    mockPrismaTeamMember.findMany.mockResolvedValueOnce([adminOf("team-left", "tenant-1")]);
    departures({ "tenant-1": ["admin-user"] });

    const res = await GET();
    expect(await res.json()).toEqual([]);
    // No team survives, so the recipients are never read.
    expect(mockPrismaTeamMember.findMany).toHaveBeenCalledTimes(1);
  });

  it("keeps the admin's team in a tenant they are a guest of, dropping only the departed pair's team", async () => {
    mockPrismaTeamMember.findMany
      .mockResolvedValueOnce([adminOf("team-t1", "tenant-1"), adminOf("team-t2", "tenant-2")])
      .mockResolvedValueOnce([]);
    departures({ "tenant-1": ["admin-user"] });

    await GET();

    expect(mockPrismaTeamMember.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ where: expect.objectContaining({ teamId: { in: ["team-t2"] } }) }),
    );
  });

  it("does not list a leftover recipient, matched per (tenant, user) pair", async () => {
    mockPrismaTeamMember.findMany
      .mockResolvedValueOnce([adminOf("team-1", "tenant-1"), adminOf("team-2", "tenant-2")])
      .mockResolvedValueOnce([
        pendingOf("m-left", "team-1", "u1", "tenant-1"),
        pendingOf("m-kept", "team-1", "u2", "tenant-1"),
        // u1 also left tenant-1 only; in tenant-2 they are a guest.
        pendingOf("m-guest", "team-2", "u1", "tenant-2"),
      ]);
    departures({ "tenant-1": ["u1"] });

    const res = await GET();
    const json = await res.json();
    expect(json.map((r: { memberId: string }) => r.memberId)).toEqual(["m-kept", "m-guest"]);
  });

  it("lists a re-admitted recipient: the departure predates admittedAt", async () => {
    mockPrismaTeamMember.findMany
      .mockResolvedValueOnce([adminOf("team-1")])
      .mockResolvedValueOnce([
        { ...pendingOf("m-back", "team-1", "u1"), admittedAt: new Date("2025-07-01T00:00:00Z") },
      ]);
    departures({ "tenant-1": ["u1"] });

    const res = await GET();
    expect((await res.json()).map((r: { memberId: string }) => r.memberId)).toEqual(["m-back"]);
  });

  it("selects the tenant and admission columns the leftover check needs on both reads", async () => {
    mockPrismaTeamMember.findMany
      .mockResolvedValueOnce([adminOf("team-1")])
      .mockResolvedValueOnce([]);

    await GET();

    const [adminSelect, pendingSelect] = mockPrismaTeamMember.findMany.mock.calls.map((c) => c[0].select);
    expect(adminSelect).toMatchObject({ tenantId: true, admittedAt: true, createdAt: true });
    expect(pendingSelect).toMatchObject({ tenantId: true, admittedAt: true, createdAt: true });
  });
});
