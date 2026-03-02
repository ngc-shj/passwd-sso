import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaTag, mockPrismaUser, mockWithUserTenantRls } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaTag: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
  },
  mockPrismaUser: { findUnique: vi.fn() },
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
}));
vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { tag: mockPrismaTag, user: mockPrismaUser },
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));

import { GET, POST } from "./route";

describe("GET /api/tags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockPrismaUser.findUnique.mockResolvedValue({ tenantId: "tenant-1" });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const req = createRequest("GET", "http://localhost:3000/api/tags");
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("returns tags with password count and parentId", async () => {
    mockPrismaTag.findMany.mockResolvedValue([
      { id: "t1", name: "Work", color: "#ff0000", parentId: null, _count: { passwords: 3 } },
      { id: "t2", name: "Personal", color: null, parentId: null, _count: { passwords: 0 } },
    ]);
    const req = createRequest("GET", "http://localhost:3000/api/tags");
    const res = await GET(req);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual([
      { id: "t1", name: "Work", color: "#ff0000", parentId: null, passwordCount: 3 },
      { id: "t2", name: "Personal", color: null, parentId: null, passwordCount: 0 },
    ]);
  });

  it("returns empty array when no tags", async () => {
    mockPrismaTag.findMany.mockResolvedValue([]);
    const req = createRequest("GET", "http://localhost:3000/api/tags");
    const res = await GET(req);
    const json = await res.json();
    expect(json).toEqual([]);
  });
});

describe("POST /api/tags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockPrismaUser.findUnique.mockResolvedValue({ tenantId: "tenant-1" });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(createRequest("POST", "http://localhost:3000/api/tags", {
      body: { name: "Test" },
    }));
    expect(res.status).toBe(401);
  });

  it("returns 400 on invalid body", async () => {
    const res = await POST(createRequest("POST", "http://localhost:3000/api/tags", {
      body: {},
    }));
    expect(res.status).toBe(400);
  });

  it("returns 409 when tag name already exists", async () => {
    mockPrismaTag.findFirst.mockResolvedValue({ id: "existing" });
    const res = await POST(createRequest("POST", "http://localhost:3000/api/tags", {
      body: { name: "Work" },
    }));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("TAG_ALREADY_EXISTS");
  });

  it("creates tag successfully (201)", async () => {
    mockPrismaTag.findFirst.mockResolvedValue(null);
    mockPrismaTag.create.mockResolvedValue({
      id: "new-tag-id",
      name: "Finance",
      color: "#00ff00",
      parentId: null,
    });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/tags", {
      body: { name: "Finance", color: "#00ff00" },
    }));
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json).toEqual({ id: "new-tag-id", name: "Finance", color: "#00ff00", parentId: null });
  });

  it("creates tag with null color when not provided", async () => {
    mockPrismaTag.findFirst.mockResolvedValue(null);
    mockPrismaTag.create.mockResolvedValue({
      id: "new-tag-id",
      name: "NoColor",
      color: null,
      parentId: null,
    });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/tags", {
      body: { name: "NoColor" },
    }));
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json.color).toBeNull();
    expect(json.parentId).toBeNull();
  });

  it("creates tag with parentId", async () => {
    const parentCuid = "cm1234567890abcdefghijklmno";
    const childCuid = "cm9876543210zyxwvutsrqponml";
    mockPrismaTag.findMany.mockResolvedValue([
      { id: parentCuid, name: "Work", parentId: null },
    ]);
    mockPrismaTag.findFirst.mockResolvedValue(null);
    mockPrismaTag.create.mockResolvedValue({
      id: childCuid,
      name: "Projects",
      color: null,
      parentId: parentCuid,
    });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/tags", {
      body: { name: "Projects", parentId: parentCuid },
    }));
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json).toEqual({ id: childCuid, name: "Projects", color: null, parentId: parentCuid });
  });
});
