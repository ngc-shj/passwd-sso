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
  mockAccessRequestUpdateMany,
  mockAccessRequestUpdate,
  mockTenantFindUnique,
  mockSaTokenCount,
  mockSaTokenCreate,
  mockHashToken,
  mockDispatchTenantWebhook,
  mockRequireRecentSession,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockAuthOrToken: vi.fn(),
  mockRequireTenantPermission: vi.fn(),
  mockWithTenantRls: vi.fn(async (prisma: unknown, _tenantId: unknown, fn: (tx: unknown) => unknown) => fn(prisma)),
  mockWithBypassRls: vi.fn(async (prisma: unknown, fn: (tx: unknown) => unknown) => fn(prisma)),
  mockLogAudit: vi.fn(),
  mockRateLimiterCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockAccessRequestFindMany: vi.fn(),
  mockAccessRequestCreate: vi.fn(),
  mockServiceAccountFindUnique: vi.fn(),
  mockAccessRequestFindUnique: vi.fn(),
  mockAccessRequestUpdateMany: vi.fn(),
  mockAccessRequestUpdate: vi.fn(),
  mockTenantFindUnique: vi.fn(),
  mockSaTokenCount: vi.fn(),
  mockSaTokenCreate: vi.fn(),
  mockHashToken: vi.fn().mockReturnValue("hashed-token"),
  mockDispatchTenantWebhook: vi.fn(),
  mockRequireRecentSession: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: mockRequireRecentSession,
}));
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
      findMany: mockAccessRequestFindMany,
      create: mockAccessRequestCreate,
      findUnique: mockAccessRequestFindUnique,
      updateMany: mockAccessRequestUpdateMany,
      update: mockAccessRequestUpdate,
    },
    serviceAccount: {
      findUnique: mockServiceAccountFindUnique,
    },
    tenant: {
      findUnique: mockTenantFindUnique,
    },
    serviceAccountToken: {
      count: mockSaTokenCount,
      create: mockSaTokenCreate,
    },
    // Advisory lock used to serialize concurrent SA token issuance.
    $executeRaw: vi.fn().mockResolvedValue(0),
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: mockWithTenantRls,
  withBypassRls: mockWithBypassRls,
}));
vi.mock("@/lib/auth/session/auth-or-token", () => ({
  authOrToken: mockAuthOrToken,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  resolveActorType: () => "HUMAN",
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "test", acceptLanguage: null }),
  tenantAuditBase: vi.fn((_, userId, tenantId) => ({ scope: "TENANT", userId, tenantId })),
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateLimiterCheck }),
}));
vi.mock("@/lib/http/with-request-log", () => ({
  withRequestLog: (handler: (...args: unknown[]) => unknown) => handler,
}));
vi.mock("@/lib/webhook-dispatcher", () => ({
  dispatchTenantWebhook: mockDispatchTenantWebhook,
}));
vi.mock("@/lib/crypto/crypto-server", () => ({
  hashToken: mockHashToken,
}));

