import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { assertRedisFailClosed, snapshotFactory } from "@/__tests__/helpers/fail-closed";

const {
  mockVerifyAdminToken,
  mockRequireMaintenanceOperator,
  mockCheck,
  mockCreateRateLimiter,
  mockLogAudit,
} = vi.hoisted(() => {
  const mockCheck = vi.fn().mockResolvedValue({ allowed: true });
  return {
    mockVerifyAdminToken: vi.fn(),
    mockRequireMaintenanceOperator: vi.fn(),
    mockCheck,
    mockCreateRateLimiter: vi.fn(() => ({ check: mockCheck, clear: vi.fn() })),
    mockLogAudit: vi.fn(),
  };
});

vi.mock("@/lib/auth/tokens/admin-token", () => ({
  verifyAdminToken: mockVerifyAdminToken,
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: mockCreateRateLimiter,
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
vi.mock("@/lib/auth/access/maintenance-auth", () => ({
  requireMaintenanceOperator: mockRequireMaintenanceOperator,
}));

import { POST } from "./route";
import { AUDIT_ACTION } from "@/lib/constants/audit/audit";
import { OPERATOR_TOKEN_PREFIX } from "@/lib/constants/auth/operator-token";

// Module-scope snapshot: route.ts's `rateLimiter = createRateLimiter(...)` runs
// at import time above, before any beforeEach's vi.clearAllMocks() can wipe it.
const dcrCleanupLimiterFactorySnapshot = snapshotFactory(mockCreateRateLimiter);
const dcrCleanupLimiter = mockCreateRateLimiter.mock.results[0]!.value as {
  check: typeof mockCheck;
};

const SUBJECT_USER_ID = "660e8400-e29b-41d4-a716-446655440001";
const TOKEN_ID = "op-token-id-1";
const TENANT_ID = "tenant-1";

const VALID_OP_TOKEN = `${OPERATOR_TOKEN_PREFIX}${"a".repeat(43)}`;

const VALID_AUTH = {
  subjectUserId: SUBJECT_USER_ID,
  tenantId: TENANT_ID,
  tokenId: TOKEN_ID,
  scopes: ["maintenance"] as const,
};

function createRequest(token?: string): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": "10.0.0.1",
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return new NextRequest("http://localhost/api/maintenance/dcr-cleanup", {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  });
}

describe("POST /api/maintenance/dcr-cleanup (410 deprecation stub)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheck.mockResolvedValue({ allowed: true });
    mockVerifyAdminToken.mockResolvedValue({ ok: false, reason: "MISSING_OR_MALFORMED" });
    mockRequireMaintenanceOperator.mockResolvedValue({
      ok: true,
      operator: { tenantId: TENANT_ID, role: "ADMIN" },
    });
  });

  // ─── Auth ──────────────────────────────────────────────────

  it("returns 401 without authorization header", async () => {
    const req = createRequest();
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 401 when verifyAdminToken returns INVALID", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: false, reason: "INVALID" });
    const req = createRequest(VALID_OP_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  // ─── Rate Limit ────────────────────────────────────────────

  it("returns 429 when rate limited", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockCheck.mockResolvedValue({ allowed: false, retryAfterMs: 30_000 });
    const req = createRequest(VALID_OP_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(429);

    // #629 headline property: the maintenance rate-limit key is tenant-scoped
    // so one tenant's operator cannot 429 another tenant's op. A regression
    // dropping `${auth.tenantId}` (global key) or swapping in subjectUserId
    // would still pass the 429/503 behavior tests — only an exact-key assertion
    // pinning the route discriminator + tenantId segment catches it. The key is
    // passed to check() before the limiter's verdict, so asserting it here
    // needs no route-specific success mocks.
    expect(mockCheck).toHaveBeenCalledWith(`rl:maintenance:dcr-cleanup:${TENANT_ID}`);
  });

  it("fails closed (503, no mutation) when Redis is unavailable", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    await assertRedisFailClosed({
      invoke: () => POST(createRequest(VALID_OP_TOKEN)),
      limiter: dcrCleanupLimiter,
      expectation: { envelope: "canonical" },
      // No DB write exists on this 410 stub route; requireMaintenanceOperator
      // is the first effect AFTER the limiter, so its non-invocation proves
      // the 503 short-circuited before any downstream work (including audit).
      assertNoMutation: [mockRequireMaintenanceOperator],
      limiterFactory: dcrCleanupLimiterFactorySnapshot.replay(),
      failure: { allowed: false, redisErrored: true },
    });
  });

  it("checks rate limit after auth (401 before 429 for unauthenticated requests)", async () => {
    mockCheck.mockResolvedValue({ allowed: false, retryAfterMs: 30_000 });

    const unauthReq = createRequest();
    const unauthRes = await POST(unauthReq);
    expect(unauthRes.status).toBe(401);

    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    const authReq = createRequest(VALID_OP_TOKEN);
    const authRes = await POST(authReq);
    expect(authRes.status).toBe(429);
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

    const req = createRequest(VALID_OP_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  // ─── 410 Gone ────────────────────────────────────────────

  it("returns 410 with deprecation body for authenticated admin callers", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });

    const req = createRequest(VALID_OP_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(410);

    const body = await res.json();
    expect(body).toEqual({
      error: "endpoint_removed",
      replacement: "worker:retention-gc",
    });
  });

  // ─── Audit ────────────────────────────────────────────────

  it("emits MCP_CLIENT_DCR_CLEANUP_DEPRECATED_CALL audit with strict shape", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });

    const req = createRequest(VALID_OP_TOKEN);
    await POST(req);

    expect(mockLogAudit).toHaveBeenCalledOnce();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "TENANT",
        action: AUDIT_ACTION.MCP_CLIENT_DCR_CLEANUP_DEPRECATED_CALL,
        userId: SUBJECT_USER_ID,
        actorType: "HUMAN",
        tenantId: TENANT_ID,
        metadata: expect.objectContaining({
          tokenSubjectUserId: SUBJECT_USER_ID,
          tokenId: TOKEN_ID,
          deprecated: true,
          replacement: "worker:retention-gc",
        }),
      }),
    );

    // Strict negative shape: legacy worker-emit fields must not appear
    const metadata = mockLogAudit.mock.calls[0][0].metadata;
    expect(metadata.purgedCount).toBeUndefined();
    expect(metadata.triggeredBy).toBeUndefined();
    expect(metadata.sweepIntervalMs).toBeUndefined();
    expect(metadata.systemWide).toBeUndefined();
  });
});
