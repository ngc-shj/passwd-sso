import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaOrgInvitation, mockRequireOrgPermission, OrgAuthError } = vi.hoisted(() => {
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
    mockPrismaOrgInvitation: {
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
    mockRequireOrgPermission: vi.fn(),
    OrgAuthError: _OrgAuthError,
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { orgInvitation: mockPrismaOrgInvitation },
}));
vi.mock("@/lib/org-auth", () => ({
  requireOrgPermission: mockRequireOrgPermission,
  OrgAuthError,
}));

import { DELETE } from "./route";
import { ORG_ROLE } from "@/lib/constants";

const ORG_ID = "org-123";
const INV_ID = "inv-456";

describe("DELETE /api/teams/[teamId]/invitations/[invId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireOrgPermission.mockResolvedValue({ role: ORG_ROLE.ADMIN });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${ORG_ID}/invitations/${INV_ID}`),
      createParams({ teamId: ORG_ID, invId: INV_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns OrgAuthError status when permission denied", async () => {
    mockRequireOrgPermission.mockRejectedValue(new OrgAuthError("INSUFFICIENT_PERMISSION", 403));
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${ORG_ID}/invitations/${INV_ID}`),
      createParams({ teamId: ORG_ID, invId: INV_ID }),
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("INSUFFICIENT_PERMISSION");
  });

  it("rethrows non-OrgAuthError", async () => {
    mockRequireOrgPermission.mockRejectedValue(new Error("unexpected"));
    await expect(
      DELETE(
        createRequest("DELETE", `http://localhost:3000/api/teams/${ORG_ID}/invitations/${INV_ID}`),
        createParams({ teamId: ORG_ID, invId: INV_ID }),
      ),
    ).rejects.toThrow("unexpected");
  });

  it("returns 404 when invitation not found", async () => {
    mockPrismaOrgInvitation.findUnique.mockResolvedValue(null);
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${ORG_ID}/invitations/${INV_ID}`),
      createParams({ teamId: ORG_ID, invId: INV_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when invitation belongs to different org", async () => {
    mockPrismaOrgInvitation.findUnique.mockResolvedValue({ id: INV_ID, orgId: "other-org" });
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${ORG_ID}/invitations/${INV_ID}`),
      createParams({ teamId: ORG_ID, invId: INV_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("deletes invitation successfully", async () => {
    mockPrismaOrgInvitation.findUnique.mockResolvedValue({ id: INV_ID, orgId: ORG_ID });
    mockPrismaOrgInvitation.delete.mockResolvedValue({});

    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/teams/${ORG_ID}/invitations/${INV_ID}`),
      createParams({ teamId: ORG_ID, invId: INV_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
  });
});