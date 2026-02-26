import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const {
  mockAuth,
  mockPrismaOrgFolder,
  mockPrismaOrgPasswordEntry,
  mockPrismaTransaction,
  mockRequireTeamPermission,
  TeamAuthError,
  mockLogAudit,
} = vi.hoisted(() => {
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
    mockPrismaOrgFolder: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    mockPrismaOrgPasswordEntry: {
      updateMany: vi.fn(),
    },
    mockPrismaTransaction: vi.fn(),
    mockRequireTeamPermission: vi.fn(),
    TeamAuthError: _TeamAuthError,
    mockLogAudit: vi.fn(),
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    orgFolder: mockPrismaOrgFolder,
    orgPasswordEntry: mockPrismaOrgPasswordEntry,
    $transaction: mockPrismaTransaction,
  },
}));
vi.mock("@/lib/team-auth", () => ({
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
    checkCircularReference: vi.fn().mockResolvedValue(false),
  };
});

import { PUT, DELETE } from "./route";
import { validateParentFolder, validateFolderDepth, checkCircularReference } from "@/lib/folder-utils";
import { TEAM_ROLE } from "@/lib/constants";

const TEAM_ID = "team-1";
const FOLDER_ID = "cm000000000000000folder1";
const BASE = `http://localhost:3000/api/teams/${TEAM_ID}/folders/${FOLDER_ID}`;
const now = new Date("2025-06-01T00:00:00Z");
const ownedFolder = {
  id: FOLDER_ID,
  name: "Engineering",
  parentId: null,
  orgId: TEAM_ID,
  sortOrder: 0,
  createdAt: now,
  updatedAt: now,
};

