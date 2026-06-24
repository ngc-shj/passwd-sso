import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseResponse } from "@/__tests__/helpers/request-builder";

// ── Hoisted mocks ────────────────────────────────────────────

const {
  mockAuth,
  mockRequireTenantPermission,
  mockPrismaUserFindUnique,
  mockPrismaTenantUpdate,
  mockPrismaTenantFindUnique,
  mockPrismaSessionFindMany,
  mockWithBypassRls,
  mockLogAudit,
  mockPolicyLimiterCheck,
  mockInvalidateTenantPolicyCache,
  mockInvalidateCachedSessionsBulk,
  mockExtractClientIp,
  mockWouldIpBeAllowed,
  mockRequireRecentSession,
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
    mockPrismaSessionFindMany: vi.fn().mockResolvedValue([]),
    mockWithBypassRls: vi.fn(),
    mockLogAudit: vi.fn(),
    mockPolicyLimiterCheck: vi.fn(),
    mockInvalidateTenantPolicyCache: vi.fn(),
    mockInvalidateCachedSessionsBulk: vi
      .fn<(tokens: ReadonlyArray<string>) => Promise<{ total: number; failed: number }>>()
      .mockImplementation(async (tokens) => ({ total: tokens.length, failed: 0 })),
    mockExtractClientIp: vi.fn(() => "127.0.0.1"),
    mockWouldIpBeAllowed: vi.fn(() => true),
    mockRequireRecentSession: vi.fn().mockResolvedValue(null),
    TenantAuthError: _TenantAuthError,
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));

vi.mock("@/lib/security/rate-limit", () => ({
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
    session: { findMany: mockPrismaSessionFindMany },
    teamPolicy: { findMany: mockTeamPolicyFindMany, updateMany: mockTeamPolicyUpdateMany },
    $transaction: mockTransaction,
  },
}));

vi.mock("@/lib/auth/session/session-cache", () => ({
  invalidateCachedSessionsBulk: mockInvalidateCachedSessionsBulk,
}));

vi.mock("@/lib/auth/session/session-timeout", () => ({
  invalidateSessionTimeoutCacheForTenant: mockInvalidateSessionTimeoutCache,
}));

vi.mock("@/lib/auth/policy/account-lockout", () => ({
  invalidateLockoutThresholdCache: mockInvalidateLockoutThresholdCache,
}));

vi.mock("@/lib/auth/access/tenant-auth", () => ({
  requireTenantPermission: mockRequireTenantPermission,
  TenantAuthError,
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));

vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({ ip: null, userAgent: null, acceptLanguage: null }),
  tenantAuditBase: vi.fn((_, userId, tenantId) => ({ scope: "TENANT", userId, tenantId })),
}));

vi.mock("@/lib/constants", () => ({
  AUDIT_ACTION: { POLICY_UPDATE: "POLICY_UPDATE" },
  AUDIT_SCOPE: { TENANT: "TENANT" },
}));

vi.mock("@/lib/constants/auth/tenant-permission", () => ({
  TENANT_PERMISSION: { MEMBER_MANAGE: "MEMBER_MANAGE" },
}));

vi.mock("@/lib/http/api-error-codes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/http/api-error-codes")>()),
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

vi.mock("@/lib/http/with-request-log", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withRequestLog: (fn: any) => fn,
}));

vi.mock("@/lib/auth/policy/ip-access", () => ({
  isValidCidr: () => true,
  extractClientIp: mockExtractClientIp,
}));

vi.mock("@/lib/auth/policy/access-restriction", () => ({
  invalidateTenantPolicyCache: mockInvalidateTenantPolicyCache,
  wouldIpBeAllowed: mockWouldIpBeAllowed,
}));
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: mockRequireRecentSession,
}));

