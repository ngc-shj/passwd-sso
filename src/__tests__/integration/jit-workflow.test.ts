/**
 * Integration-style scenario tests for JIT access request workflow.
 * Tests end-to-end flow across the create and approve route handlers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../helpers/mock-auth";
import {
  createRequest,
  parseResponse,
  createParams,
} from "../helpers/request-builder";

const {
  mockAuth,
  mockAuthOrToken,
  mockRequireTenantPermission,
  mockWithTenantRls,
  mockWithBypassRls,
  mockLogAudit,
  mockRateLimiterCheck,
  mockAccessRequestFindMany,
  mockAccessRequestCreate,
  mockServiceAccountFindUnique,
  mockAccessRequestFindUnique,
  mockTenantFindUnique,
  mockPrismaTransaction,
  mockHashToken,
  mockDispatchTenantWebhook,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockAuthOrToken: vi.fn(),
  mockRequireTenantPermission: vi.fn(),
  mockWithTenantRls: vi.fn(async (_prisma: unknown, _tenantId: unknown, fn: () => unknown) => fn()),
  mockWithBypassRls: vi.fn(async (_prisma: unknown, fn: () => unknown) => fn()),
  mockLogAudit: vi.fn(),
  mockRateLimiterCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockAccessRequestFindMany: vi.fn(),
  mockAccessRequestCreate: vi.fn(),
  mockServiceAccountFindUnique: vi.fn(),
  mockAccessRequestFindUnique: vi.fn(),
  mockTenantFindUnique: vi.fn(),
  mockPrismaTransaction: vi.fn(),
  mockHashToken: vi.fn().mockReturnValue("hashed-token"),
  mockDispatchTenantWebhook: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/auth/tenant-auth", () => {
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
      findMany: mockAccessRequestFindMany,
      create: mockAccessRequestCreate,
      findUnique: mockAccessRequestFindUnique,
    },
    serviceAccount: {
      findUnique: mockServiceAccountFindUnique,
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
vi.mock("@/lib/auth/auth-or-token", () => ({
  authOrToken: mockAuthOrToken,
}));
vi.mock("@/lib/audit", () => ({
  logAuditAsync: mockLogAudit,
  resolveActorType: () => "HUMAN",
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

import { POST as createAccessRequest } from "@/app/api/tenant/access-requests/route";
import { POST as approveAccessRequest } from "@/app/api/tenant/access-requests/[id]/approve/route";
import { parseSaTokenScopes } from "@/lib/auth/service-account-token";
import { SA_TOKEN_SCOPES } from "@/lib/constants/service-account";
import { z } from "zod";
import { MS_PER_HOUR } from "@/lib/constants/time";

const ACTOR = { tenantId: "a0000000-0000-4000-8000-000000000001", role: "ADMIN" };
const SA_ID = "00000000-0000-4000-a000-000000000001";
const REQUEST_ID = "req-00000001";

describe("Scenario 1: Full JIT workflow", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates access request, approves it, and JIT token contains only validated scopes", async () => {
    // Step 1: Create access request
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockAuthOrToken.mockResolvedValue({ type: "session", userId: DEFAULT_SESSION.user.id });
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockServiceAccountFindUnique.mockResolvedValue({
      id: SA_ID,
      tenantId: "a0000000-0000-4000-8000-000000000001",
      isActive: true,
    });

    const createdRequest = {
      id: REQUEST_ID,
      serviceAccountId: SA_ID,
      requestedScope: "passwords:read,passwords:list",
      justification: "Automated incident response",
      status: "PENDING",
      expiresAt: new Date(Date.now() + MS_PER_HOUR),
      createdAt: new Date(),
    };
    mockAccessRequestCreate.mockResolvedValue(createdRequest);

    const createReq = createRequest(
      "POST",
      "http://localhost/api/tenant/access-requests",
      {
        body: {
          serviceAccountId: SA_ID,
          requestedScope: ["passwords:read", "passwords:list"],
          justification: "Automated incident response",
          expiresInMinutes: 60,
        },
      },
    );
    const createRes = await createAccessRequest(createReq);
    const { status: createStatus, json: createJson } = await parseResponse(createRes);

    expect(createStatus).toBe(201);
    expect(createJson.id).toBe(REQUEST_ID);
    expect(createJson.status).toBe("PENDING");

    // Step 2: Approve the request to issue JIT token
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockAuthOrToken.mockResolvedValue({ type: "session", userId: DEFAULT_SESSION.user.id });
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAccessRequestFindUnique.mockResolvedValue({
      id: REQUEST_ID,
      tenantId: "a0000000-0000-4000-8000-000000000001",
      serviceAccountId: SA_ID,
      requestedScope: "passwords:read,passwords:list",
      status: "PENDING",
      serviceAccount: { isActive: true },
    });
    mockTenantFindUnique.mockResolvedValue(null); // use defaults

    const expiresAt = new Date(Date.now() + 3600 * 1000);
    mockPrismaTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        serviceAccountToken: {
          count: vi.fn().mockResolvedValue(0),
          create: vi.fn().mockResolvedValue({
            id: "d0000000-0000-4000-8000-000000000001",
            serviceAccountId: SA_ID,
            tenantId: "a0000000-0000-4000-8000-000000000001",
            tokenHash: "hashed-token",
            prefix: "sa_abcd",
            name: `JIT-${REQUEST_ID.slice(0, 8)}`,
            scope: "passwords:read,passwords:list",
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

    const approveReq = createRequest(
      "POST",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}/approve`,
    );
    const approveRes = await approveAccessRequest(approveReq, createParams({ id: REQUEST_ID }));
    const { status: approveStatus, json: approveJson } = await parseResponse(approveRes);

    expect(approveStatus).toBe(200);
    expect(typeof approveJson.token).toBe("string");
    expect(approveJson.token).toMatch(/^sa_/);
    expect(approveJson.ttlSec).toBeGreaterThan(0);

    // Step 3: Verify parseSaTokenScopes filters only valid scopes
    const tokenScope = "passwords:read,passwords:list";
    const parsed = parseSaTokenScopes(tokenScope);
    expect(parsed).toContain("passwords:read");
    expect(parsed).toContain("passwords:list");
    expect(parsed).not.toContain("vault:unlock");
    expect(parsed.every((s) => (SA_TOKEN_SCOPES as readonly string[]).includes(s))).toBe(true);
  });

  it("parseSaTokenScopes filters out unknown/forbidden scopes from CSV", () => {
    // Only valid SA_TOKEN_SCOPES should be kept
    const mixed = "passwords:read,vault:unlock,vault:setup,passwords:list,unknown:scope";
    const parsed = parseSaTokenScopes(mixed);

    expect(parsed).toContain("passwords:read");
    expect(parsed).toContain("passwords:list");
    expect(parsed).not.toContain("vault:unlock");
    expect(parsed).not.toContain("vault:setup");
    expect(parsed).not.toContain("unknown:scope");
  });
});

describe("Scenario 2: Forbidden scope rejection via schema validation", () => {
  it("z.array(z.enum(SA_TOKEN_SCOPES)) rejects vault:unlock", () => {
    // Directly test the Zod schema used in the route
    const scopeSchema = z.array(z.enum(SA_TOKEN_SCOPES as [string, ...string[]])).min(1);

    const validResult = scopeSchema.safeParse(["passwords:read"]);
    expect(validResult.success).toBe(true);

    const invalidResult = scopeSchema.safeParse(["vault:unlock"]);
    expect(invalidResult.success).toBe(false);
  });

  it("z.array(z.enum(SA_TOKEN_SCOPES)) rejects vault:setup", () => {
    const scopeSchema = z.array(z.enum(SA_TOKEN_SCOPES as [string, ...string[]])).min(1);

    const invalidResult = scopeSchema.safeParse(["vault:setup"]);
    expect(invalidResult.success).toBe(false);
  });

  it("z.array(z.enum(SA_TOKEN_SCOPES)) rejects vault:reset", () => {
    const scopeSchema = z.array(z.enum(SA_TOKEN_SCOPES as [string, ...string[]])).min(1);

    const invalidResult = scopeSchema.safeParse(["vault:reset"]);
    expect(invalidResult.success).toBe(false);
  });

  it("POST /api/tenant/access-requests returns 400 when requesting vault:unlock scope", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockAuthOrToken.mockResolvedValue({ type: "session", userId: DEFAULT_SESSION.user.id });
    mockRequireTenantPermission.mockResolvedValue(ACTOR);

    const req = createRequest("POST", "http://localhost/api/tenant/access-requests", {
      body: {
        serviceAccountId: SA_ID,
        requestedScope: ["vault:unlock"],
      },
    });
    const res = await createAccessRequest(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(400);
  });
});

describe("Scenario 3: Double approval prevention", () => {
  beforeEach(() => vi.clearAllMocks());

  it("first approval succeeds, second approval gets 409 CONFLICT", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockAuthOrToken.mockResolvedValue({ type: "session", userId: DEFAULT_SESSION.user.id });
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAccessRequestFindUnique.mockResolvedValue({
      id: REQUEST_ID,
      tenantId: "a0000000-0000-4000-8000-000000000001",
      serviceAccountId: SA_ID,
      requestedScope: "passwords:read",
      status: "PENDING",
      serviceAccount: { isActive: true },
    });
    mockTenantFindUnique.mockResolvedValue(null);

    const expiresAt = new Date(Date.now() + 3600 * 1000);

    // First approval: updateMany returns count 1 (success)
    mockPrismaTransaction.mockImplementationOnce(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        serviceAccountToken: {
          count: vi.fn().mockResolvedValue(0),
          create: vi.fn().mockResolvedValue({
            id: "d0000000-0000-4000-8000-000000000001",
            serviceAccountId: SA_ID,
            tenantId: "a0000000-0000-4000-8000-000000000001",
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

    const req1 = createRequest(
      "POST",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}/approve`,
    );
    const res1 = await approveAccessRequest(req1, createParams({ id: REQUEST_ID }));
    const { status: status1 } = await parseResponse(res1);
    expect(status1).toBe(200);

    // Second approval: updateMany returns count 0 (already processed)
    mockPrismaTransaction.mockImplementationOnce(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        serviceAccountToken: {
          count: vi.fn().mockResolvedValue(0),
          create: vi.fn(),
        },
        accessRequest: {
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          update: vi.fn(),
        },
      };
      return fn(tx);
    });

    const req2 = createRequest(
      "POST",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}/approve`,
    );
    const res2 = await approveAccessRequest(req2, createParams({ id: REQUEST_ID }));
    const { status: status2, json: json2 } = await parseResponse(res2);

    expect(status2).toBe(409);
    expect(json2.error).toBe("CONFLICT");
  });
});

describe("Scenario 4: Inactive SA JIT rejection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creating request for inactive SA returns 404", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockAuthOrToken.mockResolvedValue({ type: "session", userId: DEFAULT_SESSION.user.id });
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockServiceAccountFindUnique.mockResolvedValue({
      id: SA_ID,
      tenantId: "a0000000-0000-4000-8000-000000000001",
      isActive: false, // inactive
    });

    const req = createRequest("POST", "http://localhost/api/tenant/access-requests", {
      body: {
        serviceAccountId: SA_ID,
        requestedScope: ["passwords:read"],
      },
    });
    const res = await createAccessRequest(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(404);
    expect(json.error).toBe("SA_NOT_FOUND");
  });

  it("approving request where SA became inactive returns 409", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockAuthOrToken.mockResolvedValue({ type: "session", userId: DEFAULT_SESSION.user.id });
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    // SA is inactive at the time of approval
    mockAccessRequestFindUnique.mockResolvedValue({
      id: REQUEST_ID,
      tenantId: "a0000000-0000-4000-8000-000000000001",
      serviceAccountId: SA_ID,
      requestedScope: "passwords:read",
      status: "PENDING",
      serviceAccount: { isActive: false },
    });

    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}/approve`,
    );
    const res = await approveAccessRequest(req, createParams({ id: REQUEST_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(409);
    expect(json.error).toBe("SA_NOT_FOUND");
  });
});