import { POST as createAccessRequest } from "@/app/api/tenant/access-requests/route";
import { POST as approveAccessRequest } from "@/app/api/tenant/access-requests/[id]/approve/route";
import { parseSaTokenScopes } from "@/lib/auth/tokens/service-account-token";
import { SA_TOKEN_SCOPES } from "@/lib/constants/auth/service-account";
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
      expiresAt: new Date(Date.now() + MS_PER_HOUR),
      serviceAccount: { isActive: true },
    });
    mockTenantFindUnique.mockResolvedValue(null); // use defaults

    const expiresAt = new Date(Date.now() + 3600 * 1000);
    mockSaTokenCount.mockResolvedValue(0);
    mockSaTokenCreate.mockResolvedValue({
      id: "d0000000-0000-4000-8000-000000000001",
      serviceAccountId: SA_ID,
      tenantId: "a0000000-0000-4000-8000-000000000001",
      tokenHash: "hashed-token",
      prefix: "sa_abcd",
      name: `JIT-${REQUEST_ID.slice(0, 8)}`,
      scope: "passwords:read,passwords:list",
      expiresAt,
    });
    mockAccessRequestUpdateMany.mockResolvedValue({ count: 1 });
    mockAccessRequestUpdate.mockResolvedValue({});

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
      expiresAt: new Date(Date.now() + MS_PER_HOUR),
      serviceAccount: { isActive: true },
    });
    mockTenantFindUnique.mockResolvedValue(null);

    const expiresAt = new Date(Date.now() + 3600 * 1000);

    mockSaTokenCount.mockResolvedValue(0);
    mockSaTokenCreate.mockResolvedValue({
      id: "d0000000-0000-4000-8000-000000000001",
      serviceAccountId: SA_ID,
      tenantId: "a0000000-0000-4000-8000-000000000001",
      tokenHash: "hashed-token",
      prefix: "sa_abcd",
      name: `JIT-${REQUEST_ID.slice(0, 8)}`,
      scope: "passwords:read",
      expiresAt,
    });
    mockAccessRequestUpdate.mockResolvedValue({});
    // First approval: the status transition fires (count 1, success).
    // Second approval: the row is no longer PENDING (count 0, already processed).
    mockAccessRequestUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    const req1 = createRequest(
      "POST",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}/approve`,
    );
    const res1 = await approveAccessRequest(req1, createParams({ id: REQUEST_ID }));
    const { status: status1 } = await parseResponse(res1);
    expect(status1).toBe(200);

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

  it("creating request for inactive SA returns 409 SA_INACTIVE", async () => {
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

    expect(status).toBe(409);
    expect(json.error).toBe("SA_INACTIVE");
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
      expiresAt: new Date(Date.now() + MS_PER_HOUR),
      serviceAccount: { isActive: false },
    });

    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}/approve`,
    );
    const res = await approveAccessRequest(req, createParams({ id: REQUEST_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(409);
    expect(json.error).toBe("SA_INACTIVE");
  });
});

describe("Scenario 5: Expired access request rejection (regression)", () => {
  beforeEach(() => vi.clearAllMocks());

  // A stale PENDING request whose expiresAt has already passed must NOT be
  // approvable. The state-machine transition() gates only on status, so without
  // an explicit expiry check an admin could revive a stale request and issue a
  // fresh JIT token long after the requester's intent has expired.
  it("approving an expired PENDING request returns 410 SA_ACCESS_REQUEST_EXPIRED", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockAuthOrToken.mockResolvedValue({ type: "session", userId: DEFAULT_SESSION.user.id });
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockAccessRequestFindUnique.mockResolvedValue({
      id: REQUEST_ID,
      tenantId: "a0000000-0000-4000-8000-000000000001",
      serviceAccountId: SA_ID,
      requestedScope: "passwords:read",
      status: "PENDING",
      // Expired 1 minute ago — must be rejected even though status is PENDING.
      expiresAt: new Date(Date.now() - 60_000),
      serviceAccount: { isActive: true },
    });

    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}/approve`,
    );
    const res = await approveAccessRequest(req, createParams({ id: REQUEST_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(410);
    expect(json.error).toBe("SA_ACCESS_REQUEST_EXPIRED");
    // Must NOT have started the issue-token write path.
    expect(mockSaTokenCount).not.toHaveBeenCalled();
    expect(mockSaTokenCreate).not.toHaveBeenCalled();
  });

  it("approving at exactly expiresAt is rejected (boundary)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockAuthOrToken.mockResolvedValue({ type: "session", userId: DEFAULT_SESSION.user.id });
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    mockAccessRequestFindUnique.mockResolvedValue({
      id: REQUEST_ID,
      tenantId: "a0000000-0000-4000-8000-000000000001",
      serviceAccountId: SA_ID,
      requestedScope: "passwords:read",
      status: "PENDING",
      expiresAt: new Date(now), // exactly now
      serviceAccount: { isActive: true },
    });

    const req = createRequest(
      "POST",
      `http://localhost/api/tenant/access-requests/${REQUEST_ID}/approve`,
    );
    const res = await approveAccessRequest(req, createParams({ id: REQUEST_ID }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(410);
    expect(json.error).toBe("SA_ACCESS_REQUEST_EXPIRED");
    vi.restoreAllMocks();
  });
});
