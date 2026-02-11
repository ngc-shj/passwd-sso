import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

// All mocks must be created inside vi.hoisted() to avoid hoisting issues
const { mockAuth, mockPrismaOrganization, mockRequireOrgMember, mockRequireOrgPermission, OrgAuthError } = vi.hoisted(() => {
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
    mockPrismaOrganization: {
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    mockRequireOrgMember: vi.fn(),
    mockRequireOrgPermission: vi.fn(),
    OrgAuthError: _OrgAuthError,
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { organization: mockPrismaOrganization },
}));
vi.mock("@/lib/org-auth", () => ({
  requireOrgMember: mockRequireOrgMember,
  requireOrgPermission: mockRequireOrgPermission,
  OrgAuthError,
}));

import { GET, PUT, DELETE } from "./route";

const ORG_ID = "org-123";
const now = new Date("2025-01-01T00:00:00Z");

const ownerMembership = {
  id: "member-1",
  orgId: ORG_ID,
  userId: "test-user-id",
  role: "OWNER",
  createdAt: now,
  updatedAt: now,
};

describe("GET /api/orgs/[orgId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireOrgMember.mockResolvedValue(ownerMembership);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}`),
      createParams({ orgId: ORG_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when not a member", async () => {
    mockRequireOrgMember.mockRejectedValue(new OrgAuthError("NOT_FOUND", 404));
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}`),
      createParams({ orgId: ORG_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("returns org details with counts", async () => {
    mockPrismaOrganization.findUnique.mockResolvedValue({
      id: ORG_ID,
      name: "My Org",
      slug: "my-org",
      description: null,
      createdAt: now,
      updatedAt: now,
      _count: { members: 5, passwords: 10 },
    });

    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}`),
      createParams({ orgId: ORG_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.role).toBe("OWNER");
    expect(json.memberCount).toBe(5);
    expect(json.passwordCount).toBe(10);
  });
});

describe("PUT /api/orgs/[orgId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireOrgPermission.mockResolvedValue(ownerMembership);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}`, { body: { name: "New" } }),
      createParams({ orgId: ORG_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when lacking permission", async () => {
    mockRequireOrgPermission.mockRejectedValue(new OrgAuthError("FORBIDDEN", 403));
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}`, { body: { name: "New" } }),
      createParams({ orgId: ORG_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("updates org name successfully", async () => {
    mockPrismaOrganization.update.mockResolvedValue({
      id: ORG_ID,
      name: "Updated Org",
      slug: "my-org",
      description: null,
      updatedAt: now,
    });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}`, { body: { name: "Updated Org" } }),
      createParams({ orgId: ORG_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.name).toBe("Updated Org");
  });
});

describe("DELETE /api/orgs/[orgId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireOrgPermission.mockResolvedValue(ownerMembership);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/orgs/${ORG_ID}`),
      createParams({ orgId: ORG_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when not OWNER", async () => {
    mockRequireOrgPermission.mockRejectedValue(new OrgAuthError("FORBIDDEN", 403));
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/orgs/${ORG_ID}`),
      createParams({ orgId: ORG_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("deletes org successfully", async () => {
    mockPrismaOrganization.delete.mockResolvedValue({});
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/orgs/${ORG_ID}`),
      createParams({ orgId: ORG_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockPrismaOrganization.delete).toHaveBeenCalledWith({ where: { id: ORG_ID } });
  });
});
