import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaOrgPasswordEntry, mockRequireTeamPermission, TeamAuthError } = vi.hoisted(() => {
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
    mockPrismaOrgPasswordEntry: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    mockRequireTeamPermission: vi.fn(),
    TeamAuthError: _TeamAuthError,
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { orgPasswordEntry: mockPrismaOrgPasswordEntry, auditLog: { create: vi.fn().mockResolvedValue({}) } },
}));
vi.mock("@/lib/team-auth", () => ({
  requireTeamPermission: mockRequireTeamPermission,
  TeamAuthError,
}));

import { POST } from "./route";
import { TEAM_ROLE } from "@/lib/constants";

const TEAM_ID = "team-123";
const PW_ID = "pw-456";

describe("POST /api/teams/[teamId]/passwords/[id]/restore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireTeamPermission.mockResolvedValue({ role: TEAM_ROLE.ADMIN });
  });

  it("returns TeamAuthError status when permission denied", async () => {
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("INSUFFICIENT_PERMISSION", 403));
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/${PW_ID}/restore`),
      createParams({ teamId: TEAM_ID, id: PW_ID }),
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("INSUFFICIENT_PERMISSION");
  });

  it("rethrows non-TeamAuthError", async () => {
    mockRequireTeamPermission.mockRejectedValue(new Error("unexpected"));
    await expect(
      POST(
        createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/${PW_ID}/restore`),
        createParams({ teamId: TEAM_ID, id: PW_ID }),
      ),
    ).rejects.toThrow("unexpected");
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/${PW_ID}/restore`),
      createParams({ teamId: TEAM_ID, id: PW_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when entry not found", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/${PW_ID}/restore`),
      createParams({ teamId: TEAM_ID, id: PW_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when entry is not in trash", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      id: PW_ID,
      orgId: TEAM_ID,
      deletedAt: null,
    });
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/${PW_ID}/restore`),
      createParams({ teamId: TEAM_ID, id: PW_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("restores entry from trash", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      id: PW_ID,
      orgId: TEAM_ID,
      deletedAt: new Date(),
    });
    mockPrismaOrgPasswordEntry.update.mockResolvedValue({});

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/${PW_ID}/restore`),
      createParams({ teamId: TEAM_ID, id: PW_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
  });
});