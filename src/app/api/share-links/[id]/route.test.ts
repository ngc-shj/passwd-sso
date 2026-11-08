import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const {
  mockTx,
  mockAuth,
  mockPrismaPasswordShare,
  mockWithUserTenantRls,
  mockWithTenantRls,
  mockLogAuditInTx,
} = vi.hoisted(() => {
  const mockPrismaPasswordShare = {
    findUnique: vi.fn(),
    // The revoke's compare-and-set, on the transaction client.
    updateMany: vi.fn(async () => ({ count: 1 })),
  };
  const tx = { passwordShare: mockPrismaPasswordShare };
  return {
    mockTx: tx,
    mockAuth: vi.fn(),
    mockPrismaPasswordShare,
    mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
    mockWithTenantRls: vi.fn(async (_prisma: unknown, _tenantId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    mockLogAuditInTx: vi.fn(),
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { passwordShare: mockPrismaPasswordShare },
}));
const { mockRequireTeamPermission, TeamAuthError } = vi.hoisted(() => ({
  mockRequireTeamPermission: vi.fn(async () => ({ role: "ADMIN" })),
  TeamAuthError: class TeamAuthError extends Error {
    constructor(message: string, readonly status: number) {
      super(message);
    }
  },
}));
vi.mock("@/lib/auth/access/team-auth", () => ({
  requireTeamPermission: mockRequireTeamPermission,
  TeamAuthError,
}));
// A team link's creator is held to the team's IP restriction; allowed here.
vi.mock("@/lib/team/team-policy", () => ({
  withTeamIpRestriction: vi.fn(async () => undefined),
  PolicyViolationError: class PolicyViolationError extends Error {},
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditInTx: mockLogAuditInTx,
  personalAuditBase: (_req: unknown, userId: string) => ({ scope: "PERSONAL", userId, ip: "127.0.0.1", userAgent: "test", acceptLanguage: null }),
  teamAuditBase: (_req: unknown, userId: string, teamId: string) => ({ scope: "TEAM", userId, teamId, ip: "127.0.0.1", userAgent: "test", acceptLanguage: null }),
  tenantAuditBase: (_req: unknown, userId: string, tenantId: string) => ({ scope: "TENANT", userId, tenantId, ip: "127.0.0.1", userAgent: "test", acceptLanguage: null }),
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: mockWithTenantRls,
}));
vi.mock("@/lib/logger", () => ({
  default: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/lib/http/with-request-log", () => ({
  withRequestLog: (fn: (...args: unknown[]) => unknown) => fn,
}));

const ADMIN_ID = "admin-id";
import { DELETE } from "./route";

const SHARE_ID = "share-abc123";

const MOCK_SHARE = {
  id: SHARE_ID,
  shareType: "PASSWORD",
  createdById: "user-1",
  revokedAt: null,
  tenantId: "tenant-1",
  teamPasswordEntryId: null,
  teamPasswordEntry: null,
};

describe("DELETE /api/share-links/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockPrismaPasswordShare.findUnique.mockResolvedValue(MOCK_SHARE);
    mockPrismaPasswordShare.updateMany.mockResolvedValue({ count: 1 });
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/share-links/${SHARE_ID}`),
      createParams({ id: SHARE_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when share link not found", async () => {
    mockPrismaPasswordShare.findUnique.mockResolvedValue(null);
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/share-links/${SHARE_ID}`),
      createParams({ id: SHARE_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when share belongs to another user", async () => {
    mockPrismaPasswordShare.findUnique.mockResolvedValue({
      ...MOCK_SHARE,
      createdById: "other-user",
    });
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/share-links/${SHARE_ID}`),
      createParams({ id: SHARE_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 409 when share is already revoked", async () => {
    mockPrismaPasswordShare.findUnique.mockResolvedValue({
      ...MOCK_SHARE,
      revokedAt: new Date("2026-01-01"),
    });
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/share-links/${SHARE_ID}`),
      createParams({ id: SHARE_ID }),
    );
    expect(res.status).toBe(409);
  });

  it("revokes the share link successfully", async () => {
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/share-links/${SHARE_ID}`),
      createParams({ id: SHARE_ID }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(mockPrismaPasswordShare.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: SHARE_ID, createdById: "user-1", revokedAt: null },
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      }),
    );
  });

  it("logs SHARE_REVOKE audit event for password share", async () => {
    await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/share-links/${SHARE_ID}`),
      createParams({ id: SHARE_ID }),
    );
    expect(mockLogAuditInTx).toHaveBeenCalledWith(
      mockTx,
      "tenant-1",
      expect.objectContaining({ action: "SHARE_REVOKE" }),
    );
  });

  it("logs SEND_REVOKE audit event for text send", async () => {
    mockPrismaPasswordShare.findUnique.mockResolvedValue({
      ...MOCK_SHARE,
      shareType: "TEXT",
    });
    await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/share-links/${SHARE_ID}`),
      createParams({ id: SHARE_ID }),
    );
    expect(mockLogAuditInTx).toHaveBeenCalledWith(
      mockTx,
      "tenant-1",
      expect.objectContaining({ action: "SEND_REVOKE" }),
    );
  });

  // A team OWNER/ADMIN revoking another member's team link (#995).
  describe("team admin path", () => {
    const teamShare = {
      id: "s1",
      shareType: "ENTRY_SHARE",
      createdById: "creator-id",
      revokedAt: null,
      tenantId: "tenant-1",
      teamPasswordEntryId: "entry-1",
      teamPasswordEntry: { teamId: "team-1" },
    };

    it("revokes with the team-scoped compare-and-set and audits it as an admin revocation", async () => {
      mockAuth.mockResolvedValue({ user: { id: ADMIN_ID } });
      mockPrismaPasswordShare.findUnique.mockResolvedValue(teamShare);
      mockPrismaPasswordShare.updateMany.mockResolvedValue({ count: 1 });

      const res = await DELETE(createRequest("DELETE", "http://localhost/api/share-links/s1") as never, createParams({ id: "s1" }));

      expect(res.status).toBe(200);
      expect(mockRequireTeamPermission).toHaveBeenCalledWith(ADMIN_ID, "team-1", "password:delete", expect.anything());
      expect(mockPrismaPasswordShare.updateMany).toHaveBeenCalledWith({
        where: { id: "s1", teamPasswordEntryId: "entry-1", revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      expect(mockLogAuditInTx.mock.calls[0][2]).toMatchObject({
        metadata: { revokedByTeamAdmin: true, creatorId: "creator-id" },
      });
    });

    it("an admin revoke that lost the race answers ALREADY_REVOKED and writes no audit", async () => {
      mockAuth.mockResolvedValue({ user: { id: ADMIN_ID } });
      mockPrismaPasswordShare.findUnique.mockResolvedValue(teamShare);
      mockPrismaPasswordShare.updateMany.mockResolvedValue({ count: 0 });

      const res = await DELETE(createRequest("DELETE", "http://localhost/api/share-links/s1") as never, createParams({ id: "s1" }));

      expect(res.status).toBe(409);
      expect(mockLogAuditInTx).not.toHaveBeenCalled();
    });

    it("a team member without PASSWORD_DELETE gets 404 and nothing is written", async () => {
      mockAuth.mockResolvedValue({ user: { id: ADMIN_ID } });
      mockPrismaPasswordShare.findUnique.mockResolvedValue(teamShare);
      mockRequireTeamPermission.mockRejectedValueOnce(new TeamAuthError("FORBIDDEN", 403));

      const res = await DELETE(createRequest("DELETE", "http://localhost/api/share-links/s1") as never, createParams({ id: "s1" }));

      expect(res.status).toBe(404);
      expect(mockPrismaPasswordShare.updateMany).not.toHaveBeenCalled();
    });
  });
});
