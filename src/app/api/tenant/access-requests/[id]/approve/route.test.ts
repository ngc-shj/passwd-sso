import { describe, it, expect, vi, beforeEach } from "vitest";
import { MAX_SA_TOKENS_PER_ACCOUNT } from "@/lib/constants/auth/service-account";
import { DEFAULT_SESSION } from "../../../../../../__tests__/helpers/mock-auth";
import {
  createRequest,
  parseResponse,
  createParams,
} from "../../../../../../__tests__/helpers/request-builder";

const {
  mockAuth,
  mockRequireTenantPermission,
  mockWithTenantRls,
  mockWithBypassRls,
  mockLogAudit,
  mockAccessRequestFindUnique,
  mockAccessRequestUpdateMany,
  mockAccessRequestUpdate,
  mockTenantFindUnique,
  mockSaTokenCount,
  mockSaTokenCreate,
  mockSaExecuteRaw,
  mockHashToken,
  mockRequireRecentSession,
  mockRateLimiterCheck,
  mockCreateRateLimiter,
} = vi.hoisted(() => {
  const mockRateLimiterCheck = vi.fn().mockResolvedValue({ allowed: true });
  return {
    mockAuth: vi.fn(),
    mockRequireTenantPermission: vi.fn(),
    // withTenantRls IS the transaction boundary in production: it opens the tx
    // and passes it to fn. The mock passes the prisma mock as the tx so both the
    // read path (accessRequest.findUnique) and the write path
    // (serviceAccountToken.{count,create} + accessRequest.{updateMany,update})
    // resolve to the configured mocks — no separate $transaction indirection.
    mockWithTenantRls: vi.fn(async (prisma: unknown, _tenantId: unknown, fn: (tx: unknown) => unknown) => fn(prisma)),
    mockWithBypassRls: vi.fn(async (prisma: unknown, fn: (tx: unknown) => unknown) => fn(prisma)),
    mockLogAudit: vi.fn(),
    mockAccessRequestFindUnique: vi.fn(),
    mockAccessRequestUpdateMany: vi.fn(),
    mockAccessRequestUpdate: vi.fn(),
    mockTenantFindUnique: vi.fn(),
    mockSaTokenCount: vi.fn(),
    mockSaTokenCreate: vi.fn(),
    mockSaExecuteRaw: vi.fn().mockResolvedValue(0),
    mockHashToken: vi.fn().mockReturnValue("hashed-token"),
    mockRequireRecentSession: vi.fn().mockResolvedValue(null),
    mockRateLimiterCheck,
    // T4: recording factory so tests can attribute the limiter instance
    // back to the failClosedOnRedisError option it was constructed with.
    mockCreateRateLimiter: vi.fn(() => ({ check: mockRateLimiterCheck, clear: vi.fn() })),
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/auth/access/tenant-auth", () => {
  class TenantAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "TenantAuthError";
      this.status = status;
    }
  }
  return {
    requireTenantPermission: mockRequireTenantPermission,
    TenantAuthError,
  };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    accessRequest: {
      findUnique: mockAccessRequestFindUnique,
      updateMany: mockAccessRequestUpdateMany,
      update: mockAccessRequestUpdate,
    },
    tenant: {
      findUnique: mockTenantFindUnique,
    },
    serviceAccountToken: {
      count: mockSaTokenCount,
      create: mockSaTokenCreate,
    },
    // Advisory lock used to serialize concurrent SA token issuance.
    $executeRaw: mockSaExecuteRaw,
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: mockWithTenantRls,
  withBypassRls: mockWithBypassRls,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "test", acceptLanguage: null }),
  tenantAuditBase: vi.fn((_, userId, tenantId) => ({ scope: "TENANT", userId, tenantId })),
}));
vi.mock("@/lib/http/with-request-log", () => ({
  withRequestLog: (handler: (...args: unknown[]) => unknown) => handler,
}));
vi.mock("@/lib/crypto/crypto-server", () => ({
  hashToken: mockHashToken,
}));
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: mockRequireRecentSession,
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: mockCreateRateLimiter,
}));
// T1 (fail-closed-tranche1): the rate-limit-audit stub is REMOVED — production
// checkRateLimitOrFail now runs in the tested path (limiter-layer mock only,
// via mockCreateRateLimiter above). Existing cases arrange
// mockRateLimiterCheck to resolve { allowed: true } in beforeEach so they are
// unaffected by the real fail-closed mapping.

