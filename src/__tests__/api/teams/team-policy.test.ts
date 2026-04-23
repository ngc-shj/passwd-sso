import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import {
  createRequest,
  createParams,
  parseResponse,
} from "../../helpers/request-builder";

const {
  mockAuth,
  mockRequireTeamMember,
  mockRequireTeamPermission,
  mockFindUnique,
  mockTeamFindUnique,
  mockUpsert,
  mockLogAudit,
  mockWithTeamTenantRls,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTeamMember: vi.fn(),
  mockRequireTeamPermission: vi.fn(),
  mockFindUnique: vi.fn(),
  mockTeamFindUnique: vi.fn(),
  mockUpsert: vi.fn(),
  mockLogAudit: vi.fn(),
  mockWithTeamTenantRls: vi.fn(
    async (_teamId: string, fn: (tenantId: string) => unknown) => fn("tenant-1"),
  ),
}));

const { TeamAuthError } = vi.hoisted(() => {
  class TeamAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "TeamAuthError";
      this.status = status;
    }
  }
  return { TeamAuthError };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamPolicy: {
      findUnique: mockFindUnique,
      upsert: mockUpsert,
    },
    team: {
      findUnique: mockTeamFindUnique,
    },
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
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: vi.fn(async (_p: unknown, fn: () => unknown) => fn()),
}));
vi.mock("@/lib/auth/session-timeout", () => ({
  invalidateSessionTimeoutCacheForTenant: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "Test" }),
  teamAuditBase: vi.fn((_, userId, teamId) => ({ scope: "TEAM", userId, teamId })),
}));
vi.mock("@/lib/with-request-log", () => ({
  withRequestLog: (fn: (...args: unknown[]) => unknown) => fn,
}));

import { GET, PUT } from "@/app/api/teams/[teamId]/policy/route";

const TEAM_ID = "team-1";
const params = createParams({ teamId: TEAM_ID });

describe("GET /api/teams/[teamId]/policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("GET", `http://localhost/api/teams/${TEAM_ID}/policy`);
    const res = await GET(req, params);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 404 when user is not a team member", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamMember.mockRejectedValue(
      new TeamAuthError("NOT_FOUND", 404),
    );

    const req = createRequest("GET", `http://localhost/api/teams/${TEAM_ID}/policy`);
    const res = await GET(req, params);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(404);
    expect(json.error).toBe("NOT_FOUND");
  });

  it("returns defaults when no policy exists", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamMember.mockResolvedValue({ role: "MEMBER" });
    mockFindUnique.mockResolvedValue(null);

    const req = createRequest("GET", `http://localhost/api/teams/${TEAM_ID}/policy`);
    const res = await GET(req, params);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.minPasswordLength).toBe(0);
    expect(json.requireUppercase).toBe(false);
    expect(json.allowExport).toBe(true);
    expect(json.allowSharing).toBe(true);
  });

  it("returns stored policy when it exists", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamMember.mockResolvedValue({ role: "ADMIN" });
    mockFindUnique.mockResolvedValue({
      minPasswordLength: 12,
      requireUppercase: true,
      requireLowercase: true,
      requireNumbers: true,
      requireSymbols: false,
      maxSessionDurationMinutes: 480,
      requireRepromptForAll: false,
      allowExport: false,
      allowSharing: true,
    });

    const req = createRequest("GET", `http://localhost/api/teams/${TEAM_ID}/policy`);
    const res = await GET(req, params);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.minPasswordLength).toBe(12);
    expect(json.requireUppercase).toBe(true);
    expect(json.allowExport).toBe(false);
  });
});

describe("PUT /api/teams/[teamId]/policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("PUT", `http://localhost/api/teams/${TEAM_ID}/policy`, {
      body: { minPasswordLength: 8 },
    });
    const res = await PUT(req, params);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 403 when user lacks TEAM_UPDATE permission", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockRejectedValue(
      new TeamAuthError("FORBIDDEN", 403),
    );

    const req = createRequest("PUT", `http://localhost/api/teams/${TEAM_ID}/policy`, {
      body: { minPasswordLength: 8 },
    });
    const res = await PUT(req, params);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
  });

  it("returns 400 for invalid body", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue({ role: "ADMIN" });

    const req = createRequest("PUT", `http://localhost/api/teams/${TEAM_ID}/policy`, {
      body: { minPasswordLength: -5 },
    });
    const res = await PUT(req, params);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("upserts policy successfully and logs audit", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue({ role: "OWNER" });
    mockTeamFindUnique.mockResolvedValue({
      tenantId: "tenant-1",
      tenant: { sessionIdleTimeoutMinutes: 1440, sessionAbsoluteTimeoutMinutes: 43200 },
    });

    const policyData = {
      minPasswordLength: 12,
      requireUppercase: true,
      requireLowercase: true,
      requireNumbers: true,
      requireSymbols: false,
      maxSessionDurationMinutes: null,
      requireRepromptForAll: false,
      allowExport: true,
      allowSharing: true,
    };

    mockUpsert.mockResolvedValue(policyData);

    const req = createRequest("PUT", `http://localhost/api/teams/${TEAM_ID}/policy`, {
      body: policyData,
    });
    const res = await PUT(req, params);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.minPasswordLength).toBe(12);
    expect(json.requireUppercase).toBe(true);

    expect(mockUpsert).toHaveBeenCalledWith({
      where: { teamId: TEAM_ID },
      create: expect.objectContaining({
        teamId: TEAM_ID,
        tenantId: "tenant-1",
        minPasswordLength: 12,
      }),
      update: expect.objectContaining({
        minPasswordLength: 12,
      }),
    });

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "POLICY_UPDATE",
        teamId: TEAM_ID,
      }),
    );
  });

});
