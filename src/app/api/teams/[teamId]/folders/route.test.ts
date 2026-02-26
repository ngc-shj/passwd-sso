import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaTeamFolder, mockRequireTeamMember, mockRequireTeamPermission, TeamAuthError, mockLogAudit } =
  vi.hoisted(() => {
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
      mockPrismaTeamFolder: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        create: vi.fn(),
      },
      mockRequireTeamMember: vi.fn(),
      mockRequireTeamPermission: vi.fn(),
      TeamAuthError: _TeamAuthError,
      mockLogAudit: vi.fn(),
    };
  });

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { orgFolder: mockPrismaTeamFolder },
}));
vi.mock("@/lib/team-auth", () => ({
  requireTeamMember: mockRequireTeamMember,
  requireTeamPermission: mockRequireTeamPermission,
  TeamAuthError,
}));
vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
  extractRequestMeta: vi.fn(() => ({ ip: "127.0.0.1", userAgent: "test" })),
}));
vi.mock("@/lib/folder-utils", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/folder-utils")>();
  return {
    ...original,
    validateParentFolder: vi.fn().mockResolvedValue({ parentId: null, ownerId: "team-1" }),
    validateFolderDepth: vi.fn().mockResolvedValue(1),
  };
});

import { GET, POST } from "./route";
import { validateParentFolder, validateFolderDepth } from "@/lib/folder-utils";
import { TEAM_ROLE } from "@/lib/constants";

const TEAM_ID = "team-1";
const BASE = `http://localhost:3000/api/teams/${TEAM_ID}/folders`;
const now = new Date("2025-06-01T00:00:00Z");

describe("GET /api/teams/[teamId]/folders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireTeamMember.mockResolvedValue({ role: TEAM_ROLE.MEMBER });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", BASE),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when not a member", async () => {
    mockRequireTeamMember.mockRejectedValue(new TeamAuthError("NOT_TEAM_MEMBER", 403));
    const res = await GET(
      createRequest("GET", BASE),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("returns team folders with entry count", async () => {
    mockPrismaTeamFolder.findMany.mockResolvedValue([
      {
        id: "f1",
        name: "Engineering",
        parentId: null,
        sortOrder: 0,
        _count: { entries: 3 },
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const res = await GET(
      createRequest("GET", BASE),
      createParams({ teamId: TEAM_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual([
      {
        id: "f1",
        name: "Engineering",
        parentId: null,
        sortOrder: 0,
        entryCount: 3,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    ]);
  });
});

describe("POST /api/teams/[teamId]/folders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireTeamPermission.mockResolvedValue({ role: TEAM_ROLE.ADMIN });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", BASE, { body: { name: "Test" } }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when permission denied", async () => {
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("INSUFFICIENT_PERMISSION", 403));
    const res = await POST(
      createRequest("POST", BASE, { body: { name: "Test" } }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 on invalid body", async () => {
    const res = await POST(
      createRequest("POST", BASE, { body: { name: "" } }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when parentId belongs to another team or does not exist", async () => {
    vi.mocked(validateParentFolder).mockRejectedValueOnce(
      new Error("PARENT_NOT_FOUND"),
    );

    const res = await POST(
      createRequest("POST", BASE, {
        body: { name: "Child", parentId: "cm000000000000000other01" },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("NOT_FOUND");
  });

  it("returns 400 when max depth exceeded", async () => {
    vi.mocked(validateFolderDepth).mockRejectedValueOnce(
      new Error("FOLDER_MAX_DEPTH_EXCEEDED"),
    );

    const res = await POST(
      createRequest("POST", BASE, {
        body: { name: "Deep", parentId: "cm000000000000000deep001" },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("FOLDER_MAX_DEPTH_EXCEEDED");
  });

  it("returns 409 when root folder name already exists", async () => {
    mockPrismaTeamFolder.findFirst.mockResolvedValue({ id: "existing" });

    const res = await POST(
      createRequest("POST", BASE, { body: { name: "Engineering" } }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("FOLDER_ALREADY_EXISTS");
  });

  it("returns 409 when child folder name already exists", async () => {
    mockPrismaTeamFolder.findUnique.mockResolvedValue({ id: "existing" });

    const res = await POST(
      createRequest("POST", BASE, {
        body: { name: "SubFolder", parentId: "cm000000000000000parent1" },
      }),
      createParams({ teamId: TEAM_ID }),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("FOLDER_ALREADY_EXISTS");
  });

  it("creates team folder successfully (201)", async () => {
    mockPrismaTeamFolder.findFirst.mockResolvedValue(null);
    mockPrismaTeamFolder.create.mockResolvedValue({
      id: "new-folder-id",
      name: "Finance",
      parentId: null,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });

    const res = await POST(
      createRequest("POST", BASE, { body: { name: "Finance" } }),
      createParams({ teamId: TEAM_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json.name).toBe("Finance");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "FOLDER_CREATE",
        orgId: TEAM_ID,
      }),
    );
  });
});
