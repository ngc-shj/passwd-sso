import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaFolder, mockLogAudit } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaFolder: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
  },
  mockLogAudit: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { folder: mockPrismaFolder },
}));
vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
  extractRequestMeta: vi.fn(() => ({ ip: "127.0.0.1", userAgent: "test" })),
}));
vi.mock("@/lib/folder-utils", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/folder-utils")>();
  return {
    ...original,
    validateFolderDepth: vi.fn().mockResolvedValue(1),
  };
});

import { GET, POST } from "./route";
import { validateFolderDepth } from "@/lib/folder-utils";

const now = new Date("2025-06-01T00:00:00Z");

describe("GET /api/folders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns folders with entry count", async () => {
    mockPrismaFolder.findMany.mockResolvedValue([
      {
        id: "f1",
        name: "Work",
        parentId: null,
        sortOrder: 0,
        _count: { entries: 3 },
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "f2",
        name: "Personal",
        parentId: "f1",
        sortOrder: 1,
        _count: { entries: 0 },
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual([
      { id: "f1", name: "Work", parentId: null, sortOrder: 0, entryCount: 3, createdAt: now.toISOString(), updatedAt: now.toISOString() },
      { id: "f2", name: "Personal", parentId: "f1", sortOrder: 1, entryCount: 0, createdAt: now.toISOString(), updatedAt: now.toISOString() },
    ]);
  });

  it("returns empty array when no folders", async () => {
    mockPrismaFolder.findMany.mockResolvedValue([]);
    const res = await GET();
    const json = await res.json();
    expect(json).toEqual([]);
  });
});

describe("POST /api/folders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", "http://localhost:3000/api/folders", {
        body: { name: "Test" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 on invalid body (empty name)", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost:3000/api/folders", {
        body: { name: "" },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when max depth exceeded", async () => {
    vi.mocked(validateFolderDepth).mockRejectedValueOnce(
      new Error("FOLDER_MAX_DEPTH_EXCEEDED"),
    );

    const res = await POST(
      createRequest("POST", "http://localhost:3000/api/folders", {
        body: { name: "Deep", parentId: "cm000000000000000000deep1" },
      }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("FOLDER_MAX_DEPTH_EXCEEDED");
  });

  it("returns 409 when root folder name already exists", async () => {
    mockPrismaFolder.findFirst.mockResolvedValue({ id: "existing" });

    const res = await POST(
      createRequest("POST", "http://localhost:3000/api/folders", {
        body: { name: "Work" },
      }),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("FOLDER_ALREADY_EXISTS");
  });

  it("returns 409 when child folder name already exists", async () => {
    mockPrismaFolder.findUnique.mockResolvedValue({ id: "existing" });

    const res = await POST(
      createRequest("POST", "http://localhost:3000/api/folders", {
        body: { name: "SubFolder", parentId: "cm000000000000000parent1" },
      }),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("FOLDER_ALREADY_EXISTS");
  });

  it("creates folder successfully (201)", async () => {
    mockPrismaFolder.findFirst.mockResolvedValue(null);
    mockPrismaFolder.create.mockResolvedValue({
      id: "new-folder-id",
      name: "Finance",
      parentId: null,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });

    const res = await POST(
      createRequest("POST", "http://localhost:3000/api/folders", {
        body: { name: "Finance" },
      }),
    );
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json).toEqual({
      id: "new-folder-id",
      name: "Finance",
      parentId: null,
      sortOrder: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
  });

  it("creates folder with parentId and sortOrder", async () => {
    mockPrismaFolder.findUnique.mockResolvedValue(null);
    mockPrismaFolder.create.mockResolvedValue({
      id: "child-folder-id",
      name: "SubFolder",
      parentId: "cm000000000000000parent1",
      sortOrder: 5,
      createdAt: now,
      updatedAt: now,
    });

    const res = await POST(
      createRequest("POST", "http://localhost:3000/api/folders", {
        body: { name: "SubFolder", parentId: "cm000000000000000parent1", sortOrder: 5 },
      }),
    );
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json.parentId).toBe("cm000000000000000parent1");
    expect(json.sortOrder).toBe(5);
  });
});
