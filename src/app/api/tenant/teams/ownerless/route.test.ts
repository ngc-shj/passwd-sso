import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockRequireTenantPermission, mockTeamFindMany, mockBuildDisplay } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTenantPermission: vi.fn(),
  mockTeamFindMany: vi.fn(),
  mockBuildDisplay: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/auth/access/tenant-auth", () => ({ requireTenantPermission: mockRequireTenantPermission }));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: async (_prisma: unknown, _tenantId: string, fn: (tx: unknown) => unknown) =>
    fn({ team: { findMany: mockTeamFindMany } }),
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
    mockBuildDisplay.mockResolvedValue([]);
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
});
