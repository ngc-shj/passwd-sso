import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaTeamInvitation, mockRequireTeamPermission, TeamAuthError, mockWithTeamTenantRls } = vi.hoisted(() => {
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
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
    mockRequireTeamPermission: vi.fn(),
    TeamAuthError: _TeamAuthError,
    mockWithTeamTenantRls: vi.fn(async (_teamId: string, fn: () => unknown) => fn()),
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { teamInvitation: mockPrismaTeamInvitation },
}));
vi.mock("@/lib/team-auth", () => ({
  requireTeamPermission: mockRequireTeamPermission,
  TeamAuthError,
}));
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: mockWithTeamTenantRls,
}));

import { DELETE } from "./route";
import { TEAM_ROLE } from "@/lib/constants";

const TEAM_ID = "team-123";
const INV_ID = "inv-456";

describe("DELETE /api/teams/[teamId]/invitations/[invId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireTeamPermission.mockResolvedValue({ role: TEAM_ROLE.ADMIN });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/invitations/${INV_ID}`),
      createParams({ teamId: TEAM_ID, invId: INV_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns TeamAuthError status when permission denied", async () => {
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("INSUFFICIENT_PERMISSION", 403));
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/invitations/${INV_ID}`),
      createParams({ teamId: TEAM_ID, invId: INV_ID }),
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("INSUFFICIENT_PERMISSION");
  });

  it("rethrows non-TeamAuthError", async () => {
    mockRequireTeamPermission.mockRejectedValue(new Error("unexpected"));
    await expect(
      DELETE(
        createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/invitations/${INV_ID}`),
        createParams({ teamId: TEAM_ID, invId: INV_ID }),
      ),
    ).rejects.toThrow("unexpected");
  });

  it("returns 404 when invitation not found", async () => {
    mockPrismaTeamInvitation.findUnique.mockResolvedValue(null);
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/invitations/${INV_ID}`),
      createParams({ teamId: TEAM_ID, invId: INV_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when invitation belongs to different team", async () => {
    mockPrismaTeamInvitation.findUnique.mockResolvedValue({ id: INV_ID, teamId: "other-team" });
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/invitations/${INV_ID}`),
      createParams({ teamId: TEAM_ID, invId: INV_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("deletes invitation successfully", async () => {
    mockPrismaTeamInvitation.findUnique.mockResolvedValue({ id: INV_ID, teamId: TEAM_ID });
    mockPrismaTeamInvitation.delete.mockResolvedValue({});

    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${TEAM_ID}/invitations/${INV_ID}`),
      createParams({ teamId: TEAM_ID, invId: INV_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
  });
});
