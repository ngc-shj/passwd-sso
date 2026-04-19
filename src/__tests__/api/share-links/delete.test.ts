import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import { createRequest, createParams, parseResponse } from "../../helpers/request-builder";

const { mockTx, mockAuth, mockFindUnique, mockUpdate, mockWithUserTenantRls, mockWithBypassRls, mockLogAuditInTx } = vi.hoisted(() => {
  const tx = {};
  return {
    mockTx: tx,
    mockAuth: vi.fn(),
    mockFindUnique: vi.fn(),
    mockUpdate: vi.fn(),
    mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
    mockWithBypassRls: vi.fn(async (_prisma: unknown, fn: (tx: unknown) => unknown) => fn(tx)),
    mockLogAuditInTx: vi.fn(),
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordShare: { findUnique: mockFindUnique, update: mockUpdate },
    teamPasswordEntry: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/audit", () => ({
  logAuditInTx: mockLogAuditInTx,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "Test" }),
  personalAuditBase: (_req: unknown, userId: string) => ({ scope: "PERSONAL", userId, ip: "127.0.0.1", userAgent: "Test" }),
  teamAuditBase: (_req: unknown, userId: string, teamId: string) => ({ scope: "TEAM", userId, teamId, ip: "127.0.0.1", userAgent: "Test" }),
  tenantAuditBase: (_req: unknown, userId: string, tenantId: string) => ({ scope: "TENANT", userId, tenantId, ip: "127.0.0.1", userAgent: "Test" }),
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));

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
    expect(json.error).toBe("NOT_FOUND");
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
    expect(json.error).toBe("NOT_FOUND");
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
    mockUpdate.mockResolvedValue({});

    const req = createRequest("DELETE", "http://localhost/api/share-links/s1");
    const res = await DELETE(req as never, createParams({ id: "s1" }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "s1" },
      data: { revokedAt: expect.any(Date) },
    });
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
    mockUpdate.mockResolvedValue({});

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
    mockUpdate.mockResolvedValue({});

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
    mockUpdate.mockResolvedValue({});

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
});
