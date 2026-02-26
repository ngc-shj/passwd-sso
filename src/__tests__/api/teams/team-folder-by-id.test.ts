import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import { createRequest, createParams, parseResponse } from "../../helpers/request-builder";

const {
  mockAuth,
  mockRequireTeamPermission,
  mockTeamFolderFindUnique,
  mockTeamFolderUpdate,
  mockTeamFolderFindMany,
  mockTeamFolderFindFirst,
  mockTransaction,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTeamPermission: vi.fn(),
  mockTeamFolderFindUnique: vi.fn(),
  mockTeamFolderUpdate: vi.fn(),
  mockTeamFolderFindMany: vi.fn(),
  mockTeamFolderFindFirst: vi.fn(),
  mockTransaction: vi.fn(),
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
    teamFolder: {
      findUnique: mockTeamFolderFindUnique,
      findFirst: mockTeamFolderFindFirst,
      findMany: mockTeamFolderFindMany,
      update: mockTeamFolderUpdate,
    },
    $transaction: mockTransaction,
  },
}));
vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "Test" }),
}));
vi.mock("@/lib/folder-utils", () => ({
  validateParentFolder: vi.fn(),
  validateFolderDepth: vi.fn(),
  checkCircularReference: vi.fn().mockResolvedValue(false),
}));

import { PUT, DELETE } from "@/app/api/teams/[teamId]/folders/[id]/route";
import { TeamAuthError } from "@/lib/team-auth";

