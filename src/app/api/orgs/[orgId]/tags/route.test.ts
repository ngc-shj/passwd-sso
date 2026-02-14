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
import { ORG_ROLE } from "@/lib/constants";

const ORG_ID = "org-123";

describe("GET /api/orgs/[orgId]/tags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireOrgMember.mockResolvedValue({ role: ORG_ROLE.MEMBER });
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

  it("returns OrgAuthError status when not a member", async () => {
    mockRequireOrgMember.mockRejectedValue(new OrgAuthError("NOT_ORG_MEMBER", 403));
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/tags`),
      createParams({ orgId: ORG_ID }),
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("NOT_ORG_MEMBER");
  });

  it("rethrows non-OrgAuthError", async () => {
    mockRequireOrgMember.mockRejectedValue(new Error("unexpected"));
    await expect(
      GET(
        createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/tags`),
        createParams({ orgId: ORG_ID }),
      ),
    ).rejects.toThrow("unexpected");
  });

  it("excludes archived and deleted entries from count", async () => {
    mockPrismaOrgTag.findMany.mockResolvedValue([
      { id: "t1", name: "Work", color: null, _count: { passwords: 3 } },
    ]);

    await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/tags`),
      createParams({ orgId: ORG_ID }),
    );

    expect(mockPrismaOrgTag.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: {
          _count: {
            select: {
              passwords: {
                where: { deletedAt: null, isArchived: false },
              },
            },
          },
        },
      }),
    );
  });
});

describe("POST /api/orgs/[orgId]/tags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireOrgPermission.mockResolvedValue({ role: ORG_ROLE.MEMBER });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/tags`, { body: { name: "T" } }),
      createParams({ orgId: ORG_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns OrgAuthError status when permission denied", async () => {
    mockRequireOrgPermission.mockRejectedValue(new OrgAuthError("INSUFFICIENT_PERMISSION", 403));
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/tags`, { body: { name: "T" } }),
      createParams({ orgId: ORG_ID }),
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("INSUFFICIENT_PERMISSION");
  });

  it("rethrows non-OrgAuthError from requireOrgPermission", async () => {
    mockRequireOrgPermission.mockRejectedValue(new Error("unexpected"));
    await expect(
      POST(
        createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/tags`, { body: { name: "T" } }),
        createParams({ orgId: ORG_ID }),
      ),
    ).rejects.toThrow("unexpected");
  });

  it("returns 400 on malformed JSON", async () => {
    const { NextRequest } = await import("next/server");
    const req = new NextRequest(`http://localhost:3000/api/orgs/${ORG_ID}/tags`, {
      method: "POST",
      body: "not-json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req, createParams({ orgId: ORG_ID }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("INVALID_JSON");
  });

  it("returns 400 on validation error", async () => {
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/tags`, { body: {} }),
      createParams({ orgId: ORG_ID }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_ERROR");
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