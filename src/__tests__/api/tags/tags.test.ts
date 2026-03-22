import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import {
  createRequest,
  parseResponse,
} from "../../helpers/request-builder";

const {
  mockAuth,
  mockFindMany,
  mockFindFirst,
  mockFindUnique,
  mockCreate,
  mockUserFindUnique,
  mockWithUserTenantRls,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockFindMany: vi.fn(),
  mockFindFirst: vi.fn(),
  mockFindUnique: vi.fn(),
  mockCreate: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockWithUserTenantRls: vi.fn(
    async (_userId: string, fn: () => unknown) => fn(),
  ),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tag: {
      findMany: mockFindMany,
      findFirst: mockFindFirst,
      findUnique: mockFindUnique,
      create: mockCreate,
    },
    user: {
      findUnique: mockUserFindUnique,
    },
  },
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));

import { GET, POST } from "@/app/api/tags/route";

describe("GET /api/tags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("GET", "http://localhost/api/tags");
    const res = await GET(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns flat tags with parentId by default", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindMany.mockResolvedValue([
      { id: "t1", name: "A", color: null, parentId: null, _count: { passwords: 2 } },
      { id: "t2", name: "B", color: "#ff0000", parentId: "t1", _count: { passwords: 0 } },
    ]);

    const req = createRequest("GET", "http://localhost/api/tags");
    const res = await GET(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json).toHaveLength(2);
    expect(json[0].parentId).toBeNull();
    expect(json[1].parentId).toBe("t1");
  });

  it("returns tree-ordered tags with depth when tree=true", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindMany.mockResolvedValue([
      { id: "t1", name: "A", color: null, parentId: null, _count: { passwords: 1 } },
      { id: "t2", name: "B", color: null, parentId: "t1", _count: { passwords: 0 } },
      { id: "t3", name: "C", color: null, parentId: null, _count: { passwords: 3 } },
    ]);

    const req = createRequest("GET", "http://localhost/api/tags", {
      searchParams: { tree: "true" },
    });
    const res = await GET(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json).toHaveLength(3);
    // Tree order: A (depth 0), B (depth 1), C (depth 0)
    expect(json[0]).toMatchObject({ name: "A", depth: 0 });
    expect(json[1]).toMatchObject({ name: "B", depth: 1 });
    expect(json[2]).toMatchObject({ name: "C", depth: 0 });
  });
});

describe("POST /api/tags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a root tag", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockUserFindUnique.mockResolvedValue({ tenantId: "tenant-1" });
    mockFindFirst.mockResolvedValue(null);
    mockCreate.mockResolvedValue({
      id: "new-1",
      name: "Work",
      color: null,
      parentId: null,
    });

    const req = createRequest("POST", "http://localhost/api/tags", {
      body: { name: "Work" },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(201);
    expect(json.name).toBe("Work");
    expect(json.parentId).toBeNull();
  });

  it("creates a child tag with parentId", async () => {
    const parentUuid = "00000000-0000-4000-a000-000000000001";
    const childUuid = "00000000-0000-4000-a000-000000000002";
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockUserFindUnique.mockResolvedValue({ tenantId: "tenant-1" });
    // findMany for validateParentChain
    mockFindMany.mockResolvedValue([
      { id: parentUuid, name: "Parent", parentId: null },
    ]);
    mockFindFirst.mockResolvedValue(null);
    mockCreate.mockResolvedValue({
      id: childUuid,
      name: "Child",
      color: null,
      parentId: parentUuid,
    });

    const req = createRequest("POST", "http://localhost/api/tags", {
      body: { name: "Child", parentId: parentUuid },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(201);
    expect(json.parentId).toBe(parentUuid);
  });

  it("returns 409 for duplicate name at same level", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockUserFindUnique.mockResolvedValue({ tenantId: "tenant-1" });
    mockFindFirst.mockResolvedValue({ id: "existing-1", name: "Dup" });

    const req = createRequest("POST", "http://localhost/api/tags", {
      body: { name: "Dup" },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(409);
    expect(json.error).toBe("TAG_ALREADY_EXISTS");
  });

  it("returns 400 when depth exceeds maximum", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockUserFindUnique.mockResolvedValue({ tenantId: "tenant-1" });
    // Chain: l1 -> l2 -> l3, trying to add under l3 (depth 4)
    mockFindMany.mockResolvedValue([
      { id: "00000000-0000-4000-a000-000000000011", name: "L1", parentId: null },
      { id: "00000000-0000-4000-a000-000000000012", name: "L2", parentId: "00000000-0000-4000-a000-000000000011" },
      { id: "00000000-0000-4000-a000-000000000013", name: "L3", parentId: "00000000-0000-4000-a000-000000000012" },
    ]);

    const req = createRequest("POST", "http://localhost/api/tags", {
      body: { name: "TooDeep", parentId: "00000000-0000-4000-a000-000000000013" },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });
});
