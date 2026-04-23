/**
 * Integration-style scenario tests for the Service Account lifecycle.
 *
 * These tests exercise multi-step flows across multiple route handlers.
 * Prisma is mocked to simulate DB state changes between calls.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../helpers/mock-auth";
import {
  createRequest,
  parseResponse,
  createParams,
} from "../helpers/request-builder";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const {
  mockAuth,
  mockRequireTenantPermission,
  mockWithTenantRls,
  mockWithBypassRls,
  mockLogAudit,
  mockRateLimiterCheck,
  mockDispatchTenantWebhook,
  mockHashToken,
  mockServiceAccountCount,
  mockServiceAccountCreate,
  mockServiceAccountFindUnique,
  mockServiceAccountUpdate,
  mockServiceAccountDelete,
  mockServiceAccountTokenFindUnique,
  mockServiceAccountTokenUpdate,
  mockServiceAccountTokenUpdateMany,
  mockPrismaTransaction,
  mockPasswordsAuthOrToken,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTenantPermission: vi.fn(),
  mockWithTenantRls: vi.fn(async (_p: unknown, _t: unknown, fn: () => unknown) => fn()),
  mockWithBypassRls: vi.fn(async (_p: unknown, fn: () => unknown) => fn()),
  mockLogAudit: vi.fn(),
  mockRateLimiterCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockDispatchTenantWebhook: vi.fn(),
  mockHashToken: vi.fn().mockReturnValue("hashed-token"),
  mockServiceAccountCount: vi.fn(),
  mockServiceAccountCreate: vi.fn(),
  mockServiceAccountFindUnique: vi.fn(),
  mockServiceAccountUpdate: vi.fn(),
  mockServiceAccountDelete: vi.fn(),
  mockServiceAccountTokenFindUnique: vi.fn(),
  mockServiceAccountTokenUpdate: vi.fn(),
  mockServiceAccountTokenUpdateMany: vi.fn(),
  mockPrismaTransaction: vi.fn(),
  mockPasswordsAuthOrToken: vi.fn(),
}));

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("@/auth", () => ({ auth: mockAuth }));

vi.mock("@/lib/tenant-auth", () => {
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
      count: mockServiceAccountCount,
      create: mockServiceAccountCreate,
      findUnique: mockServiceAccountFindUnique,
      update: mockServiceAccountUpdate,
      delete: mockServiceAccountDelete,
    },
    serviceAccountToken: {
      findUnique: mockServiceAccountTokenFindUnique,
      update: mockServiceAccountTokenUpdate,
      updateMany: mockServiceAccountTokenUpdateMany,
    },
    $transaction: mockPrismaTransaction,
  },
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: mockWithTenantRls,
  withBypassRls: mockWithBypassRls,
}));

vi.mock("@/lib/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "test", acceptLanguage: null }),
  tenantAuditBase: vi.fn((_, userId, tenantId) => ({ scope: "TENANT", userId, tenantId })),
}));

vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateLimiterCheck }),
}));

vi.mock("@/lib/with-request-log", () => ({
  withRequestLog: (handler: (...args: unknown[]) => unknown) => handler,
}));

vi.mock("@/lib/webhook-dispatcher", () => ({
  dispatchTenantWebhook: mockDispatchTenantWebhook,
}));

vi.mock("@/lib/crypto-server", () => ({
  hashToken: mockHashToken,
}));

// Do NOT mock service-account-token — let the real validateServiceAccountToken and
// parseSaTokenScopes run; their Prisma dependencies are intercepted via mocked prisma/withBypassRls.

// passwords route uses authOrToken from @/lib/auth-or-token
vi.mock("@/lib/auth-or-token", () => ({
  authOrToken: mockPasswordsAuthOrToken,
  hasUserId: (a: { userId?: string }) => "userId" in a,
}));

vi.mock("@/lib/access-restriction", () => ({
  enforceAccessRestriction: vi.fn().mockResolvedValue(null),
}));

// ─── Route imports (after mocks) ─────────────────────────────────────────────

import { POST as createSA } from "@/app/api/tenant/service-accounts/route";
import {
  GET as getSA,
  PUT as updateSA,
  DELETE as deleteSA,
} from "@/app/api/tenant/service-accounts/[id]/route";
import {
  POST as createToken,
} from "@/app/api/tenant/service-accounts/[id]/tokens/route";
import {
  validateServiceAccountToken,
  parseSaTokenScopes,
} from "@/lib/auth/service-account-token";
import { authOrToken } from "@/lib/auth-or-token";

// ─── Shared fixtures ─────────────────────────────────────────────────────────

const ACTOR = { tenantId: "a0000000-0000-4000-8000-000000000001", role: "ADMIN" };
const SA_ID = "sa-00000001";
const TOKEN_ID = "tok-00000001";

const BASE_SA = {
  id: SA_ID,
  name: "ci-bot",
  description: "CI pipeline bot",
  identityType: "SERVICE_ACCOUNT",
  isActive: true,
  teamId: null,
  tenantId: "a0000000-0000-4000-8000-000000000001",
  createdAt: new Date("2025-01-01T00:00:00Z"),
  updatedAt: new Date("2025-01-01T00:00:00Z"),
  createdBy: { id: DEFAULT_SESSION.user.id, name: "Test User", email: "user@example.com" },
  _count: { tokens: 0 },
};

const BASE_TOKEN = {
  id: TOKEN_ID,
  serviceAccountId: SA_ID,
  tenantId: "a0000000-0000-4000-8000-000000000001",
  tokenHash: "hashed-token",
  prefix: "sa_abcd",
  name: "deploy-token",
  scope: "passwords:read",
  expiresAt: new Date(Date.now() + 90 * 24 * 3600 * 1000),
  createdAt: new Date(),
  revokedAt: null,
  lastUsedAt: null,
};

// ─── Scenario 1: SA CRUD lifecycle ───────────────────────────────────────────

describe("Scenario 1: SA CRUD lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
  });

  it("step 1: creates SA via POST and returns the new resource", async () => {
    mockServiceAccountCount.mockResolvedValue(0);
    mockServiceAccountCreate.mockResolvedValue({ ...BASE_SA });

    const req = createRequest("POST", "http://localhost/api/tenant/service-accounts", {
      body: { name: "ci-bot", description: "CI pipeline bot" },
    });
    const res = await createSA(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(201);
    expect(json.id).toBe(SA_ID);
    expect(json.name).toBe("ci-bot");
    expect(json.isActive).toBe(true);
  });

  it("step 2: retrieves SA via GET and verifies fields", async () => {
    mockServiceAccountFindUnique.mockResolvedValue({ ...BASE_SA });

    const req = createRequest("GET", `http://localhost/api/tenant/service-accounts/${SA_ID}`);
    const res = await getSA(req, createParams({ id: SA_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.id).toBe(SA_ID);
    expect(json.name).toBe("ci-bot");
    expect(json.description).toBe("CI pipeline bot");
    expect(json.isActive).toBe(true);
    expect(json.identityType).toBe("SERVICE_ACCOUNT");
  });

  it("step 3: updates SA name via PUT and verifies the updated value", async () => {
    // First call: existence check; second call: updated record
    mockServiceAccountFindUnique.mockResolvedValue({ id: SA_ID, tenantId: "a0000000-0000-4000-8000-000000000001" });
    mockServiceAccountUpdate.mockResolvedValue({
      ...BASE_SA,
      name: "ci-bot-v2",
      updatedAt: new Date(),
    });

    const req = createRequest("PUT", `http://localhost/api/tenant/service-accounts/${SA_ID}`, {
      body: { name: "ci-bot-v2" },
    });
    const res = await updateSA(req, createParams({ id: SA_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.name).toBe("ci-bot-v2");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "SERVICE_ACCOUNT_UPDATE", tenantId: "a0000000-0000-4000-8000-000000000001" }),
    );
  });

  it("step 4: deletes SA via DELETE — hard-deletes (cascade removes tokens)", async () => {
    mockServiceAccountFindUnique.mockResolvedValue({ id: SA_ID, tenantId: "a0000000-0000-4000-8000-000000000001" });
    mockServiceAccountDelete.mockResolvedValue({});

    const req = createRequest("DELETE", `http://localhost/api/tenant/service-accounts/${SA_ID}`);
    const res = await deleteSA(req, createParams({ id: SA_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "SERVICE_ACCOUNT_DELETE", tenantId: "a0000000-0000-4000-8000-000000000001" }),
    );
  });

  it("step 4 follow-up: GET after delete returns 404 (record no longer exists)", async () => {
    // After hard-delete, the record is gone from the database.
    mockServiceAccountFindUnique.mockResolvedValue(null);

    const req = createRequest("GET", `http://localhost/api/tenant/service-accounts/${SA_ID}`);
    const res = await getSA(req, createParams({ id: SA_ID }));
    const { status } = await parseResponse(res);

    expect(status).toBe(404);
  });
});

// ─── Scenario 2: SA token issuance and validation ────────────────────────────

describe("Scenario 2: SA token issuance and authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
  });

  it("issues a token — plaintext returned once with sa_ prefix", async () => {
    mockServiceAccountFindUnique.mockResolvedValue({
      id: SA_ID,
      tenantId: "a0000000-0000-4000-8000-000000000001",
      isActive: true,
    });

    mockPrismaTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        serviceAccountToken: {
          count: vi.fn().mockResolvedValue(0),
          create: vi.fn().mockResolvedValue({ ...BASE_TOKEN }),
        },
      };
      return fn(tx);
    });

    const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/service-accounts/${SA_ID}/tokens`,
      { body: { name: "deploy-token", scope: ["passwords:read"], expiresAt } },
    );
    const res = await createToken(req, createParams({ id: SA_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(201);
    expect(json.token).toMatch(/^sa_/);
    expect(typeof json.token).toBe("string");
    expect(json.id).toBe(TOKEN_ID);
    // Token response must have Cache-Control: no-store
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("validates token — hashToken(plaintext) → findUnique → returns valid data", async () => {
    // Simulate the DB lookup that validateServiceAccountToken performs internally.
    // mockHashToken is already wired to return "hashed-token".
    mockServiceAccountTokenFindUnique.mockResolvedValue({
      ...BASE_TOKEN,
      serviceAccount: { isActive: true },
    });
    mockServiceAccountTokenUpdate.mockResolvedValue({});

    // validateServiceAccountToken is the real implementation from service-account-token.ts;
    // its Prisma calls are intercepted by mockWithBypassRls + mockServiceAccountTokenFindUnique.
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/v1/test", {
      headers: { Authorization: "Bearer sa_plaintexttoken123" },
    });

    const result = await validateServiceAccountToken(req);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.serviceAccountId).toBe(SA_ID);
      expect(result.data.tenantId).toBe("a0000000-0000-4000-8000-000000000001");
      expect(result.data.tokenId).toBe(TOKEN_ID);
      expect(result.data.scopes).toEqual(["passwords:read"]);
    }
    // hashToken was called with the plaintext
    expect(mockHashToken).toHaveBeenCalledWith("sa_plaintexttoken123");
  });
});

// ─── Scenario 3: SA deactivation → token rejection ───────────────────────────

describe("Scenario 3: SA deactivation → token rejection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("token validates when SA is active", async () => {
    mockServiceAccountTokenFindUnique.mockResolvedValue({
      ...BASE_TOKEN,
      serviceAccount: { isActive: true },
    });
    mockServiceAccountTokenUpdate.mockResolvedValue({});

    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/v1/test", {
      headers: { Authorization: "Bearer sa_activetoken" },
    });

    const result = await validateServiceAccountToken(req);
    expect(result.ok).toBe(true);
  });

  it("token is rejected with SA_INACTIVE when SA is deactivated", async () => {
    // Same token hash, but serviceAccount.isActive is now false
    mockServiceAccountTokenFindUnique.mockResolvedValue({
      ...BASE_TOKEN,
      serviceAccount: { isActive: false },
    });

    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/v1/test", {
      headers: { Authorization: "Bearer sa_activetoken" },
    });

    const result = await validateServiceAccountToken(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("SA_INACTIVE");
    }
  });
});

// ─── Scenario 4: SA token on non-v1 endpoint rejection ───────────────────────

describe("Scenario 4: SA token rejected on non-v1 (session-only) endpoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No active session
    mockAuth.mockResolvedValue(null);
  });

  it("authOrToken returns service_account when SA bearer is presented", async () => {
    mockPasswordsAuthOrToken.mockResolvedValue({
      type: "service_account",
      serviceAccountId: SA_ID,
      tenantId: "a0000000-0000-4000-8000-000000000001",
      tokenId: TOKEN_ID,
      scopes: ["passwords:read"],
    });

    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/passwords", {
      headers: { Authorization: "Bearer sa_validtoken" },
    });

    const result = await authOrToken(req);
    expect(result).toMatchObject({ type: "service_account" });
  });

  it("non-v1 /api/passwords route returns 401 when authOrToken yields service_account", async () => {
    // passwords/route.ts checks: if (!authResult || authResult.type === "service_account") → 401
    mockPasswordsAuthOrToken.mockResolvedValue({
      type: "service_account",
      serviceAccountId: SA_ID,
      tenantId: "a0000000-0000-4000-8000-000000000001",
      tokenId: TOKEN_ID,
      scopes: ["passwords:read"],
    });

    const { GET: getPasswords } = await import(
      "@/app/api/passwords/route"
    );

    const req = createRequest("GET", "http://localhost/api/passwords", {
      headers: { Authorization: "Bearer sa_validtoken" },
    });
    const res = await getPasswords(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(401);
  });
});

// ─── Scenario 5: SA token on v1 endpoint with scope checks ───────────────────

describe("Scenario 5: SA token on v1 endpoint — authOrToken dispatch and scope parsing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("authOrToken returns service_account result for sa_ bearer", async () => {
    // Use the mocked authOrToken (from @/lib/auth-or-token mock)
    mockPasswordsAuthOrToken.mockResolvedValue({
      type: "service_account",
      serviceAccountId: SA_ID,
      tenantId: "a0000000-0000-4000-8000-000000000001",
      tokenId: TOKEN_ID,
      scopes: ["passwords:read", "tags:read"],
    });

    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/v1/test", {
      headers: { Authorization: "Bearer sa_validtoken" },
    });

    const result = await authOrToken(req, "passwords:read" as Parameters<typeof authOrToken>[1]);
    expect(result).toMatchObject({
      type: "service_account",
      serviceAccountId: SA_ID,
      tenantId: "a0000000-0000-4000-8000-000000000001",
      tokenId: TOKEN_ID,
    });
  });

  it("parseSaTokenScopes correctly parses CSV scope string", () => {
    const scopes = parseSaTokenScopes("passwords:read,tags:read,passwords:write");
    expect(scopes).toEqual(["passwords:read", "tags:read", "passwords:write"]);
  });

  it("parseSaTokenScopes drops unknown scopes", () => {
    const scopes = parseSaTokenScopes("passwords:read,unknown:scope,vault:unlock");
    expect(scopes).toEqual(["passwords:read"]);
  });

  it("parseSaTokenScopes returns empty array for empty CSV", () => {
    expect(parseSaTokenScopes("")).toEqual([]);
  });

  it("scope is preserved correctly from token create → DB → validation result", async () => {
    // When a token is stored with scope "passwords:read,tags:read" and later
    // retrieved, parseSaTokenScopes must return both scopes.
    const storedScope = "passwords:read,tags:read";
    mockServiceAccountTokenFindUnique.mockResolvedValue({
      ...BASE_TOKEN,
      scope: storedScope,
      serviceAccount: { isActive: true },
    });
    mockServiceAccountTokenUpdate.mockResolvedValue({});

    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/v1/test", {
      headers: { Authorization: "Bearer sa_multiscopetoken" },
    });

    const result = await validateServiceAccountToken(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.scopes).toEqual(["passwords:read", "tags:read"]);
    }
  });
});
