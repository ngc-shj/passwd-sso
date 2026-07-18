import { describe, it, expect, vi, beforeEach } from "vitest";
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
  mockLogAudit,
  mockAccessRequestFindUnique,
  mockAccessRequestUpdateMany,
  mockRequireRecentSession,
  mockRateLimiterCheck,
  mockCreateRateLimiter,
} = vi.hoisted(() => {
  const mockRateLimiterCheck = vi.fn().mockResolvedValue({ allowed: true });
  return {
    mockAuth: vi.fn(),
    mockRequireTenantPermission: vi.fn(),
    mockWithTenantRls: vi.fn(async (prisma: unknown, _tenantId: unknown, fn: (tx: unknown) => unknown) => fn(prisma)),
    mockLogAudit: vi.fn(),
    mockAccessRequestFindUnique: vi.fn(),
    mockAccessRequestUpdateMany: vi.fn(),
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
    },
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: mockWithTenantRls,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "test", acceptLanguage: null }),
  tenantAuditBase: vi.fn((_, userId, tenantId) => ({ scope: "TENANT", userId, tenantId })),
}));
vi.mock("@/lib/http/with-request-log", () => ({
  withRequestLog: (handler: (...args: unknown[]) => unknown) => handler,
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

import { POST } from "@/app/api/tenant/access-requests/[id]/deny/route";
import { TenantAuthError } from "@/lib/auth/access/tenant-auth";
import { assertRedisFailClosed, snapshotFactory } from "@/__tests__/helpers/fail-closed";

// The route constructs its rate limiter once at module load
// (`const denyLimiter = createRateLimiter({...})`). `beforeEach` clears all
// mocks each test, wiping `mockCreateRateLimiter.mock.calls`/`.mock.results`
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
  ...overrides,
});

describe("POST /api/tenant/access-requests/[id]/deny", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
    mockRequireRecentSession.mockResolvedValue(null);
  });

  it("denies pending request and returns success", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAccessRequestFindUnique.mockResolvedValue(makeAccessRequest());
    mockAccessRequestUpdateMany.mockResolvedValue({ count: 1 });

    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}/deny`,
    );
    const res = await POST(req, createParams({ id: REQUEST_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    // transition() internally adds status: { in: ["PENDING"] } to the WHERE clause
    expect(mockAccessRequestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: REQUEST_ID, status: { in: ["PENDING"] } }),
        data: expect.objectContaining({ status: "DENIED" }),
      }),
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ACCESS_REQUEST_DENY",
        tenantId: "tenant-1",
      }),
    );
  });

  it("sets approvedById and approvedAt on deny", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAccessRequestFindUnique.mockResolvedValue(makeAccessRequest());
    mockAccessRequestUpdateMany.mockResolvedValue({ count: 1 });

    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}/deny`,
    );
    await POST(req, createParams({ id: REQUEST_ID }));

    expect(mockAccessRequestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "DENIED",
          approvedById: DEFAULT_SESSION.user.id,
          approvedAt: expect.any(Date),
        }),
      }),
    );
  });

  it("returns 409 when request is already processed (optimistic lock)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAccessRequestFindUnique.mockResolvedValue(makeAccessRequest());
    mockAccessRequestUpdateMany.mockResolvedValue({ count: 0 }); // already processed

    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}/deny`,
    );
    const res = await POST(req, createParams({ id: REQUEST_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(409);
    expect(json.error).toBe("CONFLICT");
  });

  it("returns 404 when access request does not exist", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAccessRequestFindUnique.mockResolvedValue(null);

    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}/deny`,
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
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}/deny`,
    );
    const res = await POST(req, createParams({ id: REQUEST_ID }));
    const { status } = await parseResponse(res);

    expect(status).toBe(404);
  });

  it("returns 401 for unauthenticated users", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}/deny`,
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
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}/deny`,
    );
    const res = await POST(req, createParams({ id: REQUEST_ID }));
    const { status } = await parseResponse(res);

    expect(status).toBe(403);
  });

  it("requires recent re-auth (403 without step-up)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockRequireRecentSession.mockResolvedValueOnce(
      Response.json({ error: "SESSION_STEP_UP_REQUIRED" }, { status: 403 }),
    );

    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}/deny`,
    );
    const res = await POST(req, createParams({ id: REQUEST_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(403);
    expect(json.error).toBe("SESSION_STEP_UP_REQUIRED");
    expect(mockAccessRequestFindUnique).not.toHaveBeenCalled();
  });

  it("deny succeeds when step-up satisfied", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAccessRequestFindUnique.mockResolvedValue(makeAccessRequest());
    mockAccessRequestUpdateMany.mockResolvedValue({ count: 1 });

    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}/deny`,
    );
    const res = await POST(req, createParams({ id: REQUEST_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockRequireRecentSession).toHaveBeenCalledOnce();
  });

  it("fails closed (503, no mutation) when Redis is unavailable", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);

    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}/deny`,
    );

    // Mutation spy: this file does not mock `transition` as a service (it
    // runs real code); the write primitive transition() invokes is
    // tx.accessRequest.updateMany, mocked here as mockAccessRequestUpdateMany.
    await assertRedisFailClosed({
      invoke: () => POST(req, createParams({ id: REQUEST_ID })),
      limiter: rateLimiterInstance,
      expectation: { envelope: "canonical" },
      assertNoMutation: [mockAccessRequestUpdateMany],
      limiterFactory: rateLimiterFactorySnapshot.replay(),
      failure: { allowed: false, redisErrored: true },
    });
  });
});
