import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaOrgTag, mockRequireOrgPermission, OrgAuthError } = vi.hoisted(() => {
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
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    mockRequireOrgPermission: vi.fn(),
    OrgAuthError: _OrgAuthError,
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { orgTag: mockPrismaOrgTag },
}));
vi.mock("@/lib/org-auth", () => ({
  requireOrgPermission: mockRequireOrgPermission,
  OrgAuthError,
}));

import { PUT, DELETE } from "./route";

const ORG_ID = "org-123";
const TAG_ID = "tag-456";

describe("PUT /api/orgs/[orgId]/tags/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireOrgPermission.mockResolvedValue({ role: "MEMBER" });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/tags/${TAG_ID}`, { body: { name: "New" } }),
      createParams({ orgId: ORG_ID, id: TAG_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when tag not found", async () => {
    mockPrismaOrgTag.findUnique.mockResolvedValue(null);
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/tags/${TAG_ID}`, { body: { name: "New" } }),
      createParams({ orgId: ORG_ID, id: TAG_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("updates tag successfully", async () => {
    mockPrismaOrgTag.findUnique.mockResolvedValue({ id: TAG_ID, orgId: ORG_ID });
    mockPrismaOrgTag.update.mockResolvedValue({ id: TAG_ID, name: "Updated", color: "#00ff00" });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/tags/${TAG_ID}`, {
        body: { name: "Updated", color: "#00ff00" },
      }),
      createParams({ orgId: ORG_ID, id: TAG_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.name).toBe("Updated");
  });
});

describe("DELETE /api/orgs/[orgId]/tags/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireOrgPermission.mockResolvedValue({ role: "MEMBER" });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/orgs/${ORG_ID}/tags/${TAG_ID}`),
      createParams({ orgId: ORG_ID, id: TAG_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when tag not found", async () => {
    mockPrismaOrgTag.findUnique.mockResolvedValue(null);
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/orgs/${ORG_ID}/tags/${TAG_ID}`),
      createParams({ orgId: ORG_ID, id: TAG_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("deletes tag successfully", async () => {
    mockPrismaOrgTag.findUnique.mockResolvedValue({ id: TAG_ID, orgId: ORG_ID });
    mockPrismaOrgTag.delete.mockResolvedValue({});

    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/orgs/${ORG_ID}/tags/${TAG_ID}`),
      createParams({ orgId: ORG_ID, id: TAG_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
  });
});
