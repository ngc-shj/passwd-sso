import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaOrgPasswordEntry, mockRequireOrgPermission, OrgAuthError } = vi.hoisted(() => {
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
    mockPrismaOrgPasswordEntry: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    mockRequireOrgPermission: vi.fn(),
    OrgAuthError: _OrgAuthError,
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { orgPasswordEntry: mockPrismaOrgPasswordEntry, auditLog: { create: vi.fn().mockResolvedValue({}) } },
}));
vi.mock("@/lib/org-auth", () => ({
  requireOrgPermission: mockRequireOrgPermission,
  OrgAuthError,
}));

import { POST } from "./route";

const ORG_ID = "org-123";
const PW_ID = "pw-456";

describe("POST /api/orgs/[orgId]/passwords/[id]/restore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireOrgPermission.mockResolvedValue({ role: "ADMIN" });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}/restore`),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when entry not found", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}/restore`),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when entry is not in trash", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      id: PW_ID,
      orgId: ORG_ID,
      deletedAt: null,
    });
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}/restore`),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("restores entry from trash", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      id: PW_ID,
      orgId: ORG_ID,
      deletedAt: new Date(),
    });
    mockPrismaOrgPasswordEntry.update.mockResolvedValue({});

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}/restore`),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
  });
});
