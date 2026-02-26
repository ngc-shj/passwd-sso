import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaTeamInvitation, mockPrismaUser, mockPrismaTeamMember, mockRequireTeamPermission, TeamAuthError } = vi.hoisted(() => {
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
    mockPrismaTeamInvitation: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    mockPrismaUser: { findUnique: vi.fn() },
    mockPrismaTeamMember: { findUnique: vi.fn() },
    mockRequireTeamPermission: vi.fn(),
    TeamAuthError: _TeamAuthError,
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamInvitation: mockPrismaTeamInvitation,
    user: mockPrismaUser,
    teamMember: mockPrismaTeamMember,
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));
vi.mock("@/lib/team-auth", () => ({
  requireTeamPermission: mockRequireTeamPermission,
  TeamAuthError,
}));

import { GET, POST } from "./route";
import { TEAM_ROLE, INVITATION_STATUS } from "@/lib/constants";

const TEAM_ID = "team-123";
const now = new Date("2025-01-01T00:00:00Z");

describe("GET /api/teams/[teamId]/invitations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireTeamPermission.mockResolvedValue({ role: TEAM_ROLE.ADMIN });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/invitations`),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when lacking invite permission", async () => {
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("FORBIDDEN", 403));
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/invitations`),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("returns list of pending invitations", async () => {
    mockPrismaTeamInvitation.findMany.mockResolvedValue([
      {
        id: "inv-1",
        email: "user@test.com",
        role: TEAM_ROLE.MEMBER,
        token: "abc123",
        status: INVITATION_STATUS.PENDING,
        expiresAt: now,
        createdAt: now,
        invitedBy: { id: "u1", name: "Admin", email: "admin@test.com" },
      },
    ]);

    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/invitations`),
      createParams({ teamId: TEAM_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toHaveLength(1);
    expect(json[0].email).toBe("user@test.com");
  });
});

describe("POST /api/teams/[teamId]/invitations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireTeamPermission.mockResolvedValue({ role: TEAM_ROLE.ADMIN });
    mockPrismaUser.findUnique.mockResolvedValue(null);
    mockPrismaTeamInvitation.findFirst.mockResolvedValue(null);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/invitations`, {
        body: { email: "new@test.com", role: TEAM_ROLE.MEMBER },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 on invalid body", async () => {
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/invitations`, {
        body: { email: "invalid" },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 409 when user is already a member", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({ id: "existing-user" });
    mockPrismaTeamMember.findUnique.mockResolvedValue({ id: "existing-member", deactivatedAt: null });

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/invitations`, {
        body: { email: "existing@test.com", role: TEAM_ROLE.MEMBER },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("ALREADY_A_MEMBER");
  });

  it("returns 409 when invitation already pending", async () => {
    mockPrismaTeamInvitation.findFirst.mockResolvedValue({ id: "existing-inv" });

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/invitations`, {
        body: { email: "pending@test.com", role: TEAM_ROLE.MEMBER },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("INVITATION_ALREADY_SENT");
  });

  it("creates invitation successfully (201)", async () => {
    mockPrismaTeamInvitation.create.mockResolvedValue({
      id: "new-inv",
      email: "new@test.com",
      role: TEAM_ROLE.MEMBER,
      token: "generated-token",
      expiresAt: now,
      createdAt: now,
    });

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/invitations`, {
        body: { email: "new@test.com", role: TEAM_ROLE.MEMBER },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json.email).toBe("new@test.com");
    expect(json.token).toBeDefined();
  });
});