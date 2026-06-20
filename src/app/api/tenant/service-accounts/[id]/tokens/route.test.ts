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
  mockServiceAccountFindUnique,
  mockServiceAccountTokenFindMany,
  mockServiceAccountTokenCount,
  mockServiceAccountTokenCreate,
  mockHashToken,
  mockRequireRecentSession,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTenantPermission: vi.fn(),
  // withTenantRls IS the transaction boundary in production: it opens the
  // tx and passes it to fn. The mock passes the prisma mock as the tx so the
  // route's tx.serviceAccountToken.{findMany,count,create} resolve to the
  // configured mocks (no separate $transaction indirection).
  mockWithTenantRls: vi.fn(async (prisma: unknown, _tenantId: unknown, fn: (tx: unknown) => unknown) => fn(prisma)),
  mockLogAudit: vi.fn(),
  mockServiceAccountFindUnique: vi.fn(),
  mockServiceAccountTokenFindMany: vi.fn(),
  mockServiceAccountTokenCount: vi.fn(),
  mockServiceAccountTokenCreate: vi.fn(),
  mockHashToken: vi.fn().mockReturnValue("hashed-token"),
  mockRequireRecentSession: vi.fn().mockResolvedValue(null),
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
      findUnique: mockServiceAccountFindUnique,
    },
    serviceAccountToken: {
      findMany: mockServiceAccountTokenFindMany,
      count: mockServiceAccountTokenCount,
      create: mockServiceAccountTokenCreate,
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
vi.mock("@/lib/crypto/crypto-server", () => ({
  hashToken: mockHashToken,
}));
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: mockRequireRecentSession,
}));

import { GET, POST } from "@/app/api/tenant/service-accounts/[id]/tokens/route";
import { MAX_SA_TOKENS_PER_ACCOUNT } from "@/lib/constants/auth/service-account";

const ACTOR = { tenantId: "tenant-1", role: "ADMIN" };
const SA_ID = "sa-00000001";
const TOKEN_ID = "tok-00000001";

const makeToken = (overrides: Record<string, unknown> = {}) => ({
  id: TOKEN_ID,
  name: "deploy-token",
  scope: "passwords:read",
  prefix: "sa_abcd",
  expiresAt: new Date(Date.now() + 90 * 24 * 3600 * 1000),
  createdAt: new Date(),
  revokedAt: null,
  lastUsedAt: null,
  ...overrides,
});

const makeTransactionSuccess = () => {
  mockServiceAccountTokenCount.mockResolvedValue(0);
  mockServiceAccountTokenCreate.mockResolvedValue({
    id: TOKEN_ID,
    serviceAccountId: SA_ID,
    tenantId: "tenant-1",
    tokenHash: "hashed-token",
    prefix: "sa_abcd",
    name: "deploy-token",
    scope: "passwords:read",
    expiresAt: new Date(Date.now() + 90 * 24 * 3600 * 1000),
    createdAt: new Date(),
  });
};

describe("GET /api/tenant/service-accounts/[id]/tokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRecentSession.mockReset();
    mockRequireRecentSession.mockResolvedValue(null);
  });

  it("returns list of tokens for a service account", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockServiceAccountFindUnique.mockResolvedValue({ id: SA_ID, tenantId: "tenant-1" });
    mockServiceAccountTokenFindMany.mockResolvedValue([makeToken()]);

    const req = createRequest(
      "GET",
      `http://localhost/api/tenant/service-accounts/${SA_ID}/tokens`,
    );
    const res = await GET(req, createParams({ id: SA_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(Array.isArray(json)).toBe(true);
    expect(json).toHaveLength(1);
    expect(json[0].id).toBe(TOKEN_ID);
    expect(mockRequireRecentSession).not.toHaveBeenCalled();
  });

  it("does not require session step-up for listing tokens", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockRequireRecentSession.mockResolvedValueOnce(
      Response.json({ error: "SESSION_STEP_UP_REQUIRED" }, { status: 403 }),
    );
    mockServiceAccountFindUnique.mockResolvedValue({ id: SA_ID, tenantId: "tenant-1" });
    mockServiceAccountTokenFindMany.mockResolvedValue([makeToken()]);

    const req = createRequest(
      "GET",
      `http://localhost/api/tenant/service-accounts/${SA_ID}/tokens`,
    );
    const res = await GET(req, createParams({ id: SA_ID }));
    const { status } = await parseResponse(res);

    expect(status).toBe(200);
    expect(mockRequireRecentSession).not.toHaveBeenCalled();
  });

  it("returns 404 when service account not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockServiceAccountFindUnique.mockResolvedValue(null);

    const req = createRequest(
      "GET",
      `http://localhost/api/tenant/service-accounts/${SA_ID}/tokens`,
    );
    const res = await GET(req, createParams({ id: SA_ID }));
    const { status } = await parseResponse(res);

    expect(status).toBe(404);
  });

  it("returns 401 for unauthenticated users", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest(
      "GET",
      `http://localhost/api/tenant/service-accounts/${SA_ID}/tokens`,
    );
    const res = await GET(req, createParams({ id: SA_ID }));
    const { status } = await parseResponse(res);

    expect(status).toBe(401);
  });
});

describe("POST /api/tenant/service-accounts/[id]/tokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRecentSession.mockReset();
    mockRequireRecentSession.mockResolvedValue(null);
  });

  it("creates a token and returns plaintext once", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockServiceAccountFindUnique.mockResolvedValue({
      id: SA_ID,
      tenantId: "tenant-1",
      isActive: true,
    });
    makeTransactionSuccess();

    const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/service-accounts/${SA_ID}/tokens`,
      {
        body: {
          name: "deploy-token",
          scope: ["passwords:read"],
          expiresAt,
        },
      },
    );
    const res = await POST(req, createParams({ id: SA_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(201);
    expect(typeof json.token).toBe("string");
    expect(json.token).toMatch(/^sa_/);
    expect(json.id).toBe(TOKEN_ID);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "SERVICE_ACCOUNT_TOKEN_CREATE",
        tenantId: "tenant-1",
      }),
    );
  });

  it("returns 409 when service account is inactive", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockServiceAccountFindUnique.mockResolvedValue({
      id: SA_ID,
      tenantId: "tenant-1",
      isActive: false,
    });

    const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/service-accounts/${SA_ID}/tokens`,
      {
        body: {
          name: "deploy-token",
          scope: ["passwords:read"],
          expiresAt,
        },
      },
    );
    const res = await POST(req, createParams({ id: SA_ID }));
    const { status } = await parseResponse(res);

    expect(status).toBe(409);
  });

  it("returns 403 when session step-up is required", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockRequireRecentSession.mockResolvedValueOnce(
      Response.json({ error: "SESSION_STEP_UP_REQUIRED" }, { status: 403 }),
    );

    const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/service-accounts/${SA_ID}/tokens`,
      {
        body: {
          name: "deploy-token",
          scope: ["passwords:read"],
          expiresAt,
        },
      },
    );
    const res = await POST(req, createParams({ id: SA_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(403);
    expect(json.error).toBe("SESSION_STEP_UP_REQUIRED");
    expect(mockServiceAccountTokenCount).not.toHaveBeenCalled();
    expect(mockServiceAccountTokenCreate).not.toHaveBeenCalled();
  });

  it("returns 409 when token limit is reached", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockServiceAccountFindUnique.mockResolvedValue({
      id: SA_ID,
      tenantId: "tenant-1",
      isActive: true,
    });

    mockServiceAccountTokenCount.mockResolvedValue(MAX_SA_TOKENS_PER_ACCOUNT);

    const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/service-accounts/${SA_ID}/tokens`,
      {
        body: {
          name: "deploy-token",
          scope: ["passwords:read"],
          expiresAt,
        },
      },
    );
    const res = await POST(req, createParams({ id: SA_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(409);
    expect(json.error).toBe("SA_TOKEN_LIMIT_EXCEEDED");
  });

  it("counts only non-revoked AND non-expired tokens toward the limit", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockServiceAccountFindUnique.mockResolvedValue({
      id: SA_ID,
      tenantId: "tenant-1",
      isActive: true,
    });

    mockServiceAccountTokenCount.mockResolvedValue(0);
    mockServiceAccountTokenCreate.mockResolvedValue({
      id: "tok-new",
      name: "deploy-token",
      scope: ["passwords:read"],
      expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      createdAt: new Date(),
    });

    const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/service-accounts/${SA_ID}/tokens`,
      { body: { name: "deploy-token", scope: ["passwords:read"], expiresAt } },
    );
    await POST(req, createParams({ id: SA_ID }));

    // Expired-but-not-revoked tokens are unusable and must not consume a slot.
    const where = mockServiceAccountTokenCount.mock.calls[0][0].where;
    expect(where.revokedAt).toBeNull();
    expect(where.expiresAt).toEqual({ gt: expect.any(Date) });
  });

  it("clamps expiresAt to saTokenMaxExpiryDays when requested expiry exceeds the limit", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockServiceAccountFindUnique.mockResolvedValue({
      id: SA_ID,
      tenantId: "tenant-1",
      isActive: true,
      tenant: { saTokenMaxExpiryDays: 30 },
    });

    let capturedExpiresAt: Date | undefined;
    mockServiceAccountTokenCount.mockResolvedValue(0);
    mockServiceAccountTokenCreate.mockImplementation(({ data }: { data: { expiresAt: Date } }) => {
      capturedExpiresAt = data.expiresAt;
      return Promise.resolve({
        id: TOKEN_ID,
        serviceAccountId: SA_ID,
        tenantId: "tenant-1",
        tokenHash: "hashed-token",
        prefix: "sa_abcd",
        name: "deploy-token",
        scope: "passwords:read",
        expiresAt: data.expiresAt,
        createdAt: new Date(),
      });
    });

    const expiresAt = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();
    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/service-accounts/${SA_ID}/tokens`,
      {
        body: {
          name: "deploy-token",
          scope: ["passwords:read"],
          expiresAt,
        },
      },
    );
    const res = await POST(req, createParams({ id: SA_ID }));
    const { status } = await parseResponse(res);

    expect(status).toBe(201);
    expect(capturedExpiresAt).toBeDefined();
    const expectedMax = Date.now() + 30 * 24 * 3600 * 1000;
    expect(capturedExpiresAt!.getTime()).toBeGreaterThan(expectedMax - 5000);
    expect(capturedExpiresAt!.getTime()).toBeLessThanOrEqual(expectedMax + 5000);
  });

  it("passes expiresAt through unchanged when within saTokenMaxExpiryDays", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockServiceAccountFindUnique.mockResolvedValue({
      id: SA_ID,
      tenantId: "tenant-1",
      isActive: true,
      tenant: { saTokenMaxExpiryDays: 90 },
    });

    let capturedExpiresAt: Date | undefined;
    mockServiceAccountTokenCount.mockResolvedValue(0);
    mockServiceAccountTokenCreate.mockImplementation(({ data }: { data: { expiresAt: Date } }) => {
      capturedExpiresAt = data.expiresAt;
      return Promise.resolve({
        id: TOKEN_ID,
        serviceAccountId: SA_ID,
        tenantId: "tenant-1",
        tokenHash: "hashed-token",
        prefix: "sa_abcd",
        name: "deploy-token",
        scope: "passwords:read",
        expiresAt: data.expiresAt,
        createdAt: new Date(),
      });
    });

    const requestedExpiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/service-accounts/${SA_ID}/tokens`,
      {
        body: {
          name: "deploy-token",
          scope: ["passwords:read"],
          expiresAt: requestedExpiresAt.toISOString(),
        },
      },
    );
    const res = await POST(req, createParams({ id: SA_ID }));
    const { status } = await parseResponse(res);

    expect(status).toBe(201);
    expect(capturedExpiresAt).toBeDefined();
    expect(Math.abs(capturedExpiresAt!.getTime() - requestedExpiresAt.getTime())).toBeLessThan(1000);
  });

  it("returns 401 for unauthenticated users", async () => {
    mockAuth.mockResolvedValue(null);

    const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/service-accounts/${SA_ID}/tokens`,
      {
        body: {
          name: "deploy-token",
          scope: ["passwords:read"],
          expiresAt,
        },
      },
    );
    const res = await POST(req, createParams({ id: SA_ID }));
    const { status } = await parseResponse(res);

    expect(status).toBe(401);
  });
});
