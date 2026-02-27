import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaTeamTag, mockPrismaTeam, mockRequireTeamMember, mockRequireTeamPermission, TeamAuthError, mockWithUserTenantRls } = vi.hoisted(() => {
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
    mockPrismaTeamTag: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    mockPrismaTeam: { findUnique: vi.fn() },
    mockRequireTeamMember: vi.fn(),
    mockRequireTeamPermission: vi.fn(),
    TeamAuthError: _TeamAuthError,
    mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { teamTag: mockPrismaTeamTag, team: mockPrismaTeam },
}));
vi.mock("@/lib/team-auth", () => ({
  requireTeamMember: mockRequireTeamMember,
  requireTeamPermission: mockRequireTeamPermission,
  TeamAuthError,
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));

import { GET, POST } from "./route";
import { TEAM_ROLE } from "@/lib/constants";

const TEAM_ID = "team-123";

describe("GET /api/teams/[teamId]/tags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireTeamMember.mockResolvedValue({ role: TEAM_ROLE.MEMBER });
    mockPrismaTeam.findUnique.mockResolvedValue({ tenantId: "tenant-1" });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/tags`),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns team tags with counts", async () => {
    mockPrismaTeamTag.findMany.mockResolvedValue([
      { id: "t1", name: "Work", color: "#ff0000", _count: { passwords: 5 } },
    ]);

    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/tags`),
      createParams({ teamId: TEAM_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json[0].count).toBe(5);
  });

  it("returns TeamAuthError status when not a member", async () => {
    mockRequireTeamMember.mockRejectedValue(new TeamAuthError("NOT_TEAM_MEMBER", 403));
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/tags`),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("NOT_TEAM_MEMBER");
  });

  it("rethrows non-TeamAuthError", async () => {
    mockRequireTeamMember.mockRejectedValue(new Error("unexpected"));
    await expect(
      GET(
        createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/tags`),
        createParams({ teamId: TEAM_ID }),
      ),
    ).rejects.toThrow("unexpected");
  });

  it("excludes archived and deleted entries from count", async () => {
    mockPrismaTeamTag.findMany.mockResolvedValue([
      { id: "t1", name: "Work", color: null, _count: { passwords: 3 } },
    ]);

    await GET(
      createRequest("GET", `http://localhost:3000/api/teams/${TEAM_ID}/tags`),
      createParams({ teamId: TEAM_ID }),
    );

    expect(mockPrismaTeamTag.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: {
          _count: {
            select: {
              passwords: {
                where: { deletedAt: null, isArchived: false },
              },
            },
          },
        },
      }),
    );
  });
});

describe("POST /api/teams/[teamId]/tags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireTeamPermission.mockResolvedValue({ role: TEAM_ROLE.MEMBER });
    mockPrismaTeam.findUnique.mockResolvedValue({ tenantId: "tenant-1" });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/tags`, { body: { name: "T" } }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns TeamAuthError status when permission denied", async () => {
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("INSUFFICIENT_PERMISSION", 403));
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/tags`, { body: { name: "T" } }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("INSUFFICIENT_PERMISSION");
  });

  it("rethrows non-TeamAuthError from requireTeamPermission", async () => {
    mockRequireTeamPermission.mockRejectedValue(new Error("unexpected"));
    await expect(
      POST(
        createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/tags`, { body: { name: "T" } }),
        createParams({ teamId: TEAM_ID }),
      ),
    ).rejects.toThrow("unexpected");
  });

  it("returns 400 on malformed JSON", async () => {
    const { NextRequest } = await import("next/server");
    const req = new NextRequest(`http://localhost:3000/api/teams/${TEAM_ID}/tags`, {
      method: "POST",
      body: "not-json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req, createParams({ teamId: TEAM_ID }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("INVALID_JSON");
  });

  it("returns 400 on validation error", async () => {
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/tags`, { body: {} }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 409 when tag already exists", async () => {
    mockPrismaTeamTag.findUnique.mockResolvedValue({ id: "existing" });
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/tags`, { body: { name: "Work" } }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(409);
  });

  it("creates team tag (201)", async () => {
    mockPrismaTeamTag.findUnique.mockResolvedValue(null);
    mockPrismaTeamTag.create.mockResolvedValue({ id: "new-tag", name: "Finance", color: null });

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${TEAM_ID}/tags`, { body: { name: "Finance" } }),
      createParams({ teamId: TEAM_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json.name).toBe("Finance");
    expect(json.count).toBe(0);
  });
});
