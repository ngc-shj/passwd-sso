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
  mockTenantFindUnique,
  mockPrismaTransaction,
  mockHashToken,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTenantPermission: vi.fn(),
  mockWithTenantRls: vi.fn(async (_prisma: unknown, _tenantId: unknown, fn: () => unknown) => fn()),
  mockWithBypassRls: vi.fn(async (_prisma: unknown, fn: () => unknown) => fn()),
  mockLogAudit: vi.fn(),
  mockAccessRequestFindUnique: vi.fn(),
  mockTenantFindUnique: vi.fn(),
  mockPrismaTransaction: vi.fn(),
  mockHashToken: vi.fn().mockReturnValue("hashed-token"),
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
    accessRequest: {
      findUnique: mockAccessRequestFindUnique,
    },
    tenant: {
      findUnique: mockTenantFindUnique,
    },
    $transaction: mockPrismaTransaction,
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

import { POST } from "@/app/api/tenant/access-requests/[id]/approve/route";
import { TenantAuthError } from "@/lib/auth/access/tenant-auth";

const ACTOR = { tenantId: "tenant-1", role: "ADMIN" };
const REQUEST_ID = "req-00000001";
const SA_ID = "00000000-0000-4000-a000-000000000001";

const makeAccessRequest = (overrides: Record<string, unknown> = {}) => ({
  id: REQUEST_ID,
  tenantId: "tenant-1",
  serviceAccountId: SA_ID,
  requestedScope: "passwords:read",
  status: "PENDING",
  serviceAccount: { isActive: true },
  ...overrides,
});

const makeTransactionSuccess = () => {
  const expiresAt = new Date(Date.now() + 3600 * 1000);
  mockPrismaTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
    const tx = {
      serviceAccountToken: {
        count: vi.fn().mockResolvedValue(0),
        create: vi.fn().mockResolvedValue({
          id: "tok-1",
          serviceAccountId: SA_ID,
          tenantId: "tenant-1",
          tokenHash: "hashed-token",
          prefix: "sa_abcd",
          name: `JIT-${REQUEST_ID.slice(0, 8)}`,
          scope: "passwords:read",
          expiresAt,
        }),
      },
      accessRequest: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    return fn(tx);
  });
  return expiresAt;
};

describe("POST /api/tenant/access-requests/[id]/approve", () => {
  beforeEach(() => vi.clearAllMocks());

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

  it("returns 409 when request is already processed (double-approval)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAccessRequestFindUnique.mockResolvedValue(makeAccessRequest());
    mockTenantFindUnique.mockResolvedValue(null);

    // Simulate the transaction throwing "Already processed or wrong tenant"
    mockPrismaTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        serviceAccountToken: {
          count: vi.fn().mockResolvedValue(0),
          create: vi.fn(),
        },
        accessRequest: {
          updateMany: vi.fn().mockResolvedValue({ count: 0 }), // 0 = already processed
          update: vi.fn(),
        },
      };
      return fn(tx);
    });

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

    // Simulate the transaction throwing "Token limit exceeded"
    mockPrismaTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        serviceAccountToken: {
          count: vi.fn().mockResolvedValue(MAX_SA_TOKENS_PER_ACCOUNT),
          create: vi.fn(),
        },
        accessRequest: {
          updateMany: vi.fn(),
          update: vi.fn(),
        },
      };
      return fn(tx);
    });

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
    mockPrismaTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        serviceAccountToken: {
          count: vi.fn().mockResolvedValue(0),
          create: vi.fn(),
        },
        accessRequest: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          update: vi.fn(),
        },
      };
      return fn(tx);
    });

    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}/approve`,
    );
    const res = await POST(req, createParams({ id: REQUEST_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("INVALID_SCOPE");
  });
});
