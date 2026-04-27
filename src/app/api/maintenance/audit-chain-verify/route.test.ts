import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockVerifyAdminToken,
  mockQueryRawUnsafe,
  mockRequireMaintenanceOperator,
  mockCheck,
  mockLogAudit,
  mockWithBypassRls,
} = vi.hoisted(() => ({
  mockVerifyAdminToken: vi.fn(),
  mockQueryRawUnsafe: vi.fn(),
  mockRequireMaintenanceOperator: vi.fn(),
  mockCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockLogAudit: vi.fn(),
  mockWithBypassRls: vi.fn(
    async (_prisma: unknown, fn: () => unknown, _purpose?: unknown) => fn(),
  ),
}));

vi.mock("@/lib/auth/tokens/admin-token", () => ({
  verifyAdminToken: mockVerifyAdminToken,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRawUnsafe: mockQueryRawUnsafe,
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

import { GET } from "./route";
import { OPERATOR_TOKEN_PREFIX } from "@/lib/constants/auth/operator-token";

const SUBJECT_USER_ID = "660e8400-e29b-41d4-a716-446655440001";
const TOKEN_ID = "op-token-id-1";
// tenantId as a valid UUID for Zod validation
const TENANT_ID = "550e8400-e29b-41d4-a716-446655440001";
const OTHER_TENANT_ID = "550e8400-e29b-41d4-a716-446655440002";

const VALID_OP_TOKEN = `${OPERATOR_TOKEN_PREFIX}${"a".repeat(43)}`;

const VALID_AUTH = {
  subjectUserId: SUBJECT_USER_ID,
  tenantId: TENANT_ID,
  tokenId: TOKEN_ID,
  scopes: ["maintenance"] as const,
};

function createRequest(params: Record<string, string>, token?: string): NextRequest {
  const url = new URL("http://localhost/api/maintenance/audit-chain-verify");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const headers: Record<string, string> = {
    "x-forwarded-for": "10.0.0.1",
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return new NextRequest(url, {
    method: "GET",
    headers,
  });
}

describe("GET /api/maintenance/audit-chain-verify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheck.mockResolvedValue({ allowed: true });
    mockVerifyAdminToken.mockResolvedValue({ ok: false, reason: "MISSING_OR_MALFORMED" });
    mockRequireMaintenanceOperator.mockResolvedValue({
      ok: true,
      operator: { tenantId: TENANT_ID, role: "ADMIN" },
    });
    // Default: anchor lookup returns empty (no anchors → early exit with totalVerified: 0)
    mockQueryRawUnsafe.mockResolvedValue([]);
  });

  // ─── Auth ──────────────────────────────────────────────────

  it("returns 401 without authorization header", async () => {
    const req = createRequest({ tenantId: TENANT_ID });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("returns 401 when verifyAdminToken returns INVALID", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: false, reason: "INVALID" });
    const req = createRequest({ tenantId: TENANT_ID }, VALID_OP_TOKEN);
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  // ─── Rate Limit ────────────────────────────────────────────

  it("returns 429 when rate limited", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockCheck.mockResolvedValue({ allowed: false, retryAfterMs: 30_000 });
    const req = createRequest({ tenantId: TENANT_ID }, VALID_OP_TOKEN);
    const res = await GET(req);
    expect(res.status).toBe(429);
  });

  // ─── Query Validation ────────────────────────────────────

  it("returns 400 when tenantId query param is missing", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    const req = createRequest({}, VALID_OP_TOKEN);
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  // ─── Cross-tenant check ───────────────────────────────────

  it("returns 403 when query tenantId does not match token tenantId", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    // OTHER_TENANT_ID is a valid UUID but differs from VALID_AUTH.tenantId
    const req = createRequest({ tenantId: OTHER_TENANT_ID }, VALID_OP_TOKEN);
    const res = await GET(req);
    expect(res.status).toBe(403);
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

    const req = createRequest({ tenantId: TENANT_ID }, VALID_OP_TOKEN);
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  // ─── Success (empty anchors short-circuit) ────────────────

  it("returns 200 with ok=true and totalVerified=0 when no chain anchors exist", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    // Empty anchor array triggers the early-exit path
    mockQueryRawUnsafe.mockResolvedValue([]);

    const req = createRequest({ tenantId: TENANT_ID }, VALID_OP_TOKEN);
    const res = await GET(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.totalVerified).toBe(0);
  });

  // ─── Audit ────────────────────────────────────────────────

  it("does not emit audit when anchors are empty (early exit before audit)", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockQueryRawUnsafe.mockResolvedValue([]);

    const req = createRequest({ tenantId: TENANT_ID }, VALID_OP_TOKEN);
    await GET(req);

    // The early-exit path returns before the audit log call
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});
