import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";

const V1_KEY = randomBytes(32).toString("hex");
const V2_KEY = randomBytes(32).toString("hex");
const VALID_OP_TOKEN = `op_${"a".repeat(43)}`;

const {
  mockVerifyAdminToken,
  mockShareUpdateMany,
  mockRequireMaintenanceOperator,
  mockCheck,
  mockLogAudit,
  mockWithBypassRls,
  mockGetCurrentMasterKeyVersion,
  mockGetMasterKeyByVersion,
} = vi.hoisted(() => ({
  mockVerifyAdminToken: vi.fn(),
  mockShareUpdateMany: vi.fn(),
  mockRequireMaintenanceOperator: vi.fn(),
  mockCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockLogAudit: vi.fn(),
  mockWithBypassRls: vi.fn(async (_prisma: unknown, fn: () => unknown) => fn()),
  mockGetCurrentMasterKeyVersion: vi.fn(),
  mockGetMasterKeyByVersion: vi.fn(),
}));

vi.mock("@/lib/auth/tokens/admin-token", () => ({
  verifyAdminToken: mockVerifyAdminToken,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordShare: { updateMany: mockShareUpdateMany },
  },
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockCheck, clear: vi.fn() }),
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  tenantAuditBase: (_req: unknown, userId: string, tenantId: string) => ({
    scope: "TENANT",
    userId,
    tenantId,
    ip: "10.0.0.1",
    userAgent: "Test",
    acceptLanguage: null,
  }),
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));
vi.mock("@/lib/auth/access/maintenance-auth", () => ({
  requireMaintenanceOperator: mockRequireMaintenanceOperator,
}));
vi.mock("@/lib/crypto/crypto-server", () => ({
  getCurrentMasterKeyVersion: mockGetCurrentMasterKeyVersion,
  getMasterKeyByVersion: mockGetMasterKeyByVersion,
}));

import { POST } from "./route";

const SUBJECT_USER_ID = "660e8400-e29b-41d4-a716-446655440001";
const TOKEN_ID = "op-token-id-1";
const TENANT_ID = "tenant-1";

const VALID_AUTH = {
  subjectUserId: SUBJECT_USER_ID,
  tenantId: TENANT_ID,
  tokenId: TOKEN_ID,
  scopes: ["maintenance"] as const,
};

function createRequest(body: unknown, token?: string): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": "10.0.0.1",
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return new NextRequest("http://localhost/api/admin/rotate-master-key", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/admin/rotate-master-key", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheck.mockResolvedValue({ allowed: true });
    mockVerifyAdminToken.mockResolvedValue({ ok: false, reason: "MISSING_OR_MALFORMED" });
    mockRequireMaintenanceOperator.mockResolvedValue({
      ok: true,
      operator: { tenantId: TENANT_ID, role: "ADMIN" },
    });
    mockGetCurrentMasterKeyVersion.mockReturnValue(2);
    mockGetMasterKeyByVersion.mockReturnValue(V2_KEY);
  });

  // ─── Auth ──────────────────────────────────────────────────

  it("returns 401 without authorization header", async () => {
    const req = createRequest({ targetVersion: 2 });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 401 when verifyAdminToken returns INVALID", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: false, reason: "INVALID" });
    const req = createRequest({ targetVersion: 2 }, VALID_OP_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  // ─── Rate Limit ────────────────────────────────────────────

  it("returns 429 when rate limited", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockCheck.mockResolvedValue({ allowed: false, retryAfterMs: 30_000 });
    const req = createRequest({ targetVersion: 2 }, VALID_OP_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(429);
  });

  it("checks rate limit after auth (401 before 429 for unauthenticated requests)", async () => {
    mockCheck.mockResolvedValue({ allowed: false, retryAfterMs: 30_000 });

    const unauthReq = createRequest({ targetVersion: 2 });
    const unauthRes = await POST(unauthReq);
    expect(unauthRes.status).toBe(401);

    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    const authReq = createRequest({ targetVersion: 2 }, VALID_OP_TOKEN);
    const authRes = await POST(authReq);
    expect(authRes.status).toBe(429);
  });

  // ─── Body Validation ──────────────────────────────────────

  it("returns 400 for invalid body (non-integer targetVersion)", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    const req = createRequest({ targetVersion: "abc" }, VALID_OP_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 when targetVersion does not match current master key version", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockGetCurrentMasterKeyVersion.mockReturnValue(2);
    const req = createRequest({ targetVersion: 3 }, VALID_OP_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("does not match");
  });

  it("returns 400 when targetVersion key is not configured", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockGetCurrentMasterKeyVersion.mockReturnValue(2);
    mockGetMasterKeyByVersion.mockImplementation(() => {
      throw new Error("Key not found");
    });
    const req = createRequest({ targetVersion: 2 }, VALID_OP_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("not configured");
  });

  // ─── Operator Membership Check ────────────────────────────

  it("returns 400 when operator is not an active admin", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockRequireMaintenanceOperator.mockResolvedValue({
      ok: false,
      response: new Response(
        JSON.stringify({ error: "operatorId is not an active tenant admin" }),
        { status: 400 },
      ),
    });

    const req = createRequest({ targetVersion: 2 }, VALID_OP_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("active tenant admin");
  });

  // ─── Success ──────────────────────────────────────────────

  it("returns 200 with targetVersion and revokedShares=0 when no shares to revoke", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });

    const req = createRequest({ targetVersion: 2 }, VALID_OP_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.targetVersion).toBe(2);
    expect(body.revokedShares).toBe(0);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "TENANT",
        tenantId: TENANT_ID,
        action: "MASTER_KEY_ROTATION",
        userId: SUBJECT_USER_ID,
        actorType: "HUMAN",
        metadata: expect.objectContaining({
          tokenSubjectUserId: SUBJECT_USER_ID,
          tokenId: TOKEN_ID,
          targetVersion: 2,
          revokedShares: 0,
        }),
      }),
    );

    // Strict shape: legacy fields must not appear
    const metadata = mockLogAudit.mock.calls[0][0].metadata;
    expect(metadata.operatorId).toBeUndefined();
    expect(metadata.authPath).toBeUndefined();
  });

  it("revokes old shares when revokeShares is true", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockShareUpdateMany.mockResolvedValue({ count: 3 });

    const req = createRequest({ targetVersion: 2, revokeShares: true }, VALID_OP_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.revokedShares).toBe(3);

    expect(mockShareUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          masterKeyVersion: { lt: 2 },
          revokedAt: null,
        }),
      }),
    );
  });

  it("does not call shareUpdateMany when revokeShares is false", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });

    const req = createRequest({ targetVersion: 2, revokeShares: false }, VALID_OP_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(200);

    expect(mockShareUpdateMany).not.toHaveBeenCalled();
  });
});
