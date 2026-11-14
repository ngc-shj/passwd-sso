import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import { createRequest, createParams, parseResponse } from "../../helpers/request-builder";

const {
  mockAuth,
  mockRequireTeamPermission,
  mockInvitationFindMany,
  mockInvitationFindFirst,
  mockInvitationCreate,
  mockPrismaTeam,
  mockUserFindUnique,
  mockTeamMemberFindUnique,
  mockWithTeamTenantRls,
  mockWithBypassRls,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTeamPermission: vi.fn(),
  mockInvitationFindMany: vi.fn(),
  mockInvitationFindFirst: vi.fn(),
  mockInvitationCreate: vi.fn(),
  mockPrismaTeam: { findUnique: vi.fn() },
  mockUserFindUnique: vi.fn(),
  mockTeamMemberFindUnique: vi.fn(),
  // The issuing transaction runs as fn(tenantId, tx); tx is the prisma mock.
  mockWithTeamTenantRls: vi.fn(async (_teamId: string, fn: (tenantId: string, tx: unknown) => unknown) =>
    fn("tenant-1", (await import("@/lib/prisma")).prisma)),
  mockWithBypassRls: vi.fn(async (prisma: unknown, fn: (tx: unknown) => unknown) => fn(prisma)),
}));

const { mockUserFindMany, mockTeamMemberFindMany, mockTeamMemberFindFirst, mockLockTenantRows, mockExecuteRaw, mockLockTeamsAgainstRotation } = vi.hoisted(() => ({
  mockExecuteRaw: vi.fn().mockResolvedValue(undefined),
  mockLockTeamsAgainstRotation: vi.fn().mockResolvedValue(undefined),
  mockUserFindMany: vi.fn().mockResolvedValue([]),
  mockTeamMemberFindMany: vi.fn(),
  mockTeamMemberFindFirst: vi.fn(),
  mockLockTenantRows: vi.fn(),
}));
vi.mock("@/lib/team/team-key-rotation-lock", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  lockTeamsAgainstRotation: mockLockTeamsAgainstRotation,
}));
vi.mock("@/lib/team/tenant-row-lock", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  lockTenantRows: mockLockTenantRows,
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/auth/access/team-auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/access/team-auth")>("@/lib/auth/access/team-auth");
  class TeamAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "TeamAuthError";
      this.status = status;
    }
  }
  return {
    requireTeamPermission: mockRequireTeamPermission,
    // The real role → permission table: POST re-checks the inviter's role under the lock.
    hasTeamPermission: actual.hasTeamPermission,
    activeTeamAdmission: actual.activeTeamAdmission,
    TeamAuthError,
  };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamInvitation: {
      findMany: mockInvitationFindMany,
      findFirst: mockInvitationFindFirst,
      create: mockInvitationCreate,
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    team: mockPrismaTeam,
    user: { findUnique: mockUserFindUnique, findMany: mockUserFindMany },
    teamMember: { findUnique: mockTeamMemberFindUnique, findMany: mockTeamMemberFindMany, findFirst: mockTeamMemberFindFirst },
    $executeRaw: mockExecuteRaw,
  },
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: vi.fn(),
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "Test" }),
  teamAuditBase: vi.fn((_, userId, teamId) => ({ scope: "TEAM", userId, teamId })),
}));
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: mockWithTeamTenantRls,
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));

import { GET, POST } from "@/app/api/teams/[teamId]/invitations/route";
import { TeamAuthError } from "@/lib/auth/access/team-auth";

describe("GET /api/teams/[teamId]/invitations", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const req = createRequest("GET");
    const res = await GET(req, createParams({ teamId: "o1" }));
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 403 when lacking permission", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("FORBIDDEN", 403));
    const req = createRequest("GET");
    const res = await GET(req, createParams({ teamId: "o1" }));
    const { status } = await parseResponse(res);
    expect(status).toBe(403);
  });

  it("returns pending invitations", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockUserFindMany.mockResolvedValue([{ id: "u1", name: "Admin", email: "admin@test.com", image: null }]);
    mockInvitationFindMany.mockResolvedValue([
      {
        id: "inv-1",
        email: "new@test.com",
        role: "MEMBER",
        token: "tok",
        status: "PENDING",
        expiresAt: new Date(),
        invitedById: "u1",
        createdAt: new Date(),
      },
    ]);
    const req = createRequest("GET");
    const res = await GET(req, createParams({ teamId: "o1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json).toHaveLength(1);
    expect(json[0].email).toBe("new@test.com");
    expect(json[0].invitedBy).toEqual({ id: "u1", name: "Admin", email: "admin@test.com" });
  });
});