import { GET, PATCH } from "./route";
import {
  expectInvalidatedAfterCommit,
  expectNotInvalidatedOnDbThrow,
} from "@/__tests__/helpers/session-cache-assertions";

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
    mockWithBypassRls.mockImplementation((p: unknown, fn: (tx: unknown) => unknown) => fn(p));
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
      requirePasskey: false,
      passkeyGracePeriodDays: null,
    });
    mockPrismaSessionFindMany.mockResolvedValue([]);
    mockWithBypassRls.mockImplementation((p: unknown, fn: (tx: unknown) => unknown) => fn(p));
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

  describe("session cache invalidation (site #9)", () => {
    it("bulk-invalidates session cache when requirePasskey changes false → true", async () => {
      mockPrismaTenantFindUnique.mockResolvedValue({
        allowedCidrs: [],
        tailscaleEnabled: false,
        tailscaleTailnet: null,
        requirePasskey: false,
        passkeyGracePeriodDays: null,
      });
      mockPrismaSessionFindMany.mockResolvedValue([
        { sessionToken: "tok-1" },
        { sessionToken: "tok-2" },
      ]);
      mockPrismaTenantUpdate.mockResolvedValue({
        ...BASE_POLICY,
        requirePasskey: true,
      });

      const req = createRequest("PATCH", ROUTE_URL, {
        body: { requirePasskey: true },
      });
      const { status } = await parseResponse(await PATCH(req));

      expect(status).toBe(200);
      expectInvalidatedAfterCommit(mockInvalidateCachedSessionsBulk, [
        "tok-1",
        "tok-2",
      ]);
    });

    it("bulk-invalidates session cache when passkeyGracePeriodDays changes", async () => {
      mockPrismaTenantFindUnique.mockResolvedValue({
        allowedCidrs: [],
        tailscaleEnabled: false,
        tailscaleTailnet: null,
        requirePasskey: true,
        passkeyGracePeriodDays: 7,
      });
      mockPrismaSessionFindMany.mockResolvedValue([
        { sessionToken: "tok-x" },
      ]);
      mockPrismaTenantUpdate.mockResolvedValue({
        ...BASE_POLICY,
        passkeyGracePeriodDays: 14,
      });

      const req = createRequest("PATCH", ROUTE_URL, {
        body: { passkeyGracePeriodDays: 14 },
      });
      const { status } = await parseResponse(await PATCH(req));

      expect(status).toBe(200);
      expectInvalidatedAfterCommit(mockInvalidateCachedSessionsBulk, ["tok-x"]);
    });

    it("does not invalidate session cache when requirePasskey is unchanged", async () => {
      mockPrismaTenantFindUnique.mockResolvedValue({
        allowedCidrs: [],
        tailscaleEnabled: false,
        tailscaleTailnet: null,
        requirePasskey: true,
        passkeyGracePeriodDays: 7,
      });
      mockPrismaTenantUpdate.mockResolvedValue({
        ...BASE_POLICY,
        requirePasskey: true,
      });

      const req = createRequest("PATCH", ROUTE_URL, {
        body: { requirePasskey: true },
      });
      const { status } = await parseResponse(await PATCH(req));

      expect(status).toBe(200);
      expectNotInvalidatedOnDbThrow(mockInvalidateCachedSessionsBulk);
    });

    it("does not invalidate session cache for non-passkey policy changes", async () => {
      mockPrismaTenantUpdate.mockResolvedValue({
        ...BASE_POLICY,
        requireMinPinLength: 6,
      });

      const req = createRequest("PATCH", ROUTE_URL, {
        body: { requireMinPinLength: 6 },
      });
      const { status } = await parseResponse(await PATCH(req));

      expect(status).toBe(200);
      expectNotInvalidatedOnDbThrow(mockInvalidateCachedSessionsBulk);
    });

    it(
      "records cacheInvalidatedSessions and cacheTombstoneFailures:0 in " +
        "POLICY_UPDATE audit metadata when invalidation succeeds",
      async () => {
        mockPrismaTenantFindUnique.mockResolvedValue({
          allowedCidrs: [],
          tailscaleEnabled: false,
          tailscaleTailnet: null,
          requirePasskey: false,
          passkeyGracePeriodDays: null,
        });
        mockPrismaSessionFindMany.mockResolvedValue([
          { sessionToken: "tok-1" },
          { sessionToken: "tok-2" },
        ]);
        mockPrismaTenantUpdate.mockResolvedValue({
          ...BASE_POLICY,
          requirePasskey: true,
        });

        const req = createRequest("PATCH", ROUTE_URL, {
          body: { requirePasskey: true },
        });
        const { status } = await parseResponse(await PATCH(req));
        expect(status).toBe(200);

        expect(mockLogAudit).toHaveBeenCalledWith(
          expect.objectContaining({
            action: "POLICY_UPDATE",
            metadata: expect.objectContaining({
              cacheInvalidatedSessions: 2,
              cacheTombstoneFailures: 0,
            }),
          }),
        );
      },
    );

    it(
      "surfaces Redis tombstone failures into POLICY_UPDATE audit metadata " +
        "when bulk invalidation fails — silent cache outage during a tenant " +
        "policy tightening MUST be forensically visible",
      async () => {
        mockPrismaTenantFindUnique.mockResolvedValue({
          allowedCidrs: [],
          tailscaleEnabled: false,
          tailscaleTailnet: null,
          requirePasskey: false,
          passkeyGracePeriodDays: null,
        });
        mockPrismaSessionFindMany.mockResolvedValue([
          { sessionToken: "tok-1" },
          { sessionToken: "tok-2" },
          { sessionToken: "tok-3" },
        ]);
        mockPrismaTenantUpdate.mockResolvedValue({
          ...BASE_POLICY,
          requirePasskey: true,
        });
        // Pipeline.exec failed: all-or-nothing, so failed === total.
        mockInvalidateCachedSessionsBulk.mockResolvedValueOnce({
          total: 3,
          failed: 3,
        });

        const req = createRequest("PATCH", ROUTE_URL, {
          body: { requirePasskey: true },
        });
        const { status } = await parseResponse(await PATCH(req));
        expect(status).toBe(200);

        expect(mockLogAudit).toHaveBeenCalledWith(
          expect.objectContaining({
            action: "POLICY_UPDATE",
            metadata: expect.objectContaining({
              cacheInvalidatedSessions: 3,
              cacheTombstoneFailures: 3,
            }),
          }),
        );
      },
    );

    it(
      "omits cacheInvalidatedSessions/cacheTombstoneFailures from POLICY_UPDATE " +
        "audit metadata for non-passkey policy changes (invalidation did not run)",
      async () => {
        mockPrismaTenantUpdate.mockResolvedValue({
          ...BASE_POLICY,
          requireMinPinLength: 6,
        });

        const req = createRequest("PATCH", ROUTE_URL, {
          body: { requireMinPinLength: 6 },
        });
        const { status } = await parseResponse(await PATCH(req));
        expect(status).toBe(200);

        const call = mockLogAudit.mock.calls.find(
          (c) => (c[0] as { action: string }).action === "POLICY_UPDATE",
        );
        expect(call).toBeDefined();
        const metadata = (call?.[0] as { metadata: Record<string, unknown> }).metadata;
        expect(metadata).not.toHaveProperty("cacheInvalidatedSessions");
        expect(metadata).not.toHaveProperty("cacheTombstoneFailures");
      },
    );

    it("does not invalidate session cache when policy update transaction throws", async () => {
      mockPrismaTenantFindUnique.mockResolvedValue({
        allowedCidrs: [],
        tailscaleEnabled: false,
        tailscaleTailnet: null,
        requirePasskey: false,
        passkeyGracePeriodDays: null,
      });
      // The cascade-clamp + tenant.update now run directly inside the
      // withBypassRls transaction (no nested prisma.$transaction); simulate
      // that transaction rolling back via the bypass wrapper.
      mockWithBypassRls.mockRejectedValueOnce(new Error("tx rolled back"));

      const req = createRequest("PATCH", ROUTE_URL, {
        body: { requirePasskey: true },
      });
      await expect(PATCH(req)).rejects.toThrow("tx rolled back");

      expectNotInvalidatedOnDbThrow(mockInvalidateCachedSessionsBulk);
    });
  });

  describe("generic retention fields", () => {
    const FIELDS = [
      "trashRetentionDays",
      "historyRetentionDays",
      "shareAccessLogRetentionDays",
      "directorySyncLogRetentionDays",
      "notificationRetentionDays",
    ] as const;

    for (const field of FIELDS) {
      it(`GET returns ${field} from tenant policy`, async () => {
        mockPrismaUserFindUnique.mockResolvedValue({
          tenant: { ...BASE_POLICY, [field]: 42 },
        });
        const req = createRequest("GET", ROUTE_URL);
        const { status, json } = await parseResponse(await GET(req));
        expect(status).toBe(200);
        expect(json[field]).toBe(42);
      });

      it(`GET returns ${field}=null when not set`, async () => {
        mockPrismaUserFindUnique.mockResolvedValue({ tenant: { ...BASE_POLICY } });
        const req = createRequest("GET", ROUTE_URL);
        const { status, json } = await parseResponse(await GET(req));
        expect(status).toBe(200);
        expect(json[field]).toBeNull();
      });

      it(`PATCH accepts a valid ${field} and writes it`, async () => {
        mockPrismaTenantUpdate.mockResolvedValue({ ...BASE_POLICY, [field]: 30 });
        const req = createRequest("PATCH", ROUTE_URL, { body: { [field]: 30 } });
        const { status, json } = await parseResponse(await PATCH(req));
        expect(status).toBe(200);
        expect(json[field]).toBe(30);
        expect(mockPrismaTenantUpdate).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ [field]: 30 }) }),
        );
      });

      it(`PATCH accepts ${field} at the lower bound (1)`, async () => {
        mockPrismaTenantUpdate.mockResolvedValue({ ...BASE_POLICY, [field]: 1 });
        const req = createRequest("PATCH", ROUTE_URL, { body: { [field]: 1 } });
        const { status, json } = await parseResponse(await PATCH(req));
        expect(status).toBe(200);
        expect(json[field]).toBe(1);
      });

      it(`PATCH rejects ${field} below minimum (0)`, async () => {
        const req = createRequest("PATCH", ROUTE_URL, { body: { [field]: 0 } });
        const { status, json } = await parseResponse(await PATCH(req));
        expect(status).toBe(400);
        expect(json.error).toBe("VALIDATION_ERROR");
      });

      it(`PATCH rejects ${field} above maximum (3651)`, async () => {
        const req = createRequest("PATCH", ROUTE_URL, { body: { [field]: 3651 } });
        const { status, json } = await parseResponse(await PATCH(req));
        expect(status).toBe(400);
        expect(json.error).toBe("VALIDATION_ERROR");
      });

      it(`PATCH rejects non-integer ${field}`, async () => {
        const req = createRequest("PATCH", ROUTE_URL, { body: { [field]: 1.5 } });
        const { status, json } = await parseResponse(await PATCH(req));
        expect(status).toBe(400);
        expect(json.error).toBe("VALIDATION_ERROR");
      });

      it(`PATCH null clears ${field}`, async () => {
        mockPrismaTenantUpdate.mockResolvedValue({ ...BASE_POLICY, [field]: null });
        const req = createRequest("PATCH", ROUTE_URL, { body: { [field]: null } });
        const { status, json } = await parseResponse(await PATCH(req));
        expect(status).toBe(200);
        expect(json[field]).toBeNull();
        expect(mockPrismaTenantUpdate).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ [field]: null }) }),
        );
      });
    }
  });

  it("returns 403 when session step-up is required", async () => {
    mockRequireRecentSession.mockResolvedValueOnce(
      Response.json({ error: "SESSION_STEP_UP_REQUIRED" }, { status: 403 }),
    );

    const req = createRequest("PATCH", ROUTE_URL, {
      body: { requireMinPinLength: 6 },
    });
    const { status, json } = await parseResponse(await PATCH(req));

    expect(status).toBe(403);
    expect(json.error).toBe("SESSION_STEP_UP_REQUIRED");
    expect(mockPrismaTenantUpdate).not.toHaveBeenCalled();
  });
});
