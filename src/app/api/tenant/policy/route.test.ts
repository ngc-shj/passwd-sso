import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseResponse } from "@/__tests__/helpers/request-builder";

// ── Hoisted mocks ────────────────────────────────────────────

const {
  mockAuth,
  mockRequireTenantPermission,
  mockPrismaUserFindUnique,
  mockPrismaTenantUpdate,
  mockPrismaTenantFindUnique,
  mockWithBypassRls,
  mockLogAudit,
  mockPolicyLimiterCheck,
  mockInvalidateTenantPolicyCache,
  mockExtractClientIp,
  mockWouldIpBeAllowed,
  TenantAuthError,
} = vi.hoisted(() => {
  class _TenantAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "TenantAuthError";
      this.status = status;
    }
  }
  return {
    mockAuth: vi.fn(),
    mockRequireTenantPermission: vi.fn(),
    mockPrismaUserFindUnique: vi.fn(),
    mockPrismaTenantUpdate: vi.fn(),
    mockPrismaTenantFindUnique: vi.fn(),
    mockWithBypassRls: vi.fn(),
    mockLogAudit: vi.fn(),
    mockPolicyLimiterCheck: vi.fn(),
    mockInvalidateTenantPolicyCache: vi.fn(),
    mockExtractClientIp: vi.fn(() => "127.0.0.1"),
    mockWouldIpBeAllowed: vi.fn(() => true),
    TenantAuthError: _TenantAuthError,
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));

vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockPolicyLimiterCheck }),
}));

const { mockTransaction, mockTeamPolicyFindMany, mockTeamPolicyUpdateMany, mockInvalidateSessionTimeoutCache, mockInvalidateLockoutThresholdCache } = vi.hoisted(() => ({
  mockTransaction: vi.fn(),
  mockTeamPolicyFindMany: vi.fn().mockResolvedValue([]),
  mockTeamPolicyUpdateMany: vi.fn().mockResolvedValue({ count: 0 }),
  mockInvalidateSessionTimeoutCache: vi.fn(),
  mockInvalidateLockoutThresholdCache: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: mockPrismaUserFindUnique },
    tenant: {
      update: mockPrismaTenantUpdate,
      findUnique: mockPrismaTenantFindUnique,
    },
    teamPolicy: { findMany: mockTeamPolicyFindMany, updateMany: mockTeamPolicyUpdateMany },
    $transaction: mockTransaction,
  },
}));

vi.mock("@/lib/auth/session-timeout", () => ({
  invalidateSessionTimeoutCacheForTenant: mockInvalidateSessionTimeoutCache,
}));

vi.mock("@/lib/auth/account-lockout", () => ({
  invalidateLockoutThresholdCache: mockInvalidateLockoutThresholdCache,
}));

vi.mock("@/lib/tenant-auth", () => ({
  requireTenantPermission: mockRequireTenantPermission,
  TenantAuthError,
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));

vi.mock("@/lib/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({ ip: null, userAgent: null, acceptLanguage: null }),
  tenantAuditBase: vi.fn((_, userId, tenantId) => ({ scope: "TENANT", userId, tenantId })),
}));

vi.mock("@/lib/constants", () => ({
  AUDIT_ACTION: { POLICY_UPDATE: "POLICY_UPDATE" },
  AUDIT_SCOPE: { TENANT: "TENANT" },
}));

vi.mock("@/lib/constants/tenant-permission", () => ({
  TENANT_PERMISSION: { MEMBER_MANAGE: "MEMBER_MANAGE" },
}));

vi.mock("@/lib/api-error-codes", () => ({
  API_ERROR: {
    UNAUTHORIZED: "UNAUTHORIZED",
    RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED",
    VALIDATION_ERROR: "VALIDATION_ERROR",
    SELF_LOCKOUT: "SELF_LOCKOUT",
  },
}));

vi.mock("@/lib/api-response", () => ({
  errorResponse: (error: string, status: number, extra?: Record<string, unknown>) => {
    const body = { error, ...extra };
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  },
  unauthorized: () =>
    new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    }),
}));

vi.mock("@/lib/validations", () => ({
  TAILNET_NAME_MAX_LENGTH: 253,
}));

vi.mock("@/lib/validations/common", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/validations/common")>();
  return {
    ...actual,
  };
});

vi.mock("@/lib/with-request-log", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withRequestLog: (fn: any) => fn,
}));

vi.mock("@/lib/auth/ip-access", () => ({
  isValidCidr: () => true,
  extractClientIp: mockExtractClientIp,
}));

vi.mock("@/lib/access-restriction", () => ({
  invalidateTenantPolicyCache: mockInvalidateTenantPolicyCache,
  wouldIpBeAllowed: mockWouldIpBeAllowed,
}));

import { GET, PATCH } from "./route";

// ── Test data ────────────────────────────────────────────────

const ROUTE_URL = "http://localhost:3000/api/tenant/policy";

const MEMBERSHIP = {
  id: "membership-1",
  tenantId: "tenant-1",
  userId: "test-user-id",
  role: "OWNER",
};

const BASE_POLICY = {
  maxConcurrentSessions: null,
  sessionIdleTimeoutMinutes: null,
  vaultAutoLockMinutes: null,
  allowedCidrs: [],
  tailscaleEnabled: false,
  tailscaleTailnet: null,
  requireMinPinLength: null,
};

// ── Setup ────────────────────────────────────────────────────

