import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaOrgPasswordEntry, mockPrismaOrgPasswordFavorite, mockRequireOrgPermission, OrgAuthError } = vi.hoisted(() => {
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
    mockPrismaOrgPasswordEntry: { findUnique: vi.fn() },
    mockPrismaOrgPasswordFavorite: {
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    mockRequireOrgPermission: vi.fn(),
    OrgAuthError: _OrgAuthError,
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    orgPasswordEntry: mockPrismaOrgPasswordEntry,
    orgPasswordFavorite: mockPrismaOrgPasswordFavorite,
  },
}));
vi.mock("@/lib/org-auth", () => ({
  requireOrgPermission: mockRequireOrgPermission,
  OrgAuthError,
}));

import { POST } from "./route";
import { ORG_ROLE } from "@/lib/constants";

const ORG_ID = "org-123";
const PW_ID = "pw-456";

describe("POST /api/teams/[orgId]/passwords/[id]/favorite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireOrgPermission.mockResolvedValue({ role: ORG_ROLE.MEMBER });
  });

  it("returns OrgAuthError status when permission denied", async () => {
    mockRequireOrgPermission.mockRejectedValue(new OrgAuthError("INSUFFICIENT_PERMISSION", 403));
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${ORG_ID}/passwords/${PW_ID}/favorite`),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("INSUFFICIENT_PERMISSION");
  });

  it("rethrows non-OrgAuthError", async () => {
    mockRequireOrgPermission.mockRejectedValue(new Error("unexpected"));
    await expect(
      POST(
        createRequest("POST", `http://localhost:3000/api/teams/${ORG_ID}/passwords/${PW_ID}/favorite`),
        createParams({ orgId: ORG_ID, id: PW_ID }),
      ),
    ).rejects.toThrow("unexpected");
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${ORG_ID}/passwords/${PW_ID}/favorite`),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when entry not found", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${ORG_ID}/passwords/${PW_ID}/favorite`),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("adds favorite when not yet favorited", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({ orgId: ORG_ID });
    mockPrismaOrgPasswordFavorite.findUnique.mockResolvedValue(null);
    mockPrismaOrgPasswordFavorite.create.mockResolvedValue({});

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${ORG_ID}/passwords/${PW_ID}/favorite`),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.isFavorite).toBe(true);
  });

  it("removes favorite when already favorited", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({ orgId: ORG_ID });
    mockPrismaOrgPasswordFavorite.findUnique.mockResolvedValue({ id: "fav-1" });
    mockPrismaOrgPasswordFavorite.delete.mockResolvedValue({});

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/teams/${ORG_ID}/passwords/${PW_ID}/favorite`),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.isFavorite).toBe(false);
  });
});