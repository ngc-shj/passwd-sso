import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import { createRequest, createParams, parseResponse } from "../../helpers/request-builder";

const {
  mockAuth,
  mockFolderFindUnique,
  mockFolderUpdate,
  mockFolderFindMany,
  mockFolderFindFirst,
  mockTransaction,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockFolderFindUnique: vi.fn(),
  mockFolderUpdate: vi.fn(),
  mockFolderFindMany: vi.fn(),
  mockFolderFindFirst: vi.fn(),
  mockTransaction: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    folder: {
      findUnique: mockFolderFindUnique,
      findFirst: mockFolderFindFirst,
      findMany: mockFolderFindMany,
      update: mockFolderUpdate,
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

import { PUT, DELETE } from "@/app/api/folders/[id]/route";
import { checkCircularReference, validateFolderDepth } from "@/lib/folder-utils";

describe("PUT /api/folders/[id]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const req = createRequest("PUT", "http://localhost/api/folders/f1", { body: { name: "x" } });
    const res = await PUT(req, createParams({ id: "f1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 404 when folder not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFolderFindUnique.mockResolvedValue(null);
    const req = createRequest("PUT", "http://localhost/api/folders/f1", { body: { name: "x" } });
    const res = await PUT(req, createParams({ id: "f1" }));
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it("returns 403 when folder belongs to another user", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFolderFindUnique.mockResolvedValue({ id: "f1", userId: "other-user", parentId: null, name: "Old" });
    const req = createRequest("PUT", "http://localhost/api/folders/f1", { body: { name: "x" } });
    const res = await PUT(req, createParams({ id: "f1" }));
    const { status } = await parseResponse(res);
    expect(status).toBe(403);
  });

  it("returns 400 for invalid JSON body", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFolderFindUnique.mockResolvedValue({ id: "f1", userId: DEFAULT_SESSION.user.id, parentId: null, name: "Old" });
    // Create a request that will fail json() parsing
    const req = new (await import("next/server")).NextRequest("http://localhost/api/folders/f1", {
      method: "PUT",
      body: "not json",
      headers: { "Content-Type": "text/plain" },
    });
    const res = await PUT(req, createParams({ id: "f1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("INVALID_JSON");
  });

  it("renames folder successfully", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    const existing = { id: "f1", userId: DEFAULT_SESSION.user.id, parentId: null, name: "Old" };
    // First call: find existing folder; second call: dup check returns null
    mockFolderFindUnique.mockResolvedValueOnce(existing);
    mockFolderFindFirst.mockResolvedValue(null);
    const updated = { ...existing, name: "New", sortOrder: 0, createdAt: new Date(), updatedAt: new Date() };
    mockFolderUpdate.mockResolvedValue(updated);

    const req = createRequest("PUT", "http://localhost/api/folders/f1", { body: { name: "New" } });
    const res = await PUT(req, createParams({ id: "f1" }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.name).toBe("New");
  });

  it("returns 409 when duplicate folder name exists at root", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    const existing = { id: "f1", userId: DEFAULT_SESSION.user.id, parentId: null, name: "Old" };
    mockFolderFindUnique.mockResolvedValueOnce(existing);
    mockFolderFindFirst.mockResolvedValue({ id: "f2", name: "New" }); // different id = dup

    const req = createRequest("PUT", "http://localhost/api/folders/f1", { body: { name: "New" } });
    const res = await PUT(req, createParams({ id: "f1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(409);
    expect(json.error).toBe("FOLDER_ALREADY_EXISTS");
  });

  it("returns 409 when duplicate name exists under parent folder", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    const parentCuid = "cm1234567890abcdefghijklmn";
    const existing = { id: "f1", userId: DEFAULT_SESSION.user.id, parentId: parentCuid, name: "Old" };
    mockFolderFindUnique
      .mockResolvedValueOnce(existing) // find existing
      .mockResolvedValueOnce({ id: "f2", name: "Dup" }); // dup check returns different id

    const req = createRequest("PUT", "http://localhost/api/folders/f1", { body: { name: "Dup" } });
    const res = await PUT(req, createParams({ id: "f1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(409);
    expect(json.error).toBe("FOLDER_ALREADY_EXISTS");
  });

  it("returns 400 for Zod validation failure", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFolderFindUnique.mockResolvedValue({ id: "f1", userId: DEFAULT_SESSION.user.id, parentId: null, name: "Old" });
    const req = createRequest("PUT", "http://localhost/api/folders/f1", { body: { name: 123 } });
    const res = await PUT(req, createParams({ id: "f1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("moves folder to a new parent", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    const parentCuid = "cm1234567890abcdefghijklmn";
    const existing = { id: "f1", userId: DEFAULT_SESSION.user.id, parentId: null, name: "Folder" };
    mockFolderFindUnique
      .mockResolvedValueOnce(existing) // find existing
      .mockResolvedValueOnce(null); // dup check under new parent
    const updated = { ...existing, parentId: parentCuid, sortOrder: 0, createdAt: new Date(), updatedAt: new Date() };
    mockFolderUpdate.mockResolvedValue(updated);

    const req = createRequest("PUT", "http://localhost/api/folders/f1", { body: { parentId: parentCuid } });
    const res = await PUT(req, createParams({ id: "f1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json.parentId).toBe(parentCuid);
  });

  it("returns 400 for self-referencing parentId", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    // Use a CUID-format id so the Zod schema accepts it
    const cuid = "cm1234567890abcdefghijklmn";
    const existing = { id: cuid, userId: DEFAULT_SESSION.user.id, parentId: null, name: "Folder" };
    mockFolderFindUnique.mockResolvedValueOnce(existing);

    const req = createRequest("PUT", `http://localhost/api/folders/${cuid}`, { body: { name: "Folder", parentId: cuid } });
    const res = await PUT(req, createParams({ id: cuid }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("FOLDER_CIRCULAR_REFERENCE");
  });

  it("returns 400 when circular reference detected", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    const parentCuid = "cm1234567890abcdefghijklmn";
    const existing = { id: "f1", userId: DEFAULT_SESSION.user.id, parentId: null, name: "Folder" };
    mockFolderFindUnique.mockResolvedValueOnce(existing);
    vi.mocked(checkCircularReference).mockResolvedValueOnce(true);
    const req = createRequest("PUT", "http://localhost/api/folders/f1", { body: { parentId: parentCuid } });
    const res = await PUT(req, createParams({ id: "f1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("FOLDER_CIRCULAR_REFERENCE");
  });

  it("returns 400 when folder depth exceeded", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    const parentCuid = "cm1234567890abcdefghijklmn";
    const existing = { id: "f1", userId: DEFAULT_SESSION.user.id, parentId: null, name: "Folder" };
    mockFolderFindUnique.mockResolvedValueOnce(existing);
    vi.mocked(validateFolderDepth).mockRejectedValueOnce(new Error("depth exceeded"));
    const req = createRequest("PUT", "http://localhost/api/folders/f1", { body: { parentId: parentCuid } });
    const res = await PUT(req, createParams({ id: "f1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("FOLDER_MAX_DEPTH_EXCEEDED");
  });
});

describe("DELETE /api/folders/[id]", () => {
  let txFolderUpdate: ReturnType<typeof vi.fn>;
  let txFolderDelete: ReturnType<typeof vi.fn>;
  let txEntryUpdateMany: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    txFolderUpdate = vi.fn();
    txFolderDelete = vi.fn();
    txEntryUpdateMany = vi.fn();
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      await fn({
        folder: { update: txFolderUpdate, delete: txFolderDelete },
        passwordEntry: { updateMany: txEntryUpdateMany },
      });
    });
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const req = createRequest("DELETE", "http://localhost/api/folders/f1");
    const res = await DELETE(req, createParams({ id: "f1" }));
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 404 when folder not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFolderFindUnique.mockResolvedValue(null);
    const req = createRequest("DELETE", "http://localhost/api/folders/f1");
    const res = await DELETE(req, createParams({ id: "f1" }));
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it("returns 403 when folder belongs to another user", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFolderFindUnique.mockResolvedValue({ id: "f1", userId: "other", parentId: null, name: "F" });
    const req = createRequest("DELETE", "http://localhost/api/folders/f1");
    const res = await DELETE(req, createParams({ id: "f1" }));
    const { status } = await parseResponse(res);
    expect(status).toBe(403);
  });

  it("deletes folder and promotes children", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFolderFindUnique.mockResolvedValue({
      id: "f1",
      userId: DEFAULT_SESSION.user.id,
      parentId: null,
      name: "Parent",
    });
    mockFolderFindMany
      .mockResolvedValueOnce([{ id: "c1", name: "Child" }]) // children
      .mockResolvedValueOnce([]); // siblings at target

    const req = createRequest("DELETE", "http://localhost/api/folders/f1");
    const res = await DELETE(req, createParams({ id: "f1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json.success).toBe(true);
  });

  it("renames children on name conflict during promotion", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFolderFindUnique.mockResolvedValue({
      id: "f1",
      userId: DEFAULT_SESSION.user.id,
      parentId: null,
      name: "Parent",
    });
    mockFolderFindMany
      .mockResolvedValueOnce([{ id: "c1", name: "Parent" }]) // children
      .mockResolvedValueOnce([]); // siblings

    const req = createRequest("DELETE", "http://localhost/api/folders/f1");
    const res = await DELETE(req, createParams({ id: "f1" }));
    const { status } = await parseResponse(res);
    expect(status).toBe(200);

    expect(txFolderUpdate.mock.calls[0][0].data.name).toBe("Parent (2)");
  });

  it("increments suffix when (2) is also taken", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFolderFindUnique.mockResolvedValue({
      id: "f1",
      userId: DEFAULT_SESSION.user.id,
      parentId: null,
      name: "Parent",
    });
    mockFolderFindMany
      .mockResolvedValueOnce([{ id: "c1", name: "Parent" }]) // children
      .mockResolvedValueOnce([{ id: "s1", name: "Parent (2)" }]); // sibling already uses (2)

    const req = createRequest("DELETE", "http://localhost/api/folders/f1");
    const res = await DELETE(req, createParams({ id: "f1" }));
    const { status } = await parseResponse(res);
    expect(status).toBe(200);

    expect(txFolderUpdate.mock.calls[0][0].data.name).toBe("Parent (3)");
  });
});
