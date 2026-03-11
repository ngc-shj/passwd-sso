import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const {
  mockAuth,
  mockPrismaTeam,
  mockPrismaTeamMember,
  mockPrismaTeamMemberKey,
  mockPrismaTenantMember,
  mockPrismaUser,
  mockPrismaTransaction,
  mockRequireTeamMember,
  mockRequireTeamPermission,
  TeamAuthError,
  mockWithTeamTenantRls,
  mockWithBypassRls,
  mockLogAudit,
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
    mockPrismaTeamMember: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    mockPrismaTeamMemberKey: { deleteMany: vi.fn() },
    mockPrismaTenantMember: { findMany: vi.fn(), findFirst: vi.fn() },
    mockPrismaUser: { findFirst: vi.fn() },
    mockPrismaTransaction: vi.fn(),
    mockRequireTeamMember: vi.fn(),
    mockRequireTeamPermission: vi.fn(),
    TeamAuthError: _TeamAuthError,
    mockWithTeamTenantRls: vi.fn(async (_teamId: string, fn: () => unknown) => fn()),
    mockWithBypassRls: vi.fn(async (_prisma: unknown, fn: () => unknown) => fn()),
    mockLogAudit: vi.fn(),
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    team: mockPrismaTeam,
    teamMember: mockPrismaTeamMember,
    teamMemberKey: mockPrismaTeamMemberKey,
    tenantMember: mockPrismaTenantMember,
    user: mockPrismaUser,
    $transaction: mockPrismaTransaction,
  },
}));
vi.mock("@/lib/team-auth", () => ({
  requireTeamMember: mockRequireTeamMember,
  requireTeamPermission: mockRequireTeamPermission,
  TeamAuthError,
}));
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: mockWithTeamTenantRls,
}));
vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: mockWithBypassRls,
}));
vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
  extractRequestMeta: vi.fn(() => ({ ip: "127.0.0.1", userAgent: "test" })),
}));

import { GET, POST } from "./route";
import { TEAM_ROLE } from "@/lib/constants";

const TEAM_ID = "team-123";
const TENANT_ID = "tenant-456";
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

describe("POST /api/teams/[teamId]/members", () => {
  const TARGET_USER_ID = "cjld2cjxh0000qzrmn831i7rn";

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockPrismaTeam.findUnique.mockResolvedValue({ tenantId: TENANT_ID });
    mockPrismaUser.findFirst.mockResolvedValue({ id: TARGET_USER_ID });
    mockPrismaTenantMember.findFirst.mockResolvedValue({ id: "tm-1" });
    mockPrismaTeamMember.findFirst.mockResolvedValue(null);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/members`, {
        body: { userId: TARGET_USER_ID, role: TEAM_ROLE.MEMBER },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when insufficient permission", async () => {
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("FORBIDDEN", 403));
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/members`, {
        body: { userId: TARGET_USER_ID, role: TEAM_ROLE.MEMBER },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 for invalid body", async () => {
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/members`, {
        body: { role: TEAM_ROLE.MEMBER },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("creates a new team member", async () => {
    mockPrismaTeamMember.create.mockResolvedValue({
      id: "new-m-1",
      userId: TARGET_USER_ID,
      role: TEAM_ROLE.MEMBER,
    });

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/members`, {
        body: { userId: TARGET_USER_ID, role: TEAM_ROLE.MEMBER },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json.userId).toBe(TARGET_USER_ID);
    expect(json.reactivated).toBe(false);
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
  });

  it("reactivates a deactivated member", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValue({
      id: "existing-m-1",
      userId: TARGET_USER_ID,
      deactivatedAt: new Date(),
      scimManaged: false,
    });
    mockPrismaTransaction.mockResolvedValue([
      {},
      { id: "existing-m-1", userId: TARGET_USER_ID, role: TEAM_ROLE.MEMBER },
    ]);

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/members`, {
        body: { userId: TARGET_USER_ID, role: TEAM_ROLE.MEMBER },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json.reactivated).toBe(true);
  });

  it("returns 409 for active member", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValue({
      id: "existing-m-1",
      userId: TARGET_USER_ID,
      deactivatedAt: null,
      scimManaged: false,
    });

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/members`, {
        body: { userId: TARGET_USER_ID, role: TEAM_ROLE.MEMBER },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("ALREADY_A_MEMBER");
  });

  it("returns 409 for SCIM-managed deactivated member", async () => {
    mockPrismaTeamMember.findFirst.mockResolvedValue({
      id: "existing-m-1",
      userId: TARGET_USER_ID,
      deactivatedAt: new Date(),
      scimManaged: true,
    });

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/members`, {
        body: { userId: TARGET_USER_ID, role: TEAM_ROLE.MEMBER },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("SCIM_MANAGED_MEMBER");
  });

  it("returns 404 when target user not in tenant", async () => {
    mockPrismaUser.findFirst.mockResolvedValue(null);

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/members`, {
        body: { userId: TARGET_USER_ID, role: TEAM_ROLE.MEMBER },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when user exists but has no active tenant membership", async () => {
    mockPrismaTenantMember.findFirst.mockResolvedValue(null);

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/members`, {
        body: { userId: TARGET_USER_ID, role: TEAM_ROLE.MEMBER },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 409 on Prisma unique constraint race condition", async () => {
    const p2002Error = Object.assign(new Error("Unique constraint"), {
      code: "P2002",
      meta: { target: ["teamId", "userId"] },
    });
    mockPrismaTeamMember.create.mockRejectedValue(p2002Error);

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/members`, {
        body: { userId: TARGET_USER_ID, role: TEAM_ROLE.MEMBER },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(409);
  });
});