describe("GET /api/tenant/policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireTenantPermission.mockResolvedValue(MEMBERSHIP);
    mockPrismaUserFindUnique.mockResolvedValue({
      tenant: { ...BASE_POLICY },
    });
    mockWithBypassRls.mockImplementation((_p: unknown, fn: () => unknown) => fn());
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("GET", ROUTE_URL);
    const { status, json } = await parseResponse(await GET(req));

    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns requireMinPinLength from tenant policy", async () => {
    mockPrismaUserFindUnique.mockResolvedValue({
      tenant: { ...BASE_POLICY, requireMinPinLength: 6 },
    });

    const req = createRequest("GET", ROUTE_URL);
    const { status, json } = await parseResponse(await GET(req));

    expect(status).toBe(200);
    expect(json.requireMinPinLength).toBe(6);
  });

  it("returns requireMinPinLength=null when policy not set", async () => {
    const req = createRequest("GET", ROUTE_URL);
    const { status, json } = await parseResponse(await GET(req));

    expect(status).toBe(200);
    expect(json.requireMinPinLength).toBeNull();
  });
});

describe("PATCH /api/tenant/policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireTenantPermission.mockResolvedValue(MEMBERSHIP);
    mockPolicyLimiterCheck.mockResolvedValue({ allowed: true });
    mockPrismaTenantUpdate.mockResolvedValue({ ...BASE_POLICY });
    // Return current tenant for self-lockout check
    mockPrismaTenantFindUnique.mockResolvedValue({
      allowedCidrs: [],
      tailscaleEnabled: false,
      tailscaleTailnet: null,
    });
    mockWithBypassRls.mockImplementation((_p: unknown, fn: () => unknown) => fn());
    // Serializable transaction wrapping cascade-clamp + tenant.update
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        teamPolicy: { findMany: mockTeamPolicyFindMany, updateMany: mockTeamPolicyUpdateMany },
        tenant: { update: mockPrismaTenantUpdate },
      }),
    );
    mockTeamPolicyFindMany.mockResolvedValue([]);
    mockTeamPolicyUpdateMany.mockResolvedValue({ count: 0 });
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("PATCH", ROUTE_URL, {
      body: { requireMinPinLength: 6 },
    });
    const { status, json } = await parseResponse(await PATCH(req));

    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("updates requireMinPinLength with valid value (6)", async () => {
    mockPrismaTenantUpdate.mockResolvedValue({ ...BASE_POLICY, requireMinPinLength: 6 });

    const req = createRequest("PATCH", ROUTE_URL, {
      body: { requireMinPinLength: 6 },
    });
    const { status, json } = await parseResponse(await PATCH(req));

    expect(status).toBe(200);
    expect(json.requireMinPinLength).toBe(6);
    expect(mockPrismaTenantUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ requireMinPinLength: 6 }),
      }),
    );
  });

  it("rejects requireMinPinLength below minimum (3)", async () => {
    const req = createRequest("PATCH", ROUTE_URL, {
      body: { requireMinPinLength: 3 },
    });
    const { status, json } = await parseResponse(await PATCH(req));

    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("rejects requireMinPinLength above maximum (64)", async () => {
    const req = createRequest("PATCH", ROUTE_URL, {
      body: { requireMinPinLength: 64 },
    });
    const { status, json } = await parseResponse(await PATCH(req));

    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("accepts requireMinPinLength at lower bound (4)", async () => {
    mockPrismaTenantUpdate.mockResolvedValue({ ...BASE_POLICY, requireMinPinLength: 4 });

    const req = createRequest("PATCH", ROUTE_URL, {
      body: { requireMinPinLength: 4 },
    });
    const { status, json } = await parseResponse(await PATCH(req));

    expect(status).toBe(200);
    expect(json.requireMinPinLength).toBe(4);
  });

  it("accepts requireMinPinLength at upper bound (63)", async () => {
    mockPrismaTenantUpdate.mockResolvedValue({ ...BASE_POLICY, requireMinPinLength: 63 });

    const req = createRequest("PATCH", ROUTE_URL, {
      body: { requireMinPinLength: 63 },
    });
    const { status, json } = await parseResponse(await PATCH(req));

    expect(status).toBe(200);
    expect(json.requireMinPinLength).toBe(63);
  });

  it("allows null to disable the policy", async () => {
    mockPrismaTenantUpdate.mockResolvedValue({ ...BASE_POLICY, requireMinPinLength: null });

    const req = createRequest("PATCH", ROUTE_URL, {
      body: { requireMinPinLength: null },
    });
    const { status, json } = await parseResponse(await PATCH(req));

    expect(status).toBe(200);
    expect(json.requireMinPinLength).toBeNull();
    expect(mockPrismaTenantUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ requireMinPinLength: null }),
      }),
    );
  });

  it("returns 409 when PATCH would lock out the requester", async () => {
    mockWouldIpBeAllowed.mockReturnValue(false);

    const req = createRequest("PATCH", ROUTE_URL, {
      body: { allowedCidrs: ["10.0.0.0/8"] },
    });
    const { status, json } = await parseResponse(await PATCH(req));

    expect(status).toBe(409);
    expect(json.error).toBe("SELF_LOCKOUT");
  });

  it("allows PATCH with confirmLockout when it would lock out", async () => {
    mockWouldIpBeAllowed.mockReturnValue(false);
    mockPrismaTenantUpdate.mockResolvedValue({ ...BASE_POLICY, allowedCidrs: ["10.0.0.0/8"] });

    const req = createRequest("PATCH", ROUTE_URL, {
      body: { allowedCidrs: ["10.0.0.0/8"], confirmLockout: true },
    });
    const { status } = await parseResponse(await PATCH(req));

    expect(status).toBe(200);
  });
});