describe("PUT /api/teams/[teamId]/folders/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireTeamPermission.mockResolvedValue({ role: TEAM_ROLE.ADMIN });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await PUT(
      createRequest("PUT", BASE, { body: { name: "Updated" } }),
      createParams({ teamId: TEAM_ID, id: FOLDER_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when permission denied", async () => {
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("INSUFFICIENT_PERMISSION", 403));
    const res = await PUT(
      createRequest("PUT", BASE, { body: { name: "Updated" } }),
      createParams({ teamId: TEAM_ID, id: FOLDER_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 404 when folder not found", async () => {
    mockPrismaOrgFolder.findUnique.mockResolvedValue(null);
    const res = await PUT(
      createRequest("PUT", BASE, { body: { name: "Updated" } }),
      createParams({ teamId: TEAM_ID, id: FOLDER_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when folder belongs to another org", async () => {
    mockPrismaOrgFolder.findUnique.mockResolvedValue({
      ...ownedFolder,
      orgId: "other-team",
    });
    const res = await PUT(
      createRequest("PUT", BASE, { body: { name: "Updated" } }),
      createParams({ teamId: TEAM_ID, id: FOLDER_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("updates folder name successfully", async () => {
    mockPrismaOrgFolder.findUnique.mockResolvedValue(ownedFolder);
    mockPrismaOrgFolder.findFirst.mockResolvedValue(null);
    mockPrismaOrgFolder.update.mockResolvedValue({
      ...ownedFolder,
      name: "Updated",
    });

    const res = await PUT(
      createRequest("PUT", BASE, { body: { name: "Updated" } }),
      createParams({ teamId: TEAM_ID, id: FOLDER_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.name).toBe("Updated");
  });

  it("returns 404 when parentId belongs to another org or does not exist", async () => {
    mockPrismaOrgFolder.findUnique.mockResolvedValue(ownedFolder);
    vi.mocked(validateParentFolder).mockRejectedValueOnce(
      new Error("PARENT_NOT_FOUND"),
    );

    const res = await PUT(
      createRequest("PUT", BASE, {
        body: { parentId: "cm000000000000000other01" },
      }),
      createParams({ teamId: TEAM_ID, id: FOLDER_ID }),
    );
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("NOT_FOUND");
  });

  it("returns 400 when parentId creates circular reference", async () => {
    mockPrismaOrgFolder.findUnique.mockResolvedValue(ownedFolder);
    vi.mocked(checkCircularReference).mockResolvedValueOnce(true);

    const res = await PUT(
      createRequest("PUT", BASE, {
        body: { parentId: "cm000000000000000child00" },
      }),
      createParams({ teamId: TEAM_ID, id: FOLDER_ID }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("FOLDER_CIRCULAR_REFERENCE");
  });

  it("returns 400 when setting parentId to self", async () => {
    mockPrismaOrgFolder.findUnique.mockResolvedValue(ownedFolder);

    const res = await PUT(
      createRequest("PUT", BASE, { body: { parentId: FOLDER_ID } }),
      createParams({ teamId: TEAM_ID, id: FOLDER_ID }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("FOLDER_CIRCULAR_REFERENCE");
  });

  it("returns 400 when parentId exceeds max depth", async () => {
    mockPrismaOrgFolder.findUnique.mockResolvedValue(ownedFolder);
    vi.mocked(validateFolderDepth).mockRejectedValueOnce(
      new Error("FOLDER_MAX_DEPTH_EXCEEDED"),
    );

    const res = await PUT(
      createRequest("PUT", BASE, {
        body: { parentId: "cm000000000000000deep001" },
      }),
      createParams({ teamId: TEAM_ID, id: FOLDER_ID }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("FOLDER_MAX_DEPTH_EXCEEDED");
  });

  it("returns 409 when renamed folder duplicates sibling name", async () => {
    mockPrismaOrgFolder.findUnique.mockResolvedValue(ownedFolder);
    mockPrismaOrgFolder.findFirst.mockResolvedValue({ id: "other-folder" });

    const res = await PUT(
      createRequest("PUT", BASE, { body: { name: "Duplicate" } }),
      createParams({ teamId: TEAM_ID, id: FOLDER_ID }),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("FOLDER_ALREADY_EXISTS");
  });
});

describe("DELETE /api/teams/[teamId]/folders/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireTeamPermission.mockResolvedValue({ role: TEAM_ROLE.ADMIN });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await DELETE(
      createRequest("DELETE", BASE),
      createParams({ teamId: TEAM_ID, id: FOLDER_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when permission denied", async () => {
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("INSUFFICIENT_PERMISSION", 403));
    const res = await DELETE(
      createRequest("DELETE", BASE),
      createParams({ teamId: TEAM_ID, id: FOLDER_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 404 when folder not found", async () => {
    mockPrismaOrgFolder.findUnique.mockResolvedValue(null);
    const res = await DELETE(
      createRequest("DELETE", BASE),
      createParams({ teamId: TEAM_ID, id: FOLDER_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("deletes folder and promotes children", async () => {
    mockPrismaOrgFolder.findUnique.mockResolvedValue(ownedFolder);
    mockPrismaOrgFolder.findMany
      .mockResolvedValueOnce([]) // no children
      .mockResolvedValueOnce([]); // no siblings at target
    mockPrismaTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      await fn({
        orgFolder: mockPrismaOrgFolder,
        orgPasswordEntry: mockPrismaOrgPasswordEntry,
      });
    });

    const res = await DELETE(
      createRequest("DELETE", BASE),
      createParams({ teamId: TEAM_ID, id: FOLDER_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockPrismaTransaction).toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "FOLDER_DELETE",
        orgId: TEAM_ID,
      }),
    );
  });

  it("renames children that would conflict at the target parent level", async () => {
    const parentFolder = { ...ownedFolder, name: "テスト" };
    mockPrismaOrgFolder.findUnique.mockResolvedValue(parentFolder);

    const childId = "cm000000000000000child01";
    mockPrismaOrgFolder.findMany
      .mockResolvedValueOnce([{ id: childId, name: "テスト" }])
      .mockResolvedValueOnce([{ id: FOLDER_ID, name: "テスト" }]);

    const txUpdates: Array<{ where: unknown; data: unknown }> = [];
    mockPrismaTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      await fn({
        orgFolder: {
          update: vi.fn(({ where, data }: { where: unknown; data: unknown }) => {
            txUpdates.push({ where, data });
            return Promise.resolve({});
          }),
          delete: vi.fn().mockResolvedValue({}),
        },
        orgPasswordEntry: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      });
    });

    const res = await DELETE(
      createRequest("DELETE", BASE),
      createParams({ teamId: TEAM_ID, id: FOLDER_ID }),
    );
    expect(res.status).toBe(200);

    const childUpdate = txUpdates.find(
      (u) => (u.where as { id: string }).id === childId,
    );
    expect(childUpdate).toBeDefined();
    expect((childUpdate!.data as { name: string }).name).toBe("テスト (2)");
    expect((childUpdate!.data as { parentId: string | null }).parentId).toBeNull();
  });
});
