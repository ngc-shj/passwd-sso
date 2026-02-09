import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaOrgTag, mockRequireOrgMember, mockRequireOrgPermission, OrgAuthError } = vi.hoisted(() => {
  class _OrgAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "OrgAuthError";
      this.status = status;
    }
  }
  return {
    mockAuth: vi.fn(),
    mockPrismaOrgTag: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    mockRequireOrgMember: vi.fn(),
    mockRequireOrgPermission: vi.fn(),
    OrgAuthError: _OrgAuthError,
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { orgTag: mockPrismaOrgTag },
}));
vi.mock("@/lib/org-auth", () => ({
  requireOrgMember: mockRequireOrgMember,
  requireOrgPermission: mockRequireOrgPermission,
  OrgAuthError,
}));

import { GET, POST } from "./route";

const ORG_ID = "org-123";

describe("GET /api/orgs/[orgId]/tags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireOrgMember.mockResolvedValue({ role: "MEMBER" });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/tags`),
      createParams({ orgId: ORG_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns org tags with counts", async () => {
    mockPrismaOrgTag.findMany.mockResolvedValue([
      { id: "t1", name: "Work", color: "#ff0000", _count: { passwords: 5 } },
    ]);

    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/tags`),
      createParams({ orgId: ORG_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json[0].count).toBe(5);
  });
});

describe("POST /api/orgs/[orgId]/tags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireOrgPermission.mockResolvedValue({ role: "MEMBER" });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/tags`, { body: { name: "T" } }),
      createParams({ orgId: ORG_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 409 when tag already exists", async () => {
    mockPrismaOrgTag.findUnique.mockResolvedValue({ id: "existing" });
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/tags`, { body: { name: "Work" } }),
      createParams({ orgId: ORG_ID }),
    );
    expect(res.status).toBe(409);
  });

  it("creates org tag (201)", async () => {
    mockPrismaOrgTag.findUnique.mockResolvedValue(null);
    mockPrismaOrgTag.create.mockResolvedValue({ id: "new-tag", name: "Finance", color: null });

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/tags`, { body: { name: "Finance" } }),
      createParams({ orgId: ORG_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json.name).toBe("Finance");
    expect(json.count).toBe(0);
  });
});
