import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import { createRequest, createParams, parseResponse } from "../../helpers/request-builder";

const {
  mockAuth,
  mockRequireOrgMember,
  mockRequireOrgPermission,
  mockOrgFolderFindMany,
  mockOrgFolderFindUnique,
  mockOrgFolderFindFirst,
  mockOrgFolderCreate,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireOrgMember: vi.fn(),
  mockRequireOrgPermission: vi.fn(),
  mockOrgFolderFindMany: vi.fn(),
  mockOrgFolderFindUnique: vi.fn(),
  mockOrgFolderFindFirst: vi.fn(),
  mockOrgFolderCreate: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/team-auth", () => {
  class OrgAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return {
    requireOrgMember: mockRequireOrgMember,
    requireOrgPermission: mockRequireOrgPermission,
    OrgAuthError,
  };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    orgFolder: {
      findMany: mockOrgFolderFindMany,
      findUnique: mockOrgFolderFindUnique,
      findFirst: mockOrgFolderFindFirst,
      create: mockOrgFolderCreate,
    },
  },
}));
vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "Test" }),
}));
vi.mock("@/lib/folder-utils", () => ({
  validateParentFolder: vi.fn(),
  validateFolderDepth: vi.fn(),
}));

import { GET, POST } from "@/app/api/teams/[teamId]/folders/route";
import { OrgAuthError } from "@/lib/team-auth";
import { validateParentFolder, validateFolderDepth } from "@/lib/folder-utils";

describe("GET /api/teams/[teamId]/folders", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const req = createRequest("GET");
    const res = await GET(req, createParams({ teamId: "o1" }));
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 403 when not org member", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireOrgMember.mockRejectedValue(new OrgAuthError("FORBIDDEN", 403));
    const req = createRequest("GET");
    const res = await GET(req, createParams({ teamId: "o1" }));
    const { status } = await parseResponse(res);
    expect(status).toBe(403);
  });

  it("returns folder list with entry counts", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireOrgMember.mockResolvedValue(undefined);
    mockOrgFolderFindMany.mockResolvedValue([
      {
        id: "f1",
        name: "Folder",
        parentId: null,
        sortOrder: 0,
        _count: { entries: 5 },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    const req = createRequest("GET");
    const res = await GET(req, createParams({ teamId: "o1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json).toHaveLength(1);
    expect(json[0].entryCount).toBe(5);
  });
});

describe("POST /api/teams/[teamId]/folders", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const req = createRequest("POST", undefined, { body: { name: "F" } });
    const res = await POST(req, createParams({ teamId: "o1" }));
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 403 when lacking permission", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireOrgPermission.mockRejectedValue(new OrgAuthError("FORBIDDEN", 403));
    const req = createRequest("POST", undefined, { body: { name: "F" } });
    const res = await POST(req, createParams({ teamId: "o1" }));
    const { status } = await parseResponse(res);
    expect(status).toBe(403);
  });

  it("returns 400 for invalid JSON", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireOrgPermission.mockResolvedValue(undefined);
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/teams/o1/folders", {
      method: "POST",
      body: "not json",
      headers: { "Content-Type": "text/plain" },
    });
    const res = await POST(req, createParams({ teamId: "o1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("INVALID_JSON");
  });

  it("returns 400 for validation error", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireOrgPermission.mockResolvedValue(undefined);
    const req = createRequest("POST", undefined, { body: { name: "" } });
    const res = await POST(req, createParams({ teamId: "o1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 409 for duplicate name at root", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireOrgPermission.mockResolvedValue(undefined);
    mockOrgFolderFindFirst.mockResolvedValue({ id: "existing" });
    const req = createRequest("POST", undefined, { body: { name: "Dup" } });
    const res = await POST(req, createParams({ teamId: "o1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(409);
    expect(json.error).toBe("FOLDER_ALREADY_EXISTS");
  });

  it("returns 409 for duplicate name under parent", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireOrgPermission.mockResolvedValue(undefined);
    const parentCuid = "cm1234567890abcdefghijklmn";
    mockOrgFolderFindUnique.mockResolvedValue({ id: "existing" });
    const req = createRequest("POST", undefined, { body: { name: "Dup", parentId: parentCuid } });
    const res = await POST(req, createParams({ teamId: "o1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(409);
    expect(json.error).toBe("FOLDER_ALREADY_EXISTS");
  });

  it("returns 404 when parent folder validation fails", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireOrgPermission.mockResolvedValue(undefined);
    const parentCuid = "cm1234567890abcdefghijklmn";
    vi.mocked(validateParentFolder).mockRejectedValue(new Error("not found"));
    const req = createRequest("POST", undefined, { body: { name: "New", parentId: parentCuid } });
    const res = await POST(req, createParams({ teamId: "o1" }));
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it("returns 400 when folder depth exceeded", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireOrgPermission.mockResolvedValue(undefined);
    vi.mocked(validateFolderDepth).mockRejectedValue(new Error("depth exceeded"));
    const req = createRequest("POST", undefined, { body: { name: "Deep" } });
    const res = await POST(req, createParams({ teamId: "o1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("FOLDER_MAX_DEPTH_EXCEEDED");
  });

  it("creates folder successfully", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireOrgPermission.mockResolvedValue(undefined);
    vi.mocked(validateFolderDepth).mockResolvedValue(undefined);
    mockOrgFolderFindFirst.mockResolvedValue(null);
    const created = {
      id: "f1",
      name: "New",
      parentId: null,
      sortOrder: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockOrgFolderCreate.mockResolvedValue(created);
    const req = createRequest("POST", undefined, { body: { name: "New" } });
    const res = await POST(req, createParams({ teamId: "o1" }));
    const { status, json } = await parseResponse(res);
    expect(status).toBe(201);
    expect(json.name).toBe("New");
  });
});
