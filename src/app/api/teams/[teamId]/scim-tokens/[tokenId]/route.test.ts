import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockAuth, mockRequireOrgPermission, OrgAuthError, mockLogAudit, mockScimToken } = vi.hoisted(
  () => {
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
      mockRequireOrgPermission: vi.fn(),
      OrgAuthError: _OrgAuthError,
      mockLogAudit: vi.fn(),
      mockScimToken: { findUnique: vi.fn(), update: vi.fn() },
    };
  },
);

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/team-auth", () => ({
  requireOrgPermission: mockRequireOrgPermission,
  OrgAuthError,
}));
vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
  extractRequestMeta: () => ({ ip: null, userAgent: null }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { scimToken: mockScimToken },
}));

import { DELETE } from "./route";

function makeParams(orgId: string, tokenId: string) {
  return { params: Promise.resolve({ teamId: orgId, tokenId }) };
}

function makeReq() {
  return new NextRequest("http://localhost/api/teams/org-1/scim-tokens/t1", {
    method: "DELETE",
  });
}

describe("DELETE /api/teams/[teamId]/scim-tokens/[tokenId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireOrgPermission.mockResolvedValue(undefined);
  });

  it("returns 403 if no SCIM_MANAGE permission", async () => {
    mockRequireOrgPermission.mockRejectedValue(
      new OrgAuthError("FORBIDDEN", 403),
    );
    const res = await DELETE(makeReq(), makeParams("org-1", "t1"));
    expect(res.status).toBe(403);
  });

  it("returns 401 if not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await DELETE(makeReq(), makeParams("org-1", "t1"));
    expect(res.status).toBe(401);
  });

  it("returns 404 when token not found", async () => {
    mockScimToken.findUnique.mockResolvedValue(null);
    const res = await DELETE(makeReq(), makeParams("org-1", "t1"));
    expect(res.status).toBe(404);
  });

  it("returns 404 for orgId mismatch (IDOR prevention)", async () => {
    mockScimToken.findUnique.mockResolvedValue({
      id: "t1",
      orgId: "other-org", // different org
      revokedAt: null,
    });
    const res = await DELETE(makeReq(), makeParams("org-1", "t1"));
    expect(res.status).toBe(404);
  });

  it("returns 409 when token already revoked", async () => {
    mockScimToken.findUnique.mockResolvedValue({
      id: "t1",
      orgId: "org-1",
      revokedAt: new Date(),
    });
    const res = await DELETE(makeReq(), makeParams("org-1", "t1"));
    expect(res.status).toBe(409);
  });

  it("revokes token and returns success", async () => {
    mockScimToken.findUnique.mockResolvedValue({
      id: "t1",
      orgId: "org-1",
      revokedAt: null,
    });
    mockScimToken.update.mockResolvedValue({});

    const res = await DELETE(makeReq(), makeParams("org-1", "t1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(mockScimToken.update).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: { revokedAt: expect.any(Date) },
    });
    expect(mockLogAudit).toHaveBeenCalled();
  });
});
