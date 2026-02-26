import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaOrgFolder, mockRequireOrgMember, mockRequireOrgPermission, TeamAuthError, mockLogAudit } =
  vi.hoisted(() => {
    class _OrgAuthError extends Error {
      status: number;
      constructor(message: string, status: number) {
        super(message);
        this.name = "TeamAuthError";
        this.status = status;
      }
    }
    return {
      mockAuth: vi.fn(),
      mockPrismaOrgFolder: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        create: vi.fn(),
      },
      mockRequireOrgMember: vi.fn(),
      mockRequireOrgPermission: vi.fn(),
      TeamAuthError: _OrgAuthError,
      mockLogAudit: vi.fn(),
    };
  });

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { orgFolder: mockPrismaOrgFolder },
}));
vi.mock("@/lib/team-auth", () => ({
  requireTeamMember: mockRequireOrgMember,
  requireTeamPermission: mockRequireOrgPermission,
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
    validateParentFolder: vi.fn().mockResolvedValue({ parentId: null, ownerId: "org-1" }),
    validateFolderDepth: vi.fn().mockResolvedValue(1),
  };
});

import { GET, POST } from "./route";
import { validateParentFolder, validateFolderDepth } from "@/lib/folder-utils";
import { TEAM_ROLE } from "@/lib/constants";

const ORG_ID = "org-1";
const BASE = `http://localhost:3000/api/teams/${ORG_ID}/folders`;
const now = new Date("2025-06-01T00:00:00Z");

describe("GET /api/teams/[teamId]/folders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireOrgMember.mockResolvedValue({ role: TEAM_ROLE.MEMBER });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", BASE),
      createParams({ teamId: ORG_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when not a member", async () => {
    mockRequireOrgMember.mockRejectedValue(new TeamAuthError("NOT_ORG_MEMBER", 403));
    const res = await GET(
      createRequest("GET", BASE),
      createParams({ teamId: ORG_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("returns org folders with entry count", async () => {
    mockPrismaOrgFolder.findMany.mockResolvedValue([
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
      createParams({ teamId: ORG_ID }),
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
    mockRequireOrgPermission.mockResolvedValue({ role: TEAM_ROLE.ADMIN });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", BASE, { body: { name: "Test" } }),
      createParams({ teamId: ORG_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when permission denied", async () => {
    mockRequireOrgPermission.mockRejectedValue(new TeamAuthError("INSUFFICIENT_PERMISSION", 403));
    const res = await POST(
      createRequest("POST", BASE, { body: { name: "Test" } }),
      createParams({ teamId: ORG_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 on invalid body", async () => {
    const res = await POST(
      createRequest("POST", BASE, { body: { name: "" } }),
      createParams({ teamId: ORG_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when parentId belongs to another org or does not exist", async () => {
    vi.mocked(validateParentFolder).mockRejectedValueOnce(
      new Error("PARENT_NOT_FOUND"),
    );

    const res = await POST(
      createRequest("POST", BASE, {
        body: { name: "Child", parentId: "cm000000000000000other01" },
      }),
      createParams({ teamId: ORG_ID }),
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
      createParams({ teamId: ORG_ID }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("FOLDER_MAX_DEPTH_EXCEEDED");
  });

  it("returns 409 when root folder name already exists", async () => {
    mockPrismaOrgFolder.findFirst.mockResolvedValue({ id: "existing" });

    const res = await POST(
      createRequest("POST", BASE, { body: { name: "Engineering" } }),
      createParams({ teamId: ORG_ID }),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("FOLDER_ALREADY_EXISTS");
  });

  it("returns 409 when child folder name already exists", async () => {
    mockPrismaOrgFolder.findUnique.mockResolvedValue({ id: "existing" });

    const res = await POST(
      createRequest("POST", BASE, {
        body: { name: "SubFolder", parentId: "cm000000000000000parent1" },
      }),
      createParams({ teamId: ORG_ID }),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("FOLDER_ALREADY_EXISTS");
  });

  it("creates org folder successfully (201)", async () => {
    mockPrismaOrgFolder.findFirst.mockResolvedValue(null);
    mockPrismaOrgFolder.create.mockResolvedValue({
      id: "new-folder-id",
      name: "Finance",
      parentId: null,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });

    const res = await POST(
      createRequest("POST", BASE, { body: { name: "Finance" } }),
      createParams({ teamId: ORG_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json.name).toBe("Finance");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "FOLDER_CREATE",
        orgId: ORG_ID,
      }),
    );
  });
});