describe("PUT /api/teams/[teamId]/folders/[id]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const req = createRequest("PUT", "http://localhost/api/teams/o1/folders/f1", { body: { name: "x" } });
    const res = await PUT(req, createParams({ teamId: "o1", id: "f1" }));
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 403 when lacking permission", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("FORBIDDEN", 403));
    const req = createRequest("PUT", "http://localhost/api/teams/o1/folders/f1", { body: { name: "x" } });
    const res = await PUT(req, createParams({ teamId: "o1", id: "f1" }));
    const { status } = await parseResponse(res);
    expect(status).toBe(403);
  });

  it("returns 404 when folder not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockTeamFolderFindUnique.mockResolvedValue(null);
    const req = createRequest("PUT", "http://localhost/api/teams/o1/folders/f1", { body: { name: "x" } });
    const res = await PUT(req, createParams({ teamId: "o1", id: "f1" }));
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it("returns 404 when folder belongs to different team", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockTeamFolderFindUnique.mockResolvedValue({ id: "f1", teamId: "other-team", parentId: null, name: "Old" });
    const req = createRequest("PUT", "http://localhost/api/teams/o1/folders/f1", { body: { name: "x" } });
    const res = await PUT(req, createParams({ teamId: "o1", id: "f1" }));
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it("renames folder successfully", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    const existing = { id: "f1", teamId: "o1", parentId: null, name: "Old" };
    mockTeamFolderFindUnique.mockResolvedValueOnce(existing);
    mockTeamFolderFindFirst.mockResolvedValue(null);
    const updated = { ...existing, name: "New", sortOrder: 0, createdAt: new Date(), updatedAt: new Date() };
    mockTeamFolderUpdate.mockResolvedValue(updated);

    const req = createRequest("PUT", "http://localhost/api/teams/o1/folders/f1", { body: { name: "New" } });
    const res = await PUT(req, createParams({ teamId: "o1", id: "f1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json.name).toBe("New");
  });

  it("returns 409 for duplicate name at root level", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    const existing = { id: "f1", teamId: "o1", parentId: null, name: "Old" };
    mockTeamFolderFindUnique.mockResolvedValueOnce(existing);
    mockTeamFolderFindFirst.mockResolvedValue({ id: "f2", name: "Dup" }); // dup

    const req = createRequest("PUT", "http://localhost/api/teams/o1/folders/f1", { body: { name: "Dup" } });
    const res = await PUT(req, createParams({ teamId: "o1", id: "f1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(409);
    expect(json.error).toBe("FOLDER_ALREADY_EXISTS");
  });

  it("returns 400 for Zod validation failure", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockTeamFolderFindUnique.mockResolvedValue({ id: "f1", teamId: "o1", parentId: null, name: "Old" });
    const req = createRequest("PUT", "http://localhost/api/teams/o1/folders/f1", { body: { name: 123 } });
    const res = await PUT(req, createParams({ teamId: "o1", id: "f1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("moves folder to a new parent", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    const parentCuid = "cm1234567890abcdefghijklmn";
    const existing = { id: "f1", teamId: "o1", parentId: null, name: "Folder" };
    mockTeamFolderFindUnique
      .mockResolvedValueOnce(existing) // find existing
      .mockResolvedValueOnce(null); // dup check under new parent
    const updated = { ...existing, parentId: parentCuid, sortOrder: 0, createdAt: new Date(), updatedAt: new Date() };
    mockTeamFolderUpdate.mockResolvedValue(updated);

    const req = createRequest("PUT", "http://localhost/api/teams/o1/folders/f1", { body: { parentId: parentCuid } });
    const res = await PUT(req, createParams({ teamId: "o1", id: "f1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json.parentId).toBe(parentCuid);
  });

  it("returns 409 for dup name under parent", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    const parentCuid = "cm1234567890abcdefghijklmn";
    const existing = { id: "f1", teamId: "o1", parentId: parentCuid, name: "Old" };
    mockTeamFolderFindUnique
      .mockResolvedValueOnce(existing) // find existing
      .mockResolvedValueOnce({ id: "f2", name: "Dup" }); // dup under parent

    const req = createRequest("PUT", "http://localhost/api/teams/o1/folders/f1", { body: { name: "Dup" } });
    const res = await PUT(req, createParams({ teamId: "o1", id: "f1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(409);
    expect(json.error).toBe("FOLDER_ALREADY_EXISTS");
  });

  it("re-throws non-TeamAuthError from PUT", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockRejectedValue(new Error("Unexpected"));
    const req = createRequest("PUT", "http://localhost/api/teams/o1/folders/f1", { body: { name: "x" } });
    await expect(PUT(req, createParams({ teamId: "o1", id: "f1" }))).rejects.toThrow("Unexpected");
  });

  it("returns 400 for invalid JSON body", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockTeamFolderFindUnique.mockResolvedValue({ id: "f1", teamId: "o1", parentId: null, name: "F" });
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/teams/o1/folders/f1", {
      method: "PUT",
      body: "not json",
      headers: { "Content-Type": "text/plain" },
    });
    const res = await PUT(req, createParams({ teamId: "o1", id: "f1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("INVALID_JSON");
  });
});

describe("DELETE /api/teams/[teamId]/folders/[id]", () => {
  let txTeamFolderUpdate: ReturnType<typeof vi.fn>;
  let txTeamFolderDelete: ReturnType<typeof vi.fn>;
  let txOrgEntryUpdateMany: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    txTeamFolderUpdate = vi.fn();
    txTeamFolderDelete = vi.fn();
    txOrgEntryUpdateMany = vi.fn();
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      await fn({
        teamFolder: { update: txTeamFolderUpdate, delete: txTeamFolderDelete },
        teamPasswordEntry: { updateMany: txOrgEntryUpdateMany },
      });
    });
  });

  it("re-throws non-TeamAuthError from DELETE", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockRejectedValue(new Error("Unexpected"));
    const req = createRequest("DELETE");
    await expect(DELETE(req, createParams({ teamId: "o1", id: "f1" }))).rejects.toThrow("Unexpected");
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const req = createRequest("DELETE");
    const res = await DELETE(req, createParams({ teamId: "o1", id: "f1" }));
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 403 when lacking permission", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockRejectedValue(new TeamAuthError("FORBIDDEN", 403));
    const req = createRequest("DELETE");
    const res = await DELETE(req, createParams({ teamId: "o1", id: "f1" }));
    const { status } = await parseResponse(res);
    expect(status).toBe(403);
  });

  it("returns 404 when folder not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockTeamFolderFindUnique.mockResolvedValue(null);
    const req = createRequest("DELETE");
    const res = await DELETE(req, createParams({ teamId: "o1", id: "f1" }));
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it("promotes child without rename when no conflict", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockTeamFolderFindUnique.mockResolvedValue({ id: "f1", teamId: "o1", parentId: null, name: "Parent" });
    mockTeamFolderFindMany
      .mockResolvedValueOnce([{ id: "c1", name: "Unique" }])
      .mockResolvedValueOnce([{ id: "s1", name: "Sibling" }]);

    const req = createRequest("DELETE");
    const res = await DELETE(req, createParams({ teamId: "o1", id: "f1" }));
    const { status } = await parseResponse(res);
    expect(status).toBe(200);
    expect(txTeamFolderUpdate.mock.calls[0][0].data.name).toBeUndefined();
  });

  it("increments suffix when (2) is taken", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockTeamFolderFindUnique.mockResolvedValue({ id: "f1", teamId: "o1", parentId: null, name: "Parent" });
    mockTeamFolderFindMany
      .mockResolvedValueOnce([{ id: "c1", name: "Parent" }])
      .mockResolvedValueOnce([{ id: "s1", name: "Parent (2)" }]);

    const req = createRequest("DELETE");
    const res = await DELETE(req, createParams({ teamId: "o1", id: "f1" }));
    const { status } = await parseResponse(res);
    expect(status).toBe(200);
    expect(txTeamFolderUpdate.mock.calls[0][0].data.name).toBe("Parent (3)");
  });

  it("deletes folder, promotes children, renames on conflict", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockTeamFolderFindUnique.mockResolvedValue({ id: "f1", teamId: "o1", parentId: null, name: "Parent" });
    mockTeamFolderFindMany
      .mockResolvedValueOnce([{ id: "c1", name: "Parent" }])
      .mockResolvedValueOnce([]);

    const req = createRequest("DELETE");
    const res = await DELETE(req, createParams({ teamId: "o1", id: "f1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(txTeamFolderUpdate.mock.calls[0][0].data.name).toBe("Parent (2)");
  });
});