import { POST } from "@/app/api/tenant/access-requests/[id]/approve/route";
import { TenantAuthError } from "@/lib/auth/access/tenant-auth";
import { assertRedisFailClosed, snapshotFactory } from "@/__tests__/helpers/fail-closed";

// The route constructs its rate limiter once at module load
// (`const approveLimiter = createRateLimiter({...})`). `beforeEach` clears
// all mocks each test, wiping `mockCreateRateLimiter.mock.calls`/`.mock.results`
// — snapshotFactory captures the real construction call/result here (module
// scope, before any beforeEach runs) so `.replay()` can rebuild it after
// each clear for the fail-closed helper's identity-based attribution.
const rateLimiterFactorySnapshot = snapshotFactory(mockCreateRateLimiter);
const rateLimiterInstance = mockCreateRateLimiter.mock.results[0]?.value as
  | { check: typeof mockRateLimiterCheck }
  | undefined;
if (!rateLimiterInstance) {
  throw new Error(
    "route.test.ts: expected createRateLimiter to have been called once at module load",
  );
}

const ACTOR = { tenantId: "tenant-1", role: "ADMIN" };
const REQUEST_ID = "req-00000001";
const SA_ID = "00000000-0000-4000-a000-000000000001";

const makeAccessRequest = (overrides: Record<string, unknown> = {}) => ({
  id: REQUEST_ID,
  tenantId: "tenant-1",
  serviceAccountId: SA_ID,
  requestedScope: "passwords:read",
  status: "PENDING",
  // C1: approve handler now enforces expiresAt. Default fixtures use a
  // future deadline so non-expiry scenarios still succeed; expiry tests
  // override with a past Date explicitly.
  expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  serviceAccount: { isActive: true },
  ...overrides,
});

const makeTransactionSuccess = () => {
  const expiresAt = new Date(Date.now() + 3600 * 1000);
  mockSaTokenCount.mockResolvedValue(0);
  mockSaTokenCreate.mockResolvedValue({
    id: "tok-1",
    serviceAccountId: SA_ID,
    tenantId: "tenant-1",
    tokenHash: "hashed-token",
    prefix: "sa_abcd",
    name: `JIT-${REQUEST_ID.slice(0, 8)}`,
    scope: "passwords:read",
    expiresAt,
  });
  mockAccessRequestUpdateMany.mockResolvedValue({ count: 1 });
  mockAccessRequestUpdate.mockResolvedValue({});
  return expiresAt;
};

