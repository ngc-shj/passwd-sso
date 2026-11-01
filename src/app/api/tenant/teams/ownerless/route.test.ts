import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockRequireTenantPermission, mockTeamFindMany, mockTenantMemberFindMany, mockBuildDisplay } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTenantPermission: vi.fn(),
  mockTeamFindMany: vi.fn(),
  mockTenantMemberFindMany: vi.fn(),
  mockBuildDisplay: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/auth/access/tenant-auth", () => ({ requireTenantPermission: mockRequireTenantPermission }));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: async (_prisma: unknown, _tenantId: string, fn: (tx: unknown) => unknown) =>
    fn({ team: { findMany: mockTeamFindMany }, tenantMember: { findMany: mockTenantMemberFindMany } }),
}));
vi.mock("@/lib/team/team-member-display", () => ({ buildTeamMemberDisplayItems: mockBuildDisplay }));

import { GET } from "./route";
import { TEAM_ROLE } from "@/lib/constants";
import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";

describe("GET /api/tenant/teams/ownerless", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "admin-1" } });
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant-1", role: "ADMIN" });
    mockTeamFindMany.mockResolvedValue([]);
    mockTenantMemberFindMany.mockResolvedValue([]);
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
      { id: "team-1", name: "Core", slug: "core", members: [{ id: "m1", userId: "u1", role: "ADMIN", createdAt: new Date() }] },
    ]);
    mockTenantMemberFindMany.mockResolvedValue([{ userId: "u1" }]);
    mockBuildDisplay.mockResolvedValue([{ userId: "u1", role: "ADMIN", name: "Ann", email: "ann@test.com" }]);

    const res = await GET(createRequest("GET", "http://localhost:3000/api/tenant/teams/ownerless"));
    const json = await res.json();

    expect(json.teams).toEqual([
      { id: "team-1", name: "Core", slug: "core", members: [{ userId: "u1", role: "ADMIN", name: "Ann", email: "ann@test.com" }] },
    ]);
    expect(mockTeamFindMany.mock.calls[0][0].where).toEqual({
      tenantId: "tenant-1",
      members: { none: { role: TEAM_ROLE.OWNER, deactivatedAt: null } },
    });
    expect(mockTeamFindMany.mock.calls[0][0].select.members.where).toEqual({ deactivatedAt: null });
  });

  it("offers only members active in the actor's tenant — a guest from another tenant is not a candidate", async () => {
    mockTeamFindMany.mockResolvedValue([
      { id: "team-1", name: "Core", slug: "core", members: [
        { id: "m1", userId: "local", role: "ADMIN", createdAt: new Date() },
        { id: "m2", userId: "guest", role: "MEMBER", createdAt: new Date() },
      ] },
    ]);
    mockTenantMemberFindMany.mockResolvedValue([{ userId: "local" }]);

    const json = await (await GET(createRequest("GET", "http://localhost:3000/api/tenant/teams/ownerless"))).json();

    expect(json.teams[0].members.map((m: { userId: string }) => m.userId)).toEqual(["local"]);
    expect(mockTenantMemberFindMany).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1", userId: { in: ["local", "guest"] }, deactivatedAt: null },
      select: { userId: true },
    });
  });

  it("does not offer a tenant ADMIN themselves (the owner route refuses it), but offers the tenant OWNER", async () => {
    const teams = [{ id: "team-1", name: "Core", slug: "core", members: [
      { id: "m1", userId: "admin-1", role: "ADMIN", createdAt: new Date() },
      { id: "m2", userId: "other", role: "MEMBER", createdAt: new Date() },
    ] }];
    mockTeamFindMany.mockResolvedValue(teams);
    mockTenantMemberFindMany.mockResolvedValue([{ userId: "admin-1" }, { userId: "other" }]);

    const asAdmin = await (await GET(createRequest("GET", "http://localhost:3000/api/tenant/teams/ownerless"))).json();
    expect(asAdmin.teams[0].members.map((m: { userId: string }) => m.userId)).toEqual(["other"]);

    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant-1", role: "OWNER" });
    const asOwner = await (await GET(createRequest("GET", "http://localhost:3000/api/tenant/teams/ownerless"))).json();
    expect(asOwner.teams[0].members.map((m: { userId: string }) => m.userId)).toEqual(["admin-1", "other"]);
  });
});