const ACTOR_ADMITTED_AT = new Date("2026-03-01T00:00:00.000Z");

describe("POST /api/teams/[teamId]/invitations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrismaTeam.findUnique.mockResolvedValue({ tenantId: "tenant-1" });
    // The invitee lookup is case-insensitive (findMany); the pending check
    // runs inside the issuing transaction (findMany), under the tenant rows.
    mockUserFindMany.mockResolvedValue([]);
    mockTeamMemberFindMany.mockResolvedValue([]);
    mockInvitationFindMany.mockResolvedValue([]);
    mockLockTenantRows.mockResolvedValue(new Map());
    // The inviter's membership, re-read under their tenant row: an active ADMIN.
    mockTeamMemberFindFirst.mockResolvedValue({ role: "ADMIN", admittedAt: ACTOR_ADMITTED_AT, createdAt: ACTOR_ADMITTED_AT });
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const req = createRequest("POST", undefined, { body: { email: "a@b.com", role: "MEMBER" } });
    const res = await POST(req, createParams({ teamId: "o1" }));
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 403 when lacking permission", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("FORBIDDEN", 403));
    const req = createRequest("POST", undefined, { body: { email: "a@b.com", role: "MEMBER" } });
    const res = await POST(req, createParams({ teamId: "o1" }));
    const { status } = await parseResponse(res);
    expect(status).toBe(403);
  });

  it("returns 400 for invalid JSON", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/teams/o1/invitations", {
      method: "POST",
      body: "not json",
      headers: { "Content-Type": "text/plain" },
    });
    const res = await POST(req, createParams({ teamId: "o1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("INVALID_JSON");
  });

  it("returns 400 for validation error", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    const req = createRequest("POST", undefined, { body: { email: "not-email" } });
    const res = await POST(req, createParams({ teamId: "o1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 409 when user is already a member", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockUserFindMany.mockResolvedValue([{ id: "u2" }]);
    mockTeamMemberFindMany.mockResolvedValue([{ deactivatedAt: null, scimManaged: false, deactivatedByTenant: false }]);
    const req = createRequest("POST", undefined, { body: { email: "existing@test.com", role: "MEMBER" } });
    const res = await POST(req, createParams({ teamId: "o1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(409);
    expect(json.error).toBe("ALREADY_A_MEMBER");
  });

  it("returns 409 when pending invitation exists", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockInvitationFindMany.mockResolvedValue([{ id: "inv-existing", createdAt: new Date(), expiresAt: new Date("2999-01-01T00:00:00Z") }]);
    const req = createRequest("POST", undefined, { body: { email: "new@test.com", role: "MEMBER" } });
    const res = await POST(req, createParams({ teamId: "o1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(409);
    expect(json.error).toBe("INVITATION_ALREADY_SENT");
  });

  it("creates invitation successfully", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    const created = {
      id: "inv-1",
      email: "new@test.com",
      role: "MEMBER",
      token: "abc",
      expiresAt: new Date(),
      createdAt: new Date(),
    };
    mockInvitationCreate.mockResolvedValue(created);
    const req = createRequest("POST", undefined, { body: { email: "new@test.com", role: "MEMBER" } });
    const res = await POST(req, createParams({ teamId: "o1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(201);
    expect(json.email).toBe("new@test.com");
  });

  it("allows inviting user who exists but is not a member", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockUserFindMany.mockResolvedValue([{ id: "u2" }]);
    const created = {
      id: "inv-2",
      email: "nonmember@test.com",
      role: "MEMBER",
      token: "def",
      expiresAt: new Date(),
      createdAt: new Date(),
    };
    mockInvitationCreate.mockResolvedValue(created);
    const req = createRequest("POST", undefined, { body: { email: "nonmember@test.com", role: "MEMBER" } });
    const res = await POST(req, createParams({ teamId: "o1" }));
    const { status } = await parseResponse(res);
    expect(status).toBe(201);
  });

  describe("an inviter who left the tenant, judged against their admission to the team", () => {
    const actorRow = (deactivatedAt: Date | null, departedAt: Date | null = null) =>
      new Map([[DEFAULT_SESSION.user.id, { hasRow: true, role: null, deactivatedAt, departedAt }]]);
    const after = (ms: number) => new Date(ACTOR_ADMITTED_AT.getTime() + ms);
    const invite = async () => {
      mockAuth.mockResolvedValue(DEFAULT_SESSION);
      mockRequireTeamPermission.mockResolvedValue(undefined);
      mockInvitationCreate.mockResolvedValue({ id: "inv-3", email: "new@test.com", role: "MEMBER", token: "t", expiresAt: new Date(), createdAt: new Date() });
      const req = createRequest("POST", undefined, { body: { email: "new@test.com", role: "MEMBER" } });
      return (await parseResponse(await POST(req, createParams({ teamId: "o1" })))).status;
    };

    it("refuses an ADMIN inviter whose tenant row departed after their admission", async () => {
      mockLockTenantRows.mockResolvedValue(actorRow(after(1)));
      expect(await invite()).toBe(403);
      expect(mockInvitationCreate).not.toHaveBeenCalled();
    });

    it("allows a guest inviter, an active one, a re-admitted one and a re-provisioned one", async () => {
      for (const rows of [new Map(), actorRow(null), actorRow(after(-1000)), actorRow(null, after(-1000))]) {
        mockLockTenantRows.mockResolvedValue(rows);
        expect(await invite()).toBe(201);
      }
    });
  });

  describe("expired PENDING invitations", () => {
    const clock = new Date("2026-06-01T00:00:00Z");
    const created = {
      id: "inv-new",
      email: "new@test.com",
      role: "MEMBER",
      token: "abc",
      expiresAt: clock,
      createdAt: clock,
    };
    const invite = () =>
      POST(
        createRequest("POST", undefined, { body: { email: "new@test.com", role: "MEMBER" } }),
        createParams({ teamId: "o1" }),
      );

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(clock);
      mockAuth.mockResolvedValue(DEFAULT_SESSION);
      mockRequireTeamPermission.mockResolvedValue(undefined);
      mockInvitationCreate.mockResolvedValue(created);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("issues a new invitation when the only PENDING one has expired", async () => {
      mockInvitationFindMany.mockResolvedValue([
        { id: "inv-expired", createdAt: new Date("2026-05-01T00:00:00Z"), expiresAt: new Date(clock.getTime() - 1) },
      ]);
      const { status } = await parseResponse(await invite());
      expect(status).toBe(201);
    });

    it("treats a PENDING invitation expiring at the current instant as still live, as accept does", async () => {
      mockInvitationFindMany.mockResolvedValue([
        { id: "inv-boundary", createdAt: new Date("2026-05-01T00:00:00Z"), expiresAt: new Date(clock.getTime()) },
      ]);
      const { status, json } = await parseResponse(await invite());
      expect(status).toBe(409);
      expect(json.error).toBe("INVITATION_ALREADY_SENT");
    });

    it("returns 409 when a live PENDING invitation sits beside an expired one", async () => {
      mockInvitationFindMany.mockResolvedValue([
        { id: "inv-expired", createdAt: new Date("2026-05-01T00:00:00Z"), expiresAt: new Date(clock.getTime() - 1) },
        { id: "inv-live", createdAt: new Date("2026-05-30T00:00:00Z"), expiresAt: new Date(clock.getTime() + 1) },
      ]);
      const { status, json } = await parseResponse(await invite());
      expect(status).toBe(409);
      expect(json.error).toBe("INVITATION_ALREADY_SENT");
    });
  });
});
