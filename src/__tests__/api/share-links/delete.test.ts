import { describe, it, expect, vi, beforeEach } from "vitest";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import { createRequest, createParams, parseResponse } from "../../helpers/request-builder";

const { mockTx, mockAuth, mockFindUnique, mockUpdate, mockWithUserTenantRls, mockWithTenantRls, mockLogAuditInTx } = vi.hoisted(() => {
  // The revoke's compare-and-set runs on the transaction client.
  const mockUpdate = vi.fn();
  const tx = { passwordShare: { updateMany: mockUpdate } };
  return {
    mockTx: tx,
    mockAuth: vi.fn(),
    mockFindUnique: vi.fn(),
    mockUpdate,
    mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
    mockWithTenantRls: vi.fn(async (_prisma: unknown, _tenantId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    mockLogAuditInTx: vi.fn(),
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordShare: { findUnique: mockFindUnique },
    teamPasswordEntry: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditInTx: mockLogAuditInTx,
  personalAuditBase: (_req: unknown, userId: string) => ({ scope: "PERSONAL", userId, ip: "127.0.0.1", userAgent: "Test", acceptLanguage: null }),
  teamAuditBase: (_req: unknown, userId: string, teamId: string) => ({ scope: "TEAM", userId, teamId, ip: "127.0.0.1", userAgent: "Test", acceptLanguage: null }),
  tenantAuditBase: (_req: unknown, userId: string, tenantId: string) => ({ scope: "TENANT", userId, tenantId, ip: "127.0.0.1", userAgent: "Test", acceptLanguage: null }),
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
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: mockWithTenantRls,
}));

const ADMIN_ID = "admin-id";
import { DELETE } from "@/app/api/share-links/[id]/route";

describe("DELETE /api/share-links/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("DELETE", "http://localhost/api/share-links/s1");
    const res = await DELETE(req as never, createParams({ id: "s1" }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 404 when share not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindUnique.mockResolvedValue(null);

    const req = createRequest("DELETE", "http://localhost/api/share-links/s1");
    const res = await DELETE(req as never, createParams({ id: "s1" }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(404);
    expect(json.error).toBe(API_ERROR.NOT_FOUND);
  });

  it("returns 404 when share belongs to another user", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindUnique.mockResolvedValue({
      id: "s1",
      shareType: "ENTRY_SHARE",
      createdById: "other-user",
      revokedAt: null,
      teamPasswordEntryId: null,
    });

    const req = createRequest("DELETE", "http://localhost/api/share-links/s1");
    const res = await DELETE(req as never, createParams({ id: "s1" }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(404);
    expect(json.error).toBe(API_ERROR.NOT_FOUND);
  });

  it("returns 409 when already revoked", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindUnique.mockResolvedValue({
      id: "s1",
      shareType: "ENTRY_SHARE",
      createdById: DEFAULT_SESSION.user.id,
      revokedAt: new Date(),
      teamPasswordEntryId: null,
    });

    const req = createRequest("DELETE", "http://localhost/api/share-links/s1");
    const res = await DELETE(req as never, createParams({ id: "s1" }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(409);
    expect(json.error).toBe("ALREADY_REVOKED");
  });

  it("revokes successfully", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindUnique.mockResolvedValue({
      id: "s1",
      shareType: "ENTRY_SHARE",
      createdById: DEFAULT_SESSION.user.id,
      revokedAt: null,
      tenantId: "tenant-1",
      teamPasswordEntryId: null,
    });
    mockUpdate.mockResolvedValue({ count: 1 });

    const req = createRequest("DELETE", "http://localhost/api/share-links/s1");
    const res = await DELETE(req as never, createParams({ id: "s1" }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "s1", createdById: DEFAULT_SESSION.user.id, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    // The creator's own revoke carries no admin metadata.
    expect(mockLogAuditInTx.mock.calls[0][2]).not.toHaveProperty("metadata");
  });

  it("a revoke that lost the race to a concurrent one answers ALREADY_REVOKED and writes no audit", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindUnique.mockResolvedValue({
      id: "s1",
      shareType: "ENTRY_SHARE",
      createdById: DEFAULT_SESSION.user.id,
      revokedAt: null,
      tenantId: "tenant-1",
      teamPasswordEntryId: null,
    });
    mockUpdate.mockResolvedValue({ count: 0 });

    const res = await DELETE(createRequest("DELETE", "http://localhost/api/share-links/s1") as never, createParams({ id: "s1" }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(409);
    expect(json.error).toBe("ALREADY_REVOKED");
    expect(mockLogAuditInTx).not.toHaveBeenCalled();
  });

  it("logs SEND_REVOKE when revoking a TEXT send", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindUnique.mockResolvedValue({
      id: "s1",
      shareType: "TEXT",
      createdById: DEFAULT_SESSION.user.id,
      revokedAt: null,
      tenantId: "tenant-1",
      teamPasswordEntryId: null,
    });
    mockUpdate.mockResolvedValue({ count: 1 });

    const req = createRequest("DELETE", "http://localhost/api/share-links/s1");
    const res = await DELETE(req as never, createParams({ id: "s1" }));

    expect(res.status).toBe(200);
    expect(mockLogAuditInTx).toHaveBeenCalledWith(
      mockTx,
      "tenant-1",
      expect.objectContaining({
        action: "SEND_REVOKE",
      })
    );
  });

  it("uses teamId from included teamPasswordEntry relation in audit log", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindUnique.mockResolvedValue({
      id: "s1",
      shareType: "ENTRY_SHARE",
      createdById: DEFAULT_SESSION.user.id,
      revokedAt: null,
      tenantId: "tenant-1",
      teamPasswordEntryId: "tpe-1",
      teamPasswordEntry: { teamId: "team-1" },
    });
    mockUpdate.mockResolvedValue({ count: 1 });

    const req = createRequest("DELETE", "http://localhost/api/share-links/s1");
    const res = await DELETE(req as never, createParams({ id: "s1" }));

    expect(res.status).toBe(200);
    expect(mockLogAuditInTx).toHaveBeenCalledWith(
      mockTx,
      "tenant-1",
      expect.objectContaining({
        teamId: "team-1",
      }),
    );
  });

  it("logs SEND_REVOKE when revoking a FILE send", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindUnique.mockResolvedValue({
      id: "s1",
      shareType: "FILE",
      createdById: DEFAULT_SESSION.user.id,
      revokedAt: null,
      tenantId: "tenant-1",
      teamPasswordEntryId: null,
    });
    mockUpdate.mockResolvedValue({ count: 1 });

    const req = createRequest("DELETE", "http://localhost/api/share-links/s1");
    const res = await DELETE(req as never, createParams({ id: "s1" }));

    expect(res.status).toBe(200);
    expect(mockLogAuditInTx).toHaveBeenCalledWith(
      mockTx,
      "tenant-1",
      expect.objectContaining({
        action: "SEND_REVOKE",
      })
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
      mockFindUnique.mockResolvedValue(teamShare);
      mockUpdate.mockResolvedValue({ count: 1 });

      const res = await DELETE(createRequest("DELETE", "http://localhost/api/share-links/s1") as never, createParams({ id: "s1" }));

      expect(res.status).toBe(200);
      expect(mockRequireTeamPermission).toHaveBeenCalledWith(ADMIN_ID, "team-1", "password:delete", expect.anything());
      expect(mockUpdate).toHaveBeenCalledWith({
        where: { id: "s1", teamPasswordEntryId: "entry-1", revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      expect(mockLogAuditInTx.mock.calls[0][2]).toMatchObject({
        metadata: { revokedByTeamAdmin: true, creatorId: "creator-id" },
      });
    });

    it("an admin revoke that lost the race answers ALREADY_REVOKED and writes no audit", async () => {
      mockAuth.mockResolvedValue({ user: { id: ADMIN_ID } });
      mockFindUnique.mockResolvedValue(teamShare);
      mockUpdate.mockResolvedValue({ count: 0 });

      const res = await DELETE(createRequest("DELETE", "http://localhost/api/share-links/s1") as never, createParams({ id: "s1" }));

      expect(res.status).toBe(409);
      expect(mockLogAuditInTx).not.toHaveBeenCalled();
    });

    it("a team member without PASSWORD_DELETE gets 404 and nothing is written", async () => {
      mockAuth.mockResolvedValue({ user: { id: ADMIN_ID } });
      mockFindUnique.mockResolvedValue(teamShare);
      mockRequireTeamPermission.mockRejectedValueOnce(new TeamAuthError("FORBIDDEN", 403));

      const res = await DELETE(createRequest("DELETE", "http://localhost/api/share-links/s1") as never, createParams({ id: "s1" }));

      expect(res.status).toBe(404);
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });
});
