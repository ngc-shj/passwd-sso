import { describe, it, expect, vi, beforeEach } from "vitest";
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
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTeamPermission: vi.fn(),
  mockInvitationFindMany: vi.fn(),
  mockInvitationFindFirst: vi.fn(),
  mockInvitationCreate: vi.fn(),
  mockPrismaTeam: { findUnique: vi.fn() },
  mockUserFindUnique: vi.fn(),
  mockTeamMemberFindUnique: vi.fn(),
  mockWithTeamTenantRls: vi.fn(async (_teamId: string, fn: () => unknown) => fn()),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/team-auth", () => {
  class TeamAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return { requireTeamPermission: mockRequireTeamPermission, TeamAuthError };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamInvitation: {
      findMany: mockInvitationFindMany,
      findFirst: mockInvitationFindFirst,
      create: mockInvitationCreate,
    },
    team: mockPrismaTeam,
    user: { findUnique: mockUserFindUnique },
    teamMember: { findUnique: mockTeamMemberFindUnique },
  },
}));
vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "Test" }),
}));
vi.mock("node:crypto", () => ({
  randomBytes: () => Buffer.from("a".repeat(32)),
}));
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: mockWithTeamTenantRls,
}));

import { GET, POST } from "@/app/api/teams/[teamId]/invitations/route";
import { TeamAuthError } from "@/lib/team-auth";

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
    mockInvitationFindMany.mockResolvedValue([
      {
        id: "inv-1",
        email: "new@test.com",
        role: "MEMBER",
        token: "tok",
        status: "PENDING",
        expiresAt: new Date(),
        invitedBy: { id: "u1", name: "Admin", email: "admin@test.com" },
        createdAt: new Date(),
      },
    ]);
    const req = createRequest("GET");
    const res = await GET(req, createParams({ teamId: "o1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json).toHaveLength(1);
    expect(json[0].email).toBe("new@test.com");
  });
});

describe("POST /api/teams/[teamId]/invitations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrismaTeam.findUnique.mockResolvedValue({ tenantId: "tenant-1" });
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
    mockUserFindUnique.mockResolvedValue({ id: "u2", email: "existing@test.com" });
    mockTeamMemberFindUnique.mockResolvedValue({ id: "m1", deactivatedAt: null });
    const req = createRequest("POST", undefined, { body: { email: "existing@test.com", role: "MEMBER" } });
    const res = await POST(req, createParams({ teamId: "o1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(409);
    expect(json.error).toBe("ALREADY_A_MEMBER");
  });

  it("returns 409 when pending invitation exists", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockUserFindUnique.mockResolvedValue(null);
    mockInvitationFindFirst.mockResolvedValue({ id: "inv-existing" });
    const req = createRequest("POST", undefined, { body: { email: "new@test.com", role: "MEMBER" } });
    const res = await POST(req, createParams({ teamId: "o1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(409);
    expect(json.error).toBe("INVITATION_ALREADY_SENT");
  });

  it("creates invitation successfully", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockUserFindUnique.mockResolvedValue(null);
    mockInvitationFindFirst.mockResolvedValue(null);
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
    mockUserFindUnique.mockResolvedValue({ id: "u2", email: "nonmember@test.com" });
    mockTeamMemberFindUnique.mockResolvedValue(null);
    mockInvitationFindFirst.mockResolvedValue(null);
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
});
