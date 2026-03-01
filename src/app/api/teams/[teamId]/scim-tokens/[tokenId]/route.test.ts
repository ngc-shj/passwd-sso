import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockAuth, mockRequireTeamPermission, TeamAuthError, mockLogAudit, mockTeam, mockScimToken, mockWithTeamTenantRls } = vi.hoisted(
  () => {
    class _TeamAuthError extends Error {
      status: number;
      constructor(message: string, status: number) {
        super(message);
        this.name = "TeamAuthError";
        this.status = status;
      }
    }
    return {
      mockAuth: vi.fn(),
      mockRequireTeamPermission: vi.fn(),
      TeamAuthError: _TeamAuthError,
      mockLogAudit: vi.fn(),
      mockTeam: { findUnique: vi.fn() },
      mockScimToken: { findUnique: vi.fn(), update: vi.fn() },
      mockWithTeamTenantRls: vi.fn(async (_teamId: string, fn: () => unknown) => fn()),
    };
  },
);

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/team-auth", () => ({
  requireTeamPermission: mockRequireTeamPermission,
  TeamAuthError,
}));
vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
  extractRequestMeta: () => ({ ip: null, userAgent: null }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { team: mockTeam, scimToken: mockScimToken },
}));
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: mockWithTeamTenantRls,
}));

import { DELETE } from "./route";

function makeParams(teamId: string, tokenId: string) {
  return { params: Promise.resolve({ teamId: teamId, tokenId }) };
}

function makeReq() {
  return new NextRequest("http://localhost/api/teams/team-1/scim-tokens/t1", {
    method: "DELETE",
  });
}

describe("DELETE /api/teams/[teamId]/scim-tokens/[tokenId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockTeam.findUnique.mockResolvedValue({ tenantId: "tenant-1" });
  });

  it("returns 403 if no SCIM_MANAGE permission", async () => {
    mockRequireTeamPermission.mockRejectedValue(
      new TeamAuthError("FORBIDDEN", 403),
    );
    const res = await DELETE(makeReq(), makeParams("team-1", "t1"));
    expect(res.status).toBe(403);
  });

  it("returns 401 if not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await DELETE(makeReq(), makeParams("team-1", "t1"));
    expect(res.status).toBe(401);
  });

  it("returns 404 when token not found", async () => {
    mockScimToken.findUnique.mockResolvedValue(null);
    const res = await DELETE(makeReq(), makeParams("team-1", "t1"));
    expect(res.status).toBe(404);
  });

  it("returns 404 for tenant mismatch (IDOR prevention)", async () => {
    mockScimToken.findUnique.mockResolvedValue({
      id: "t1",
      tenantId: "tenant-2",
      revokedAt: null,
    });
    const res = await DELETE(makeReq(), makeParams("team-1", "t1"));
    expect(res.status).toBe(404);
  });

  it("returns 409 when token already revoked", async () => {
    mockScimToken.findUnique.mockResolvedValue({
      id: "t1",
      tenantId: "tenant-1",
      revokedAt: new Date(),
    });
    const res = await DELETE(makeReq(), makeParams("team-1", "t1"));
    expect(res.status).toBe(409);
  });

  it("revokes token and returns success across teams in same tenant", async () => {
    mockScimToken.findUnique.mockResolvedValue({
      id: "t1",
      tenantId: "tenant-1",
      revokedAt: null,
    });
    mockScimToken.update.mockResolvedValue({});

    const res = await DELETE(makeReq(), makeParams("team-1", "t1"));
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