describe("POST /api/tenant/access-requests/[id]/approve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
    mockRequireRecentSession.mockResolvedValue(null);
    mockSaExecuteRaw.mockResolvedValue(0);
  });

  it("acquires the per-SA advisory lock before the limit count (serializes issuance)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAccessRequestFindUnique.mockResolvedValue(makeAccessRequest());
    mockTenantFindUnique.mockResolvedValue(null);
    makeTransactionSuccess();

    const order: string[] = [];
    mockSaExecuteRaw.mockImplementation(() => {
      order.push("lock");
      return Promise.resolve(0);
    });
    mockSaTokenCount.mockImplementation(() => {
      order.push("count");
      return Promise.resolve(0);
    });

    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}/approve`,
    );
    await POST(req, createParams({ id: REQUEST_ID }));

    // The advisory lock MUST be taken before the count→create window so a
    // concurrent approve / direct-create for the same SA cannot over-issue.
    expect(mockSaExecuteRaw).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["lock", "count"]);
  });

  it("gates the approval transition on expiresAt atomically (closes TOCTOU window)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAccessRequestFindUnique.mockResolvedValue(makeAccessRequest());
    mockTenantFindUnique.mockResolvedValue(null);

    let capturedWhere: Record<string, unknown> | undefined;
    mockSaTokenCount.mockResolvedValue(0);
    mockSaTokenCreate.mockResolvedValue({ id: "tok-1" });
    mockAccessRequestUpdateMany.mockImplementation((args: { where: Record<string, unknown> }) => {
      capturedWhere = args.where;
      return { count: 1 };
    });
    mockAccessRequestUpdate.mockResolvedValue({});

    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}/approve`,
    );
    const res = await POST(req, createParams({ id: REQUEST_ID }));
    expect((await parseResponse(res)).status).toBe(200);
    // The status transition must carry an expiresAt > now predicate so a request
    // that expires between the pre-transaction check and the write is excluded.
    expect(capturedWhere).toMatchObject({ expiresAt: { gt: expect.any(Date) } });
  });

  it("approves pending request and returns JIT token", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAccessRequestFindUnique.mockResolvedValue(makeAccessRequest());
    mockTenantFindUnique.mockResolvedValue(null); // use defaults
    makeTransactionSuccess();

    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}/approve`,
    );
    const res = await POST(req, createParams({ id: REQUEST_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(typeof json.token).toBe("string");
    expect(json.token).toMatch(/^sa_/);
    expect(json.ttlSec).toBeGreaterThan(0);
    expect(json.expiresAt).toBeDefined();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ACCESS_REQUEST_APPROVE",
        tenantId: "tenant-1",
      }),
    );
  });

  it("counts only non-revoked AND non-expired tokens toward the limit", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAccessRequestFindUnique.mockResolvedValue(makeAccessRequest());
    mockTenantFindUnique.mockResolvedValue(null);

    mockSaTokenCount.mockResolvedValue(0);
    mockSaTokenCreate.mockResolvedValue({ id: "tok-1", expiresAt: new Date(Date.now() + 3600 * 1000) });
    mockAccessRequestUpdateMany.mockResolvedValue({ count: 1 });
    mockAccessRequestUpdate.mockResolvedValue({});

    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}/approve`,
    );
    await POST(req, createParams({ id: REQUEST_ID }));

    // Expired-but-not-revoked tokens are unusable and must not consume a slot.
    const where = mockSaTokenCount.mock.calls[0][0].where;
    expect(where.revokedAt).toBeNull();
    expect(where.expiresAt).toEqual({ gt: expect.any(Date) });
  });

  it("returns 409 when request is already processed (double-approval)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAccessRequestFindUnique.mockResolvedValue(makeAccessRequest());
    mockTenantFindUnique.mockResolvedValue(null);

    // Simulate the status transition not firing (0 rows) → already processed.
    mockSaTokenCount.mockResolvedValue(0);
    mockAccessRequestUpdateMany.mockResolvedValue({ count: 0 }); // 0 = already processed

    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}/approve`,
    );
    const res = await POST(req, createParams({ id: REQUEST_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(409);
    expect(json.error).toBe("CONFLICT");
  });

  it("returns 409 when token limit exceeded", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAccessRequestFindUnique.mockResolvedValue(makeAccessRequest());
    mockTenantFindUnique.mockResolvedValue(null);

    // Token count at the limit → the route throws before the status transition.
    mockSaTokenCount.mockResolvedValue(MAX_SA_TOKENS_PER_ACCOUNT);

    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}/approve`,
    );
    const res = await POST(req, createParams({ id: REQUEST_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(409);
    expect(json.error).toBe("SA_TOKEN_LIMIT_EXCEEDED");
  });

  it("returns 404 when request not found or wrong tenant", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAccessRequestFindUnique.mockResolvedValue(null);

    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}/approve`,
    );
    const res = await POST(req, createParams({ id: REQUEST_ID }));
    const { status } = await parseResponse(res);

    expect(status).toBe(404);
  });

  it("returns 404 when request belongs to a different tenant", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAccessRequestFindUnique.mockResolvedValue(
      makeAccessRequest({ tenantId: "other-tenant" }),
    );

    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}/approve`,
    );
    const res = await POST(req, createParams({ id: REQUEST_ID }));
    const { status } = await parseResponse(res);

    expect(status).toBe(404);
  });

  it("returns 401 for unauthenticated users", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}/approve`,
    );
    const res = await POST(req, createParams({ id: REQUEST_ID }));
    const { status } = await parseResponse(res);

    expect(status).toBe(401);
  });

  it("returns 403 for insufficient permission", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockRejectedValue(new TenantAuthError("FORBIDDEN", 403));

    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}/approve`,
    );
    const res = await POST(req, createParams({ id: REQUEST_ID }));
    const { status } = await parseResponse(res);

    expect(status).toBe(403);
  });

  it("returns 403 when session step-up is required", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockRequireRecentSession.mockResolvedValueOnce(
      Response.json({ error: "SESSION_STEP_UP_REQUIRED" }, { status: 403 }),
    );

    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}/approve`,
    );
    const res = await POST(req, createParams({ id: REQUEST_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(403);
    expect(json.error).toBe("SESSION_STEP_UP_REQUIRED");
    // The token-issuing write path MUST NOT have started.
    expect(mockSaTokenCount).not.toHaveBeenCalled();
    expect(mockSaTokenCreate).not.toHaveBeenCalled();
  });

  it("returns 409 when service account is inactive", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAccessRequestFindUnique.mockResolvedValue(
      makeAccessRequest({ serviceAccount: { isActive: false } }),
    );

    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}/approve`,
    );
    const res = await POST(req, createParams({ id: REQUEST_ID }));
    const { status } = await parseResponse(res);

    expect(status).toBe(409);
  });

  it("returns 400 when no valid scopes remain after re-validation", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAccessRequestFindUnique.mockResolvedValue(
      makeAccessRequest({ requestedScope: "nonexistent:scope" }),
    );
    mockTenantFindUnique.mockResolvedValue(null);

    // updateMany succeeds (count 1) but parseSaTokenScopes("nonexistent:scope") returns []
    mockSaTokenCount.mockResolvedValue(0);
    mockAccessRequestUpdateMany.mockResolvedValue({ count: 1 });

    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}/approve`,
    );
    const res = await POST(req, createParams({ id: REQUEST_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("SA_INVALID_SCOPE");
  });

  // C1 regression: state-machine transition() gates only on status=PENDING,
  // not on the request's own expiresAt deadline. An admin must not be able to
  // resurrect a stale PENDING request and issue a fresh short-lived token.
  it("returns 410 SA_ACCESS_REQUEST_EXPIRED for a PENDING request past expiresAt", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAccessRequestFindUnique.mockResolvedValue(
      makeAccessRequest({ expiresAt: new Date(Date.now() - 60_000) }),
    );

    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}/approve`,
    );
    const res = await POST(req, createParams({ id: REQUEST_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(410);
    expect(json.error).toBe("SA_ACCESS_REQUEST_EXPIRED");
    // The write path that would issue the JIT token MUST NOT have started.
    expect(mockSaTokenCount).not.toHaveBeenCalled();
    expect(mockSaTokenCreate).not.toHaveBeenCalled();
  });

  it("fails closed (503, no mutation) when Redis is unavailable", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);

    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}/approve`,
    );

    await assertRedisFailClosed({
      invoke: () => POST(req, createParams({ id: REQUEST_ID })),
      limiter: rateLimiterInstance,
      expectation: { envelope: "canonical" },
      assertNoMutation: [mockSaTokenCreate, mockAccessRequestUpdate],
      limiterFactory: rateLimiterFactorySnapshot.replay(),
      failure: { allowed: false, redisErrored: true },
    });
  });
});
