import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const {
  mockAuth,
  mockPrismaTeamPolicy,
  mockPrismaTeam,
  mockRequireTeamMember,
  mockRequireTeamPermission,
  mockWithTeamTenantRls,
  mockLogAudit,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaTeamPolicy: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
  mockPrismaTeam: {
    findUnique: vi.fn(),
  },
  mockRequireTeamMember: vi.fn(),
  mockRequireTeamPermission: vi.fn(),
  mockWithTeamTenantRls: vi.fn(
    async (_teamId: string, fn: (tenantId: string) => unknown) => fn("tenant-1"),
  ),
  mockLogAudit: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamPolicy: mockPrismaTeamPolicy,
    team: mockPrismaTeam,
  },
}));
vi.mock("@/lib/auth/team-auth", () => ({
  requireTeamMember: mockRequireTeamMember,
  requireTeamPermission: mockRequireTeamPermission,
  TeamAuthError: class TeamAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "TeamAuthError";
      this.status = status;
    }
  },
}));
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: mockWithTeamTenantRls,
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: vi.fn(async (_prisma: unknown, fn: () => unknown) => fn()),
}));
vi.mock("@/lib/auth/session-timeout", () => ({
  invalidateSessionTimeoutCacheForTenant: vi.fn(),
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: vi.fn(() => ({ ip: "127.0.0.1", userAgent: "test" })),
  teamAuditBase: vi.fn((_, userId, teamId) => ({ scope: "TEAM", userId, teamId })),
}));
vi.mock("@/lib/logger", () => ({
  default: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { GET, PUT } from "./route";

type Params = { params: Promise<{ teamId: string }> };

function teamParams(teamId: string = "team-1"): Params {
  return createParams({ teamId });
}

const DEFAULT_RESPONSE = {
  minPasswordLength: 0,
  requireUppercase: false,
  requireLowercase: false,
  requireNumbers: false,
  requireSymbols: false,
  maxSessionDurationMinutes: null,
  sessionIdleTimeoutMinutes: null,
  sessionAbsoluteTimeoutMinutes: null,
  requireRepromptForAll: false,
  allowExport: true,
  allowSharing: true,
  requireSharePassword: false,
};

describe("GET /api/teams/[teamId]/policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireTeamMember.mockResolvedValue({ role: "MEMBER" });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", "http://localhost:3000/api/teams/team-1/policy"),
      teamParams(),
    );
    expect(res.status).toBe(401);
  });

  it("returns defaults when no policy exists", async () => {
    mockPrismaTeamPolicy.findUnique.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", "http://localhost:3000/api/teams/team-1/policy"),
      teamParams(),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual(DEFAULT_RESPONSE);
  });

  it("returns saved policy values", async () => {
    mockPrismaTeamPolicy.findUnique.mockResolvedValue({
      minPasswordLength: 12,
      requireUppercase: true,
      requireLowercase: true,
      requireNumbers: true,
      requireSymbols: false,
      maxSessionDurationMinutes: 60,
      requireRepromptForAll: true,
      allowExport: false,
      allowSharing: true,
      requireSharePassword: false,
    });

    const res = await GET(
      createRequest("GET", "http://localhost:3000/api/teams/team-1/policy"),
      teamParams(),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.minPasswordLength).toBe(12);
    expect(json.requireUppercase).toBe(true);
    expect(json.allowExport).toBe(false);
    expect(json.maxSessionDurationMinutes).toBe(60);
  });
});

describe("PUT /api/teams/[teamId]/policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireTeamPermission.mockResolvedValue({ role: "ADMIN" });
    mockPrismaTeam.findUnique.mockResolvedValue({
      tenantId: "tenant-1",
      tenant: {
        sessionIdleTimeoutMinutes: 1440,
        sessionAbsoluteTimeoutMinutes: 43200,
      },
    });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await PUT(
      createRequest("PUT", "http://localhost:3000/api/teams/team-1/policy", {
        body: DEFAULT_RESPONSE,
      }),
      teamParams(),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when member lacks TEAM_UPDATE permission", async () => {
    const { TeamAuthError } = await import("@/lib/auth/team-auth");
    mockRequireTeamPermission.mockRejectedValue(
      new TeamAuthError("FORBIDDEN", 403),
    );

    const res = await PUT(
      createRequest("PUT", "http://localhost:3000/api/teams/team-1/policy", {
        body: DEFAULT_RESPONSE,
      }),
      teamParams(),
    );
    expect(res.status).toBe(403);
  });

  it("upserts policy and logs audit", async () => {
    const savedPolicy = {
      ...DEFAULT_RESPONSE,
      minPasswordLength: 16,
      requireUppercase: true,
    };
    mockPrismaTeamPolicy.upsert.mockResolvedValue(savedPolicy);

    const res = await PUT(
      createRequest("PUT", "http://localhost:3000/api/teams/team-1/policy", {
        body: { minPasswordLength: 16, requireUppercase: true },
      }),
      teamParams(),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.minPasswordLength).toBe(16);
    expect(json.requireUppercase).toBe(true);

    expect(mockPrismaTeamPolicy.upsert).toHaveBeenCalledWith({
      where: { teamId: "team-1" },
      create: expect.objectContaining({
        teamId: "team-1",
        tenantId: "tenant-1",
        minPasswordLength: 16,
        requireUppercase: true,
      }),
      update: expect.objectContaining({
        minPasswordLength: 16,
        requireUppercase: true,
      }),
    });

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "POLICY_UPDATE",
        userId: "user-1",
        teamId: "team-1",
      }),
    );
  });

  it("validates input — rejects invalid minPasswordLength", async () => {
    const res = await PUT(
      createRequest("PUT", "http://localhost:3000/api/teams/team-1/policy", {
        body: { minPasswordLength: -1 },
      }),
      teamParams(),
    );
    expect(res.status).toBe(400);
  });

  it("is idempotent — PUT twice returns same result", async () => {
    const policyData = {
      minPasswordLength: 8,
      requireUppercase: true,
      requireLowercase: true,
      requireNumbers: false,
      requireSymbols: false,
      maxSessionDurationMinutes: null,
      requireRepromptForAll: false,
      allowExport: true,
      allowSharing: true,
      requireSharePassword: false,
    };
    mockPrismaTeamPolicy.upsert.mockResolvedValue(policyData);

    const res1 = await PUT(
      createRequest("PUT", "http://localhost:3000/api/teams/team-1/policy", {
        body: policyData,
      }),
      teamParams(),
    );
    const json1 = await res1.json();

    const res2 = await PUT(
      createRequest("PUT", "http://localhost:3000/api/teams/team-1/policy", {
        body: policyData,
      }),
      teamParams(),
    );
    const json2 = await res2.json();

    expect(json1).toEqual(json2);
  });
});
