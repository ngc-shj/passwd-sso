import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockPrismaUserFindMany,
  mockPrismaTenantMemberFindMany,
  mockWithBypassRls,
} = vi.hoisted(() => ({
  mockPrismaUserFindMany: vi.fn(),
  mockPrismaTenantMemberFindMany: vi.fn(),
  mockWithBypassRls: vi.fn(async (prisma: unknown, fn: (tx: unknown) => unknown) => fn(prisma)),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findMany: mockPrismaUserFindMany },
    tenantMember: { findMany: mockPrismaTenantMemberFindMany },
  },
}));

vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: mockWithBypassRls,
  BYPASS_PURPOSE: { CROSS_TENANT_LOOKUP: "cross_tenant_lookup" },
}));

import { buildTeamMemberDisplayItems } from "./team-member-display";

describe("buildTeamMemberDisplayItems", () => {
  const now = new Date("2026-05-08T00:00:00.000Z");

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an empty list without cross-tenant lookups when no members are given", async () => {
    const result = await buildTeamMemberDisplayItems([]);

    expect(result).toEqual([]);
    expect(mockWithBypassRls).not.toHaveBeenCalled();
    expect(mockPrismaUserFindMany).not.toHaveBeenCalled();
    expect(mockPrismaTenantMemberFindMany).not.toHaveBeenCalled();
  });

  it("hydrates member display fields from cross-tenant user and tenant lookups", async () => {
    mockPrismaUserFindMany.mockResolvedValue([
      { id: "u1", name: "Owner", email: "owner@test.com", image: null },
      { id: "u2", name: "Guest", email: "guest@test.com", image: "guest.png" },
    ]);
    mockPrismaTenantMemberFindMany.mockResolvedValue([
      { userId: "u1", tenant: { name: "Home Tenant" } },
      { userId: "u2", tenant: { name: "Guest Tenant" } },
    ]);

    const result = await buildTeamMemberDisplayItems([
      { id: "m1", userId: "u1", role: "OWNER", createdAt: now },
      { id: "m2", userId: "u2", role: "MEMBER", createdAt: now, departed: true },
    ]);

    expect(result).toEqual([
      {
        id: "m1",
        userId: "u1",
        role: "OWNER",
        name: "Owner",
        email: "owner@test.com",
        image: null,
        joinedAt: now,
        tenantName: "Home Tenant",
        departed: false,
        pendingApproval: false,
        pendingTenantInactive: false,
      },
      {
        id: "m2",
        userId: "u2",
        role: "MEMBER",
        name: "Guest",
        email: "guest@test.com",
        image: "guest.png",
        joinedAt: now,
        tenantName: "Guest Tenant",
        departed: true,
        pendingApproval: false,
        pendingTenantInactive: false,
      },
    ]);
    expect(mockWithBypassRls).toHaveBeenCalledTimes(1);
    expect(mockPrismaUserFindMany).toHaveBeenCalledWith({
      where: { id: { in: ["u1", "u2"] } },
      select: { id: true, name: true, email: true, image: true },
    });
    expect(mockPrismaTenantMemberFindMany).toHaveBeenCalledWith({
      where: { userId: { in: ["u1", "u2"] }, deactivatedAt: null },
      select: { userId: true, tenantId: true, tenant: { select: { name: true } } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  });

  it("drops members whose user profile is not visible in the bypass lookup", async () => {
    mockPrismaUserFindMany.mockResolvedValue([
      { id: "u1", name: "Owner", email: "owner@test.com", image: null },
    ]);
    mockPrismaTenantMemberFindMany.mockResolvedValue([
      { userId: "u1", tenant: { name: "Home Tenant" } },
      { userId: "u2", tenant: { name: "Guest Tenant" } },
    ]);

    const result = await buildTeamMemberDisplayItems([
      { id: "m1", userId: "u1", role: "OWNER", createdAt: now },
      { id: "m2", userId: "u2", role: "MEMBER", createdAt: now },
    ]);

    expect(result).toEqual([
      {
        id: "m1",
        userId: "u1",
        role: "OWNER",
        name: "Owner",
        email: "owner@test.com",
        image: null,
        joinedAt: now,
        tenantName: "Home Tenant",
        departed: false,
        pendingApproval: false,
        pendingTenantInactive: false,
      },
    ]);
  });

  // F1: pendingTenantInactive compares the user's active tenant row against
  // the team's own tenant (passed as the second arg) — not just "does an
  // active tenant row exist anywhere".
  it("flags pendingTenantInactive only for a pending row whose active tenant differs from the team's own", async () => {
    mockPrismaUserFindMany.mockResolvedValue([
      { id: "u1", name: "In team tenant", email: "u1@test.com", image: null },
      { id: "u2", name: "In another tenant", email: "u2@test.com", image: null },
      { id: "u3", name: "No active tenant", email: "u3@test.com", image: null },
    ]);
    mockPrismaTenantMemberFindMany.mockResolvedValue([
      { userId: "u1", tenantId: "team-tenant", tenant: { name: "Team Tenant" } },
      { userId: "u2", tenantId: "other-tenant", tenant: { name: "Other Tenant" } },
    ]);

    const result = await buildTeamMemberDisplayItems(
      [
        { id: "m1", userId: "u1", role: "ADMIN", createdAt: now, pendingApproval: true },
        { id: "m2", userId: "u2", role: "ADMIN", createdAt: now, pendingApproval: true },
        { id: "m3", userId: "u3", role: "ADMIN", createdAt: now, pendingApproval: true },
      ],
      "team-tenant",
    );

    expect(result.map((m) => [m.id, m.pendingTenantInactive])).toEqual([
      ["m1", false],
      ["m2", true],
      ["m3", true],
    ]);
  });

  it("never flags pendingTenantInactive on a non-pending row, even without the team's tenantId", async () => {
    mockPrismaUserFindMany.mockResolvedValue([
      { id: "u1", name: "Active", email: "u1@test.com", image: null },
    ]);
    mockPrismaTenantMemberFindMany.mockResolvedValue([]);

    const result = await buildTeamMemberDisplayItems([
      { id: "m1", userId: "u1", role: "MEMBER", createdAt: now },
    ]);

    expect(result[0]?.pendingTenantInactive).toBe(false);
  });
});
