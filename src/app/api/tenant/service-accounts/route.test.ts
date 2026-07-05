import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../../../__tests__/helpers/mock-auth";
import { createRequest, parseResponse } from "../../../../__tests__/helpers/request-builder";

const {
  mockAuth,
  mockRequireTenantPermission,
  mockWithTenantRls,
  mockLogAudit,
  mockRateLimiterCheck,
  mockServiceAccountFindMany,
  mockServiceAccountCount,
  mockServiceAccountCreate,
  mockExecuteRaw,
  mockDispatchTenantWebhook,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTenantPermission: vi.fn(),
  mockWithTenantRls: vi.fn(async (prisma: unknown, _tenantId: unknown, fn: (tx: unknown) => unknown) => fn(prisma)),
  mockLogAudit: vi.fn(),
  mockRateLimiterCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockServiceAccountFindMany: vi.fn(),
  mockServiceAccountCount: vi.fn(),
  mockServiceAccountCreate: vi.fn(),
  mockExecuteRaw: vi.fn().mockResolvedValue(1),
  mockDispatchTenantWebhook: vi.fn(),
}));

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
    serviceAccount: {
      findMany: mockServiceAccountFindMany,
      count: mockServiceAccountCount,
      create: mockServiceAccountCreate,
    },
    // The cap-check + create now run under an advisory lock inside one
    // withTenantRls tx (TOCTOU fix); the route calls tx.$executeRaw for the
    // lock before count/create. The withTenantRls mock passes prisma as tx.
    $executeRaw: mockExecuteRaw,
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
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateLimiterCheck }),
}));
// Keep the real checkRateLimitOrFail (so it maps redisErrored → 503) but
// stub the audit emit to a no-op to avoid pulling its transitive deps.
vi.mock("@/lib/security/rate-limit-audit", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  emitRateLimitFailClosed: vi.fn(),
}));
vi.mock("@/lib/http/with-request-log", () => ({
  withRequestLog: (handler: (...args: unknown[]) => unknown) => handler,
}));
vi.mock("@/lib/webhook-dispatcher", () => ({
  dispatchTenantWebhook: mockDispatchTenantWebhook,
}));

import { GET, POST } from "@/app/api/tenant/service-accounts/route";
import { TenantAuthError } from "@/lib/auth/access/tenant-auth";
import { MAX_SERVICE_ACCOUNTS_PER_TENANT } from "@/lib/constants/auth/service-account";

const ACTOR = { tenantId: "tenant-1", role: "ADMIN" };

// Asserts the per-tenant advisory lock ($executeRaw with pg_advisory_xact_lock)
// was acquired. Mutation-kill: deleting the lock line from the production
// count-then-create path leaves $executeRaw uncalled with that SQL, so this fails.
function expectAdvisoryLockAcquired(mock: ReturnType<typeof vi.fn>) {
  expect(
    mock.mock.calls.some((c) => String(c[0]).includes("pg_advisory_xact_lock")),
  ).toBe(true);
}

const makeSA = (overrides: Record<string, unknown> = {}) => ({
  id: "sa-1",
  name: "ci-bot",
  description: "CI pipeline bot",
  identityType: "SERVICE_ACCOUNT",
  isActive: true,
  teamId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  createdBy: { id: DEFAULT_SESSION.user.id, name: "Test User", email: "user@example.com" },
  _count: { tokens: 0 },
  ...overrides,
});

describe("GET /api/tenant/service-accounts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns list of service accounts for tenant", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockServiceAccountFindMany.mockResolvedValue([makeSA()]);

    const req = createRequest("GET", "http://localhost/api/tenant/service-accounts");
    const res = await GET(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(Array.isArray(json)).toBe(true);
    expect(json).toHaveLength(1);
    expect(json[0].id).toBe("sa-1");
    expect(json[0].name).toBe("ci-bot");
  });

  it("returns 401 for unauthenticated users", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("GET", "http://localhost/api/tenant/service-accounts");
    const res = await GET(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(401);
  });

  it("returns 403 for insufficient permission", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockRejectedValue(new TenantAuthError("FORBIDDEN", 403));

    const req = createRequest("GET", "http://localhost/api/tenant/service-accounts");
    const res = await GET(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(403);
  });
});

describe("POST /api/tenant/service-accounts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a service account successfully", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockServiceAccountCount.mockResolvedValue(0);
    const created = makeSA({ id: "sa-new" });
    mockServiceAccountCreate.mockResolvedValue(created);

    const req = createRequest("POST", "http://localhost/api/tenant/service-accounts", {
      body: { name: "ci-bot", description: "CI pipeline bot" },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(201);
    expect(json.id).toBe("sa-new");
    expect(json.name).toBe("ci-bot");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "SERVICE_ACCOUNT_CREATE",
        tenantId: "tenant-1",
      }),
    );
    // The count-then-create runs under a per-tenant advisory lock (TOCTOU fix).
    expectAdvisoryLockAcquired(mockExecuteRaw);
  });

  it("rejects when limit exceeded (MAX_SERVICE_ACCOUNTS_PER_TENANT)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockServiceAccountCount.mockResolvedValue(MAX_SERVICE_ACCOUNTS_PER_TENANT);

    const req = createRequest("POST", "http://localhost/api/tenant/service-accounts", {
      body: { name: "ci-bot" },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(409);
    expect(json.error).toBe("SA_LIMIT_EXCEEDED");
  });

  it("rejects duplicate name with 409", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockServiceAccountCount.mockResolvedValue(0);
    // Simulate Prisma P2002 unique constraint violation
    const { Prisma } = await import("@prisma/client");
    const p2002 = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "5.0.0",
    });
    mockServiceAccountCreate.mockRejectedValue(p2002);

    const req = createRequest("POST", "http://localhost/api/tenant/service-accounts", {
      body: { name: "ci-bot" },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(409);
    expect(json.error).toBe("SA_NAME_CONFLICT");
  });

  it("returns 401 for unauthenticated users", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("POST", "http://localhost/api/tenant/service-accounts", {
      body: { name: "ci-bot" },
    });
    const res = await POST(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(401);
  });

  it("returns 403 for insufficient permission", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockRejectedValue(new TenantAuthError("FORBIDDEN", 403));

    const req = createRequest("POST", "http://localhost/api/tenant/service-accounts", {
      body: { name: "ci-bot" },
    });
    const res = await POST(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(403);
  });

  it("returns 429 when rate limited", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockRateLimiterCheck.mockResolvedValueOnce({ allowed: false, retryAfterMs: 30_000 });

    const req = createRequest("POST", "http://localhost/api/tenant/service-accounts", {
      body: { name: "ci-bot" },
    });
    const res = await POST(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(429);
    expect(mockServiceAccountCreate).not.toHaveBeenCalled();
  });

  it("returns 503 (fail-closed) when the create limiter signals redisErrored", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockRateLimiterCheck.mockResolvedValueOnce({ allowed: false, redisErrored: true });

    const req = createRequest("POST", "http://localhost/api/tenant/service-accounts", {
      body: { name: "ci-bot" },
    });
    const res = await POST(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(503);
    expect(mockServiceAccountCreate).not.toHaveBeenCalled();
  });
});
