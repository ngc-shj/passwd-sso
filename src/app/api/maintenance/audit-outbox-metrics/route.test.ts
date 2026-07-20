import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { assertRedisFailClosed, snapshotFactory } from "@/__tests__/helpers/fail-closed";

const {
  mockVerifyAdminToken,
  mockQueryRaw,
  mockRequireMaintenanceOperator,
  mockCheck,
  mockCreateRateLimiter,
  mockLogAudit,
  mockWithBypassRls,
} = vi.hoisted(() => {
  const mockCheck = vi.fn().mockResolvedValue({ allowed: true });
  return {
    mockVerifyAdminToken: vi.fn(),
    mockQueryRaw: vi.fn(),
    mockRequireMaintenanceOperator: vi.fn(),
    mockCheck,
    mockCreateRateLimiter: vi.fn(() => ({ check: mockCheck, clear: vi.fn() })),
    mockLogAudit: vi.fn(),
    mockWithBypassRls: vi.fn(
      async (prisma: unknown, fn: (tx: unknown) => unknown, _purpose?: unknown) => fn(prisma),
    ),
  };
});

vi.mock("@/lib/auth/tokens/admin-token", () => ({
  verifyAdminToken: mockVerifyAdminToken,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: mockQueryRaw,
  },
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
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));
vi.mock("@/lib/auth/access/maintenance-auth", () => ({
  requireMaintenanceOperator: mockRequireMaintenanceOperator,
}));

import { GET } from "./route";
import { OPERATOR_TOKEN_PREFIX } from "@/lib/constants/auth/operator-token";

// Module-scope snapshot: route.ts's `rateLimiter = createRateLimiter(...)` runs
// at import time above, before any beforeEach's vi.clearAllMocks() can wipe it.
const outboxMetricsLimiterFactorySnapshot = snapshotFactory(mockCreateRateLimiter);
const outboxMetricsLimiter = mockCreateRateLimiter.mock.results[0]!.value as {
  check: typeof mockCheck;
};

const SUBJECT_USER_ID = "660e8400-e29b-41d4-a716-446655440001";
const TOKEN_ID = "op-token-id-1";
const TENANT_ID = "550e8400-e29b-41d4-a716-446655440001";

const VALID_OP_TOKEN = `${OPERATOR_TOKEN_PREFIX}${"a".repeat(43)}`;

const VALID_AUTH = {
  subjectUserId: SUBJECT_USER_ID,
  tenantId: TENANT_ID,
  tokenId: TOKEN_ID,
  scopes: ["maintenance"] as const,
};

const SAMPLE_METRICS_ROW = {
  pending: BigInt(5),
  processing: BigInt(0),
  failed: BigInt(2),
  oldest_pending_age_seconds: 12.5,
  average_attempts_for_sent: 1.2,
  dead_letter_count: BigInt(1),
};

function createRequest(token?: string): NextRequest {
  const headers: Record<string, string> = {
    "x-forwarded-for": "10.0.0.1",
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return new NextRequest("http://localhost/api/maintenance/audit-outbox-metrics", {
    method: "GET",
    headers,
  });
}

describe("GET /api/maintenance/audit-outbox-metrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheck.mockResolvedValue({ allowed: true });
    mockVerifyAdminToken.mockResolvedValue({ ok: false, reason: "MISSING_OR_MALFORMED" });
    mockRequireMaintenanceOperator.mockResolvedValue({
      ok: true,
      operator: { tenantId: TENANT_ID, role: "ADMIN" },
    });
    mockQueryRaw.mockResolvedValue([SAMPLE_METRICS_ROW]);
  });

  // ─── Auth ──────────────────────────────────────────────────

  it("returns 401 without authorization header", async () => {
    const req = createRequest();
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("returns 401 when verifyAdminToken returns INVALID", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: false, reason: "INVALID" });
    const req = createRequest(VALID_OP_TOKEN);
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  // ─── Rate Limit ────────────────────────────────────────────

  it("returns 429 when rate limited", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockCheck.mockResolvedValue({ allowed: false, retryAfterMs: 30_000 });
    const req = createRequest(VALID_OP_TOKEN);
    const res = await GET(req);
    expect(res.status).toBe(429);

    // #629 headline property: the maintenance rate-limit key is tenant-scoped
    // so one tenant's operator cannot 429 another tenant's op. A regression
    // dropping `${auth.tenantId}` (global key) or swapping in subjectUserId
    // would still pass the 429/503 behavior tests — only an exact-key assertion
    // pinning the route discriminator + tenantId segment catches it. The key is
    // passed to check() before the limiter's verdict, so asserting it here
    // needs no route-specific success mocks.
    expect(mockCheck).toHaveBeenCalledWith(`rl:maintenance:outbox-metrics:${TENANT_ID}`);
  });

  it("fails closed (503, no mutation) when Redis is unavailable", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    await assertRedisFailClosed({
      invoke: () => GET(createRequest(VALID_OP_TOKEN)),
      limiter: outboxMetricsLimiter,
      expectation: { envelope: "canonical" },
      assertNoMutation: [mockQueryRaw],
      limiterFactory: outboxMetricsLimiterFactorySnapshot.replay(),
      failure: { allowed: false, redisErrored: true },
    });
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
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  // ─── Success ──────────────────────────────────────────────

  it("returns 200 with Number-converted metrics from BigInt query result", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });

    const req = createRequest(VALID_OP_TOKEN);
    const res = await GET(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.pending).toBe(5);
    expect(body.processing).toBe(0);
    expect(body.failed).toBe(2);
    expect(body.oldestPendingAgeSeconds).toBe(12.5);
    expect(body.averageAttemptsForSent).toBe(1.2);
    expect(body.deadLetterCount).toBe(1);
    expect(typeof body.asOf).toBe("string");
  });

  it("scopes the SQL aggregate to the operator-token's tenantId", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });

    const req = createRequest(VALID_OP_TOKEN);
    await GET(req);

    // Tagged template: [strings, ...values]. The only interpolated value is
    // auth.tenantId, used in the SQL WHERE clause. Without it, every tenant's
    // queue depth and failure counts leak through this endpoint.
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    const queryArgs = mockQueryRaw.mock.calls[0];
    expect(queryArgs.slice(1)).toContain(TENANT_ID);
    const sqlStrings = queryArgs[0] as string[];
    expect(sqlStrings.join("")).toMatch(/WHERE\s+tenant_id\s*=/);
  });

  it("returns zeros when query result row is empty", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockQueryRaw.mockResolvedValue([{}]);

    const req = createRequest(VALID_OP_TOKEN);
    const res = await GET(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.pending).toBe(0);
    expect(body.failed).toBe(0);
    expect(body.deadLetterCount).toBe(0);
  });

  // ─── Audit ────────────────────────────────────────────────

  it("logs audit with HUMAN actorType and token fields including pending and failed", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });

    const req = createRequest(VALID_OP_TOKEN);
    await GET(req);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "TENANT",
        action: "AUDIT_OUTBOX_METRICS_VIEW",
        userId: SUBJECT_USER_ID,
        actorType: "HUMAN",
        tenantId: TENANT_ID,
        metadata: expect.objectContaining({
          tokenSubjectUserId: SUBJECT_USER_ID,
          tokenId: TOKEN_ID,
          scopedTenantId: TENANT_ID,
          pending: 5,
          failed: 2,
        }),
      }),
    );

    // Strict shape: legacy fields must not appear
    const metadata = mockLogAudit.mock.calls[0][0].metadata;
    expect(metadata.operatorId).toBeUndefined();
    expect(metadata.authPath).toBeUndefined();
  });
});
