import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const {
  mockAuth,
  mockPrismaPasswordShare,
  mockWithUserTenantRls,
  mockLogAudit,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaPasswordShare: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
  mockLogAudit: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { passwordShare: mockPrismaPasswordShare },
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
  extractRequestMeta: vi.fn(() => ({ ip: "127.0.0.1", userAgent: "test" })),
}));
vi.mock("@/lib/logger", () => ({
  default: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/lib/with-request-log", () => ({
  withRequestLog: (fn: (...args: unknown[]) => unknown) => fn,
}));

import { DELETE } from "./route";

const SHARE_ID = "share-abc123";

const MOCK_SHARE = {
  id: SHARE_ID,
  shareType: "PASSWORD",
  createdById: "user-1",
  revokedAt: null,
  teamPasswordEntryId: null,
  teamPasswordEntry: null,
};

describe("DELETE /api/share-links/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockPrismaPasswordShare.findUnique.mockResolvedValue(MOCK_SHARE);
    mockPrismaPasswordShare.update.mockResolvedValue({ ...MOCK_SHARE, revokedAt: new Date() });
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
    expect(mockPrismaPasswordShare.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: SHARE_ID },
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      }),
    );
  });

  it("logs SHARE_REVOKE audit event for password share", async () => {
    await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/share-links/${SHARE_ID}`),
      createParams({ id: SHARE_ID }),
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
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
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "SEND_REVOKE" }),
    );
  });
});
