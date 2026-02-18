import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaFolder, mockPrismaPasswordEntry, mockPrismaTransaction, mockLogAudit } =
  vi.hoisted(() => ({
    mockAuth: vi.fn(),
    mockPrismaFolder: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    mockPrismaPasswordEntry: {
      updateMany: vi.fn(),
    },
    mockPrismaTransaction: vi.fn(),
    mockLogAudit: vi.fn(),
  }));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    folder: mockPrismaFolder,
    passwordEntry: mockPrismaPasswordEntry,
    $transaction: mockPrismaTransaction,
  },
}));
vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
  extractRequestMeta: vi.fn(() => ({ ip: "127.0.0.1", userAgent: "test" })),
}));
vi.mock("@/lib/folder-utils", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/folder-utils")>();
  return {
    ...original,
    validateParentFolder: vi.fn().mockResolvedValue({ parentId: null, ownerId: "user-1" }),
    validateFolderDepth: vi.fn().mockResolvedValue(1),
    checkCircularReference: vi.fn().mockResolvedValue(false),
  };
});

import { PUT, DELETE } from "./route";
import { validateParentFolder, validateFolderDepth, checkCircularReference } from "@/lib/folder-utils";

const FOLDER_ID = "cm000000000000000folder1";
const now = new Date("2025-06-01T00:00:00Z");
const ownedFolder = {
  id: FOLDER_ID,
  name: "Work",
  parentId: null,
  userId: "user-1",
  sortOrder: 0,
  createdAt: now,
  updatedAt: now,
};

describe("PUT /api/folders/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/folders/${FOLDER_ID}`, {
        body: { name: "Updated" },
      }),
      createParams({ id: FOLDER_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when folder not found", async () => {
    mockPrismaFolder.findUnique.mockResolvedValue(null);
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/folders/${FOLDER_ID}`, {
        body: { name: "Updated" },
      }),
      createParams({ id: FOLDER_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 when folder belongs to another user", async () => {
    mockPrismaFolder.findUnique.mockResolvedValue({
      ...ownedFolder,
      userId: "other-user",
    });
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/folders/${FOLDER_ID}`, {
        body: { name: "Updated" },
      }),
      createParams({ id: FOLDER_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("updates folder name successfully", async () => {
    mockPrismaFolder.findUnique.mockResolvedValue(ownedFolder);
    mockPrismaFolder.findFirst.mockResolvedValue(null);
    mockPrismaFolder.update.mockResolvedValue({
      ...ownedFolder,
      name: "Updated",
    });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/folders/${FOLDER_ID}`, {
        body: { name: "Updated" },
      }),
      createParams({ id: FOLDER_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.name).toBe("Updated");
  });

  it("returns 404 when parentId belongs to another user or does not exist", async () => {
    mockPrismaFolder.findUnique.mockResolvedValue(ownedFolder);
    vi.mocked(validateParentFolder).mockRejectedValueOnce(
      new Error("PARENT_NOT_FOUND"),
    );

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/folders/${FOLDER_ID}`, {
        body: { parentId: "cm000000000000000other01" },
      }),
      createParams({ id: FOLDER_ID }),
    );
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("NOT_FOUND");
  });

  it("returns 400 when parentId creates circular reference", async () => {
    mockPrismaFolder.findUnique.mockResolvedValue(ownedFolder);
    vi.mocked(checkCircularReference).mockResolvedValueOnce(true);

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/folders/${FOLDER_ID}`, {
        body: { parentId: "cm000000000000000child00" },
      }),
      createParams({ id: FOLDER_ID }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("FOLDER_CIRCULAR_REFERENCE");
  });

  it("returns 400 when setting parentId to self", async () => {
    mockPrismaFolder.findUnique.mockResolvedValue(ownedFolder);

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/folders/${FOLDER_ID}`, {
        body: { parentId: FOLDER_ID },
      }),
      createParams({ id: FOLDER_ID }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("FOLDER_CIRCULAR_REFERENCE");
  });

  it("returns 400 when parentId exceeds max depth", async () => {
    mockPrismaFolder.findUnique.mockResolvedValue(ownedFolder);
    vi.mocked(validateFolderDepth).mockRejectedValueOnce(
      new Error("FOLDER_MAX_DEPTH_EXCEEDED"),
    );

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/folders/${FOLDER_ID}`, {
        body: { parentId: "cm000000000000000deep001" },
      }),
      createParams({ id: FOLDER_ID }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("FOLDER_MAX_DEPTH_EXCEEDED");
  });

  it("returns 409 when renamed folder duplicates sibling name", async () => {
    mockPrismaFolder.findUnique.mockResolvedValue(ownedFolder);
    mockPrismaFolder.findFirst.mockResolvedValue({ id: "other-folder" });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/folders/${FOLDER_ID}`, {
        body: { name: "Duplicate" },
      }),
      createParams({ id: FOLDER_ID }),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("FOLDER_ALREADY_EXISTS");
  });
});

describe("DELETE /api/folders/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/folders/${FOLDER_ID}`),
      createParams({ id: FOLDER_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when folder not found", async () => {
    mockPrismaFolder.findUnique.mockResolvedValue(null);
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/folders/${FOLDER_ID}`),
      createParams({ id: FOLDER_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 when folder belongs to another user", async () => {
    mockPrismaFolder.findUnique.mockResolvedValue({
      ...ownedFolder,
      userId: "other-user",
    });
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/folders/${FOLDER_ID}`),
      createParams({ id: FOLDER_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("deletes folder and promotes children", async () => {
    mockPrismaFolder.findUnique.mockResolvedValue(ownedFolder);
    mockPrismaTransaction.mockResolvedValue([]);

    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/folders/${FOLDER_ID}`),
      createParams({ id: FOLDER_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockPrismaTransaction).toHaveBeenCalled();
  });
});
