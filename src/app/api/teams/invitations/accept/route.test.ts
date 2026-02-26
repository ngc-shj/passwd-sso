import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaTeamInvitation, mockPrismaTeamMember, mockPrismaUser, mockTransaction, mockRateLimiter } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaTeamInvitation: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  mockPrismaTeamMember: {
    findUnique: vi.fn(),
    create: vi.fn(),
    upsert: vi.fn(),
  },
  mockPrismaUser: { findUnique: vi.fn() },
  mockTransaction: vi.fn(),
  mockRateLimiter: { check: vi.fn() },
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamInvitation: mockPrismaTeamInvitation,
    teamMember: mockPrismaTeamMember,
    user: mockPrismaUser,
    $transaction: mockTransaction,
  },
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => mockRateLimiter,
}));

import { POST } from "./route";
import { TEAM_ROLE, INVITATION_STATUS } from "@/lib/constants";

const futureDate = new Date("2099-01-01T00:00:00Z");

const validInvitation = {
  id: "inv-1",
  teamId: "team-1",
  email: "user@test.com",
  role: TEAM_ROLE.MEMBER,
  token: "valid-token",
  status: INVITATION_STATUS.PENDING,
  expiresAt: futureDate,
  team: { id: "team-1", name: "My Team", slug: "my-team" },
};

describe("POST /api/teams/invitations/accept", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id", email: "user@test.com" } });
    mockTransaction.mockResolvedValue([{}, {}]);
    mockRateLimiter.check.mockResolvedValue(true);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(createRequest("POST", "http://localhost:3000/api/teams/invitations/accept", {
      body: { token: "abc" },
    }));
    expect(res.status).toBe(401);
  });

  it("returns 400 when token missing", async () => {
    const res = await POST(createRequest("POST", "http://localhost:3000/api/teams/invitations/accept", {
      body: {},
    }));
    expect(res.status).toBe(400);
  });

  it("returns 404 when token is invalid", async () => {
    mockPrismaTeamInvitation.findUnique.mockResolvedValue(null);
    const res = await POST(createRequest("POST", "http://localhost:3000/api/teams/invitations/accept", {
      body: { token: "invalid" },
    }));
    expect(res.status).toBe(404);
  });

  it("returns 410 when invitation already used", async () => {
    mockPrismaTeamInvitation.findUnique.mockResolvedValue({
      ...validInvitation,
      status: INVITATION_STATUS.ACCEPTED,
    });
    const res = await POST(createRequest("POST", "http://localhost:3000/api/teams/invitations/accept", {
      body: { token: "valid-token" },
    }));
    expect(res.status).toBe(410);
  });

  it("returns 410 when invitation expired", async () => {
    mockPrismaTeamInvitation.findUnique.mockResolvedValue({
      ...validInvitation,
      expiresAt: new Date("2020-01-01"),
    });
    const res = await POST(createRequest("POST", "http://localhost:3000/api/teams/invitations/accept", {
      body: { token: "valid-token" },
    }));
    expect(res.status).toBe(410);
  });

  it("returns 403 when email doesn't match", async () => {
    mockAuth.mockResolvedValue({ user: { id: "test-user-id", email: "other@test.com" } });
    mockPrismaTeamInvitation.findUnique.mockResolvedValue(validInvitation);
    const res = await POST(createRequest("POST", "http://localhost:3000/api/teams/invitations/accept", {
      body: { token: "valid-token" },
    }));
    expect(res.status).toBe(403);
  });

  it("handles already-member case gracefully", async () => {
    mockPrismaTeamInvitation.findUnique.mockResolvedValue(validInvitation);
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: "existing-member",
      deactivatedAt: null,
    });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/teams/invitations/accept", {
      body: { token: "valid-token" },
    }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.alreadyMember).toBe(true);
  });

  it("returns 409 for deactivated scimManaged member", async () => {
    mockPrismaTeamInvitation.findUnique.mockResolvedValue(validInvitation);
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: "deactivated-member",
      deactivatedAt: new Date("2024-01-01"),
      scimManaged: true,
    });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/teams/invitations/accept", {
      body: { token: "valid-token" },
    }));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("SCIM_MANAGED_MEMBER");
  });

  it("re-activates deactivated non-scimManaged member", async () => {
    mockPrismaTeamInvitation.findUnique.mockResolvedValue(validInvitation);
    mockPrismaTeamMember.findUnique.mockResolvedValue({
      id: "deactivated-member",
      deactivatedAt: new Date("2024-01-01"),
      scimManaged: false,
    });
    mockPrismaUser.findUnique.mockResolvedValue({ ecdhPublicKey: "pub-key" });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/teams/invitations/accept", {
      body: { token: "valid-token" },
    }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.alreadyMember).toBe(false);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it("accepts invitation and creates membership", async () => {
    mockPrismaTeamInvitation.findUnique.mockResolvedValue(validInvitation);
    mockPrismaTeamMember.findUnique.mockResolvedValue(null);
    mockPrismaUser.findUnique.mockResolvedValue({ ecdhPublicKey: "pub-key-jwk" });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/teams/invitations/accept", {
      body: { token: "valid-token" },
    }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.alreadyMember).toBe(false);
    expect(json.role).toBe(TEAM_ROLE.MEMBER);
    expect(json.team.name).toBe("My Team");
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it("returns needsKeyDistribution for team accept", async () => {
    mockPrismaTeamInvitation.findUnique.mockResolvedValue(validInvitation);
    mockPrismaTeamMember.findUnique.mockResolvedValue(null);
    mockPrismaUser.findUnique.mockResolvedValue({ ecdhPublicKey: "pub-key-jwk" });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/teams/invitations/accept", {
      body: { token: "valid-token" },
    }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.needsKeyDistribution).toBe(true);
    expect(json.vaultSetupRequired).toBe(false);
  });

  it("returns vaultSetupRequired when user lacks ECDH key", async () => {
    mockPrismaTeamInvitation.findUnique.mockResolvedValue(validInvitation);
    mockPrismaTeamMember.findUnique.mockResolvedValue(null);
    mockPrismaUser.findUnique.mockResolvedValue({ ecdhPublicKey: null });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/teams/invitations/accept", {
      body: { token: "valid-token" },
    }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.needsKeyDistribution).toBe(true);
    expect(json.vaultSetupRequired).toBe(true);
  });
});
