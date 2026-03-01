import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaTeamPasswordEntry, mockPrismaTeamPasswordFavorite, mockRequireTeamPermission, TeamAuthError, mockWithTeamTenantRls } = vi.hoisted(() => {
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
    mockPrismaTeamPasswordEntry: { findUnique: vi.fn() },
    mockPrismaTeamPasswordFavorite: {
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    mockRequireTeamPermission: vi.fn(),
    TeamAuthError: _TeamAuthError,
    mockWithTeamTenantRls: vi.fn(async (_teamId: string, fn: () => unknown) => fn()),
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamPasswordEntry: mockPrismaTeamPasswordEntry,
    teamPasswordFavorite: mockPrismaTeamPasswordFavorite,
  },
}));
vi.mock("@/lib/team-auth", () => ({
  requireTeamPermission: mockRequireTeamPermission,
  TeamAuthError,
}));
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: mockWithTeamTenantRls,
}));

import { POST } from "./route";
import { TEAM_ROLE } from "@/lib/constants";

const TEAM_ID = "team-123";
const PW_ID = "pw-456";

describe("POST /api/teams/[teamId]/passwords/[id]/favorite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireTeamPermission.mockResolvedValue({ role: TEAM_ROLE.MEMBER });
  });

  it("returns TeamAuthError status when permission denied", async () => {
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("INSUFFICIENT_PERMISSION", 403));
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/${PW_ID}/favorite`),
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
        createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/${PW_ID}/favorite`),
        createParams({ teamId: TEAM_ID, id: PW_ID }),
      ),
    ).rejects.toThrow("unexpected");
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/${PW_ID}/favorite`),
      createParams({ teamId: TEAM_ID, id: PW_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when entry not found", async () => {
    mockPrismaTeamPasswordEntry.findUnique.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/${PW_ID}/favorite`),
      createParams({ teamId: TEAM_ID, id: PW_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("adds favorite when not yet favorited", async () => {
    mockPrismaTeamPasswordEntry.findUnique.mockResolvedValue({ teamId: TEAM_ID });
    mockPrismaTeamPasswordFavorite.findUnique.mockResolvedValue(null);
    mockPrismaTeamPasswordFavorite.create.mockResolvedValue({});

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/${PW_ID}/favorite`),
      createParams({ teamId: TEAM_ID, id: PW_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.isFavorite).toBe(true);
  });

  it("removes favorite when already favorited", async () => {
    mockPrismaTeamPasswordEntry.findUnique.mockResolvedValue({ teamId: TEAM_ID });
    mockPrismaTeamPasswordFavorite.findUnique.mockResolvedValue({ id: "fav-1" });
    mockPrismaTeamPasswordFavorite.delete.mockResolvedValue({});

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/passwords/${PW_ID}/favorite`),
      createParams({ teamId: TEAM_ID, id: PW_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.isFavorite).toBe(false);
  });
});
