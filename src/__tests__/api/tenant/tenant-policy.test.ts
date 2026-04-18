import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import { createRequest, parseResponse } from "../../helpers/request-builder";

const {
  mockAuth, mockRequireTenantPermission, mockUserFindUnique, mockTenantUpdate,
  mockTenantFindUnique, mockWithBypassRls, mockLogAudit, mockRateLimiterCheck,
  mockInvalidateCache, mockWouldIpBeAllowed, mockExtractClientIp,
  mockTeamPolicyFindMany, mockTeamPolicyUpdateMany, mockTransaction,
  mockInvalidateSessionTimeoutCache,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTenantPermission: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockTenantUpdate: vi.fn(),
  mockTenantFindUnique: vi.fn(),
  mockWithBypassRls: vi.fn(async (_prisma: unknown, fn: () => unknown) => fn()),
  mockLogAudit: vi.fn(),
  mockRateLimiterCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockInvalidateCache: vi.fn(),
  mockWouldIpBeAllowed: vi.fn().mockReturnValue(true),
  mockExtractClientIp: vi.fn().mockReturnValue("192.168.1.100"),
  mockTeamPolicyFindMany: vi.fn().mockResolvedValue([]),
  mockTeamPolicyUpdateMany: vi.fn().mockResolvedValue({ count: 0 }),
  mockTransaction: vi.fn(),
  mockInvalidateSessionTimeoutCache: vi.fn(),
}));

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
    user: { findUnique: mockUserFindUnique },
    tenant: { update: mockTenantUpdate, findUnique: mockTenantFindUnique },
    teamPolicy: { findMany: mockTeamPolicyFindMany, updateMany: mockTeamPolicyUpdateMany },
    $transaction: mockTransaction,
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));
vi.mock("@/lib/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "test" }),
  tenantAuditBase: vi.fn((_, userId, tenantId) => ({ scope: "TENANT", userId, tenantId })),
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateLimiterCheck }),
}));
vi.mock("@/lib/with-request-log", () => ({
  withRequestLog: (handler: (...args: unknown[]) => unknown) => handler,
}));
vi.mock("@/lib/constants/tenant-permission", () => ({
  TENANT_PERMISSION: { MEMBER_MANAGE: "MEMBER_MANAGE" },
}));
vi.mock("@/lib/ip-access", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ip-access")>("@/lib/ip-access");
  return { ...actual, extractClientIp: mockExtractClientIp };
});
vi.mock("@/lib/access-restriction", () => ({
  invalidateTenantPolicyCache: mockInvalidateCache,
  wouldIpBeAllowed: mockWouldIpBeAllowed,
}));
vi.mock("@/lib/session-timeout", () => ({
  invalidateSessionTimeoutCacheForTenant: mockInvalidateSessionTimeoutCache,
}));
vi.mock("@/lib/account-lockout", () => ({
  invalidateLockoutThresholdCache: vi.fn(),
}));

import { GET, PATCH } from "@/app/api/tenant/policy/route";
import { TenantAuthError } from "@/lib/tenant-auth";

const FULL_POLICY_RESPONSE = {
  maxConcurrentSessions: null,
  sessionIdleTimeoutMinutes: 480,
  sessionAbsoluteTimeoutMinutes: 43200,
  extensionTokenIdleTimeoutMinutes: 10080,
  extensionTokenAbsoluteTimeoutMinutes: 43200,
  vaultAutoLockMinutes: null,
  allowedCidrs: [],
  tailscaleEnabled: false,
  tailscaleTailnet: null,
};

describe("GET /api/tenant/policy", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const req = createRequest("GET", "http://localhost/api/tenant/policy");
    const res = await GET(req);
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 403 when lacking permission", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockRejectedValue(new TenantAuthError("FORBIDDEN", 403));
    const req = createRequest("GET", "http://localhost/api/tenant/policy");
    const res = await GET(req);
    const { status } = await parseResponse(res);
    expect(status).toBe(403);
  });

  it("returns full policy including access restriction fields", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
    mockUserFindUnique.mockResolvedValue({
      tenant: {
        maxConcurrentSessions: 5,
        sessionIdleTimeoutMinutes: null,
        vaultAutoLockMinutes: null,
        allowedCidrs: ["10.0.0.0/8"],
        tailscaleEnabled: true,
        tailscaleTailnet: "my-tailnet",
      },
    });

    const req = createRequest("GET", "http://localhost/api/tenant/policy");
    const res = await GET(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.maxConcurrentSessions).toBe(5);
    expect(json.allowedCidrs).toEqual(["10.0.0.0/8"]);
    expect(json.tailscaleEnabled).toBe(true);
    expect(json.tailscaleTailnet).toBe("my-tailnet");
  });

  it("returns defaults when no tenant data", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
    mockUserFindUnique.mockResolvedValue({ tenant: null });

    const req = createRequest("GET", "http://localhost/api/tenant/policy");
    const res = await GET(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.allowedCidrs).toEqual([]);
    expect(json.tailscaleEnabled).toBe(false);
    expect(json.tailscaleTailnet).toBeNull();
  });
});

describe("PATCH /api/tenant/policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The route wraps the tenant.update in a prisma.$transaction with cascade-clamp logic.
    // The transaction handler passes a `tx` object with the same shape as prisma.
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        teamPolicy: {
          findMany: mockTeamPolicyFindMany,
          updateMany: mockTeamPolicyUpdateMany,
        },
        tenant: { update: mockTenantUpdate },
      }),
    );
    mockTeamPolicyFindMany.mockResolvedValue([]);
    mockTeamPolicyUpdateMany.mockResolvedValue({ count: 0 });
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
    mockWouldIpBeAllowed.mockReturnValue(true);
  });

  function mockUpdateReturn(overrides: Record<string, unknown> = {}) {
    mockTenantUpdate.mockResolvedValue({ ...FULL_POLICY_RESPONSE, ...overrides });
  }

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const req = createRequest("PATCH", "http://localhost/api/tenant/policy", { body: {} });
    const res = await PATCH(req);
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 429 when rate limited", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRateLimiterCheck.mockResolvedValueOnce({ allowed: false });
    const req = createRequest("PATCH", "http://localhost/api/tenant/policy", { body: {} });
    const res = await PATCH(req);
    const { status } = await parseResponse(res);
    expect(status).toBe(429);
  });

  it("returns 400 for invalid maxConcurrentSessions (non-integer)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
    const req = createRequest("PATCH", "http://localhost/api/tenant/policy", {
      body: { maxConcurrentSessions: 2.5 },
    });
    const res = await PATCH(req);
    const { status } = await parseResponse(res);
    expect(status).toBe(400);
  });

  it("returns 400 for maxConcurrentSessions < 1", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
    const req = createRequest("PATCH", "http://localhost/api/tenant/policy", {
      body: { maxConcurrentSessions: 0 },
    });
    const res = await PATCH(req);
    const { status } = await parseResponse(res);
    expect(status).toBe(400);
  });

  it("successfully updates maxConcurrentSessions", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
    mockUpdateReturn({ maxConcurrentSessions: 3 });

    const req = createRequest("PATCH", "http://localhost/api/tenant/policy", {
      body: { maxConcurrentSessions: 3 },
    });
    const res = await PATCH(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.maxConcurrentSessions).toBe(3);

    expect(mockTenantUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "tenant1" },
        data: { maxConcurrentSessions: 3 },
      }),
    );

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "POLICY_UPDATE",
        tenantId: "tenant1",
        metadata: expect.objectContaining({ maxConcurrentSessions: 3 }),
      }),
    );
  });

  it("invalidates policy cache after update", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
    mockUpdateReturn();

    const req = createRequest("PATCH", "http://localhost/api/tenant/policy", {
      body: { maxConcurrentSessions: null },
    });
    await PATCH(req);
    expect(mockInvalidateCache).toHaveBeenCalledWith("tenant1");
  });

  it("accepts null to remove limit", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
    mockUpdateReturn({ maxConcurrentSessions: null });

    const req = createRequest("PATCH", "http://localhost/api/tenant/policy", {
      body: { maxConcurrentSessions: null },
    });
    const res = await PATCH(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.maxConcurrentSessions).toBeNull();
  });

  it("returns 400 for sessionIdleTimeoutMinutes = 0", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
    const req = createRequest("PATCH", "http://localhost/api/tenant/policy", {
      body: { sessionIdleTimeoutMinutes: 0 },
    });
    const res = await PATCH(req);
    expect((await parseResponse(res)).status).toBe(400);
  });

  it("returns 400 for sessionIdleTimeoutMinutes > 1440", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
    const req = createRequest("PATCH", "http://localhost/api/tenant/policy", {
      body: { sessionIdleTimeoutMinutes: 1441 },
    });
    const res = await PATCH(req);
    expect((await parseResponse(res)).status).toBe(400);
  });

  it("returns 400 for vaultAutoLockMinutes = 0", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
    const req = createRequest("PATCH", "http://localhost/api/tenant/policy", {
      body: { vaultAutoLockMinutes: 0 },
    });
    const res = await PATCH(req);
    expect((await parseResponse(res)).status).toBe(400);
  });

  it("returns 400 for vaultAutoLockMinutes > 1440", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
    const req = createRequest("PATCH", "http://localhost/api/tenant/policy", {
      body: { vaultAutoLockMinutes: 1441 },
    });
    const res = await PATCH(req);
    expect((await parseResponse(res)).status).toBe(400);
  });

  // ── Cross-field invariant ───────────────────────────────────
  //   vaultAutoLockMinutes must be <= min(sessionIdleTimeoutMinutes,
  //   extensionTokenIdleTimeoutMinutes). Rationale: a vault that stays
  //   decrypted longer than the session/token that grants access to it
  //   leaves cached data readable post-logout. See design doc.

  it("returns 400 when vaultAutoLockMinutes exceeds sessionIdleTimeoutMinutes", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
    mockTenantFindUnique.mockResolvedValue({
      allowedCidrs: [],
      tailscaleEnabled: false,
      tailscaleTailnet: null,
      sessionIdleTimeoutMinutes: 10,
      extensionTokenIdleTimeoutMinutes: 10080,
      vaultAutoLockMinutes: null,
    });
    const req = createRequest("PATCH", "http://localhost/api/tenant/policy", {
      body: { vaultAutoLockMinutes: 60 },
    });
    const res = await PATCH(req);
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(String(json.message ?? "")).toMatch(/vaultAutoLockMinutes/);
    expect(String(json.message ?? "")).toMatch(/sessionIdleTimeoutMinutes/);
  });

  it("returns 400 when vaultAutoLockMinutes exceeds extensionTokenIdleTimeoutMinutes", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
    mockTenantFindUnique.mockResolvedValue({
      allowedCidrs: [],
      tailscaleEnabled: false,
      tailscaleTailnet: null,
      sessionIdleTimeoutMinutes: 480,
      extensionTokenIdleTimeoutMinutes: 10,
      vaultAutoLockMinutes: null,
    });
    const req = createRequest("PATCH", "http://localhost/api/tenant/policy", {
      body: { vaultAutoLockMinutes: 60 },
    });
    const res = await PATCH(req);
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(String(json.message ?? "")).toMatch(/extensionTokenIdleTimeoutMinutes/);
  });

  it("successfully updates all policy fields including access restriction", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
    mockTenantUpdate.mockResolvedValue({
      maxConcurrentSessions: 5,
      sessionIdleTimeoutMinutes: 30,
      vaultAutoLockMinutes: 10,
      allowedCidrs: ["10.0.0.0/8"],
      tailscaleEnabled: true,
      tailscaleTailnet: "my-tailnet",
    });

    const req = createRequest("PATCH", "http://localhost/api/tenant/policy", {
      body: {
        maxConcurrentSessions: 5,
        sessionIdleTimeoutMinutes: 30,
        vaultAutoLockMinutes: 10,
        allowedCidrs: ["10.0.0.0/8"],
        tailscaleEnabled: true,
        tailscaleTailnet: "my-tailnet",
      },
    });
    const res = await PATCH(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json).toEqual({
      maxConcurrentSessions: 5,
      sessionIdleTimeoutMinutes: 30,
      vaultAutoLockMinutes: 10,
      allowedCidrs: ["10.0.0.0/8"],
      tailscaleEnabled: true,
      tailscaleTailnet: "my-tailnet",
    });
  });

  it("returns 400 for non-array allowedCidrs", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
    const req = createRequest("PATCH", "http://localhost/api/tenant/policy", {
      body: { allowedCidrs: "10.0.0.0/8" },
    });
    const res = await PATCH(req);
    expect((await parseResponse(res)).status).toBe(400);
  });

  it("returns 400 for invalid CIDR in allowedCidrs", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
    const req = createRequest("PATCH", "http://localhost/api/tenant/policy", {
      body: { allowedCidrs: ["not-a-cidr"] },
    });
    const res = await PATCH(req);
    expect((await parseResponse(res)).status).toBe(400);
  });

  it("returns 400 for too many CIDRs", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
    const cidrs = Array.from({ length: 51 }, (_, i) => `10.${i}.0.0/24`);
    const req = createRequest("PATCH", "http://localhost/api/tenant/policy", {
      body: { allowedCidrs: cidrs },
    });
    const res = await PATCH(req);
    expect((await parseResponse(res)).status).toBe(400);
  });

  it("returns 400 for non-boolean tailscaleEnabled", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
    const req = createRequest("PATCH", "http://localhost/api/tenant/policy", {
      body: { tailscaleEnabled: "yes" },
    });
    const res = await PATCH(req);
    expect((await parseResponse(res)).status).toBe(400);
  });

  it("returns 400 when tailscaleEnabled=true but tailscaleTailnet is empty", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
    const req = createRequest("PATCH", "http://localhost/api/tenant/policy", {
      body: { tailscaleEnabled: true, tailscaleTailnet: "" },
    });
    const res = await PATCH(req);
    expect((await parseResponse(res)).status).toBe(400);
  });

  it("returns 400 for malformed JSON body", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });

    const req = createRequest("PATCH", "http://localhost/api/tenant/policy", {
      headers: { "Content-Type": "application/json" },
    });
    (req as unknown as { json: () => Promise<unknown> }).json = async () => {
      throw new SyntaxError("Unexpected end of JSON input");
    };
    const res = await PATCH(req);
    expect((await parseResponse(res)).status).toBe(400);
  });

  it("handles empty body without error", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
    mockUpdateReturn({ maxConcurrentSessions: 5 });

    const req = createRequest("PATCH", "http://localhost/api/tenant/policy", {
      body: {},
    });
    const res = await PATCH(req);
    const { status } = await parseResponse(res);
    expect(status).toBe(200);
  });

  it("returns 400 for tailscaleTailnet with invalid DNS characters", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });

    for (const invalid of ["-leading", "trailing-", "has space", "has/slash", "under_score"]) {
      const req = createRequest("PATCH", "http://localhost/api/tenant/policy", {
        body: { tailscaleTailnet: invalid },
      });
      const res = await PATCH(req);
      const { status } = await parseResponse(res);
      expect(status).toBe(400);
    }
  });

  it("accepts valid DNS tailscaleTailnet", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
    mockUpdateReturn({ tailscaleTailnet: "my-corp.example.ts.net" });

    const req = createRequest("PATCH", "http://localhost/api/tenant/policy", {
      body: { tailscaleTailnet: "my-corp.example.ts.net" },
    });
    const res = await PATCH(req);
    const { status } = await parseResponse(res);
    expect(status).toBe(200);
  });

  it("returns 409 when self-lockout detected", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
    mockTenantFindUnique.mockResolvedValue({
      allowedCidrs: [],
      tailscaleEnabled: false,
      tailscaleTailnet: null,
    });
    mockWouldIpBeAllowed.mockReturnValueOnce(false);

    const req = createRequest("PATCH", "http://localhost/api/tenant/policy", {
      body: { allowedCidrs: ["10.0.0.0/8"] },
    });
    const res = await PATCH(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(409);
    expect(json.error).toBe("SELF_LOCKOUT");
  });

  it("returns 409 when clientIp is null and restrictions are being set", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
    mockTenantFindUnique.mockResolvedValue({
      allowedCidrs: [],
      tailscaleEnabled: false,
      tailscaleTailnet: null,
    });
    mockExtractClientIp.mockReturnValueOnce(null);

    const req = createRequest("PATCH", "http://localhost/api/tenant/policy", {
      body: { allowedCidrs: ["10.0.0.0/8"] },
    });
    const res = await PATCH(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(409);
    expect(json.error).toBe("SELF_LOCKOUT");
    expect(json.message).toContain("could not be determined");
  });

  it("allows save with confirmLockout when self-lockout detected", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant1" });
    mockTenantUpdate.mockResolvedValue({
      ...FULL_POLICY_RESPONSE,
      allowedCidrs: ["10.0.0.0/8"],
    });
    // wouldIpBeAllowed is not called when confirmLockout is true

    const req = createRequest("PATCH", "http://localhost/api/tenant/policy", {
      body: { allowedCidrs: ["10.0.0.0/8"], confirmLockout: true },
    });
    const res = await PATCH(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.allowedCidrs).toEqual(["10.0.0.0/8"]);
    expect(mockWouldIpBeAllowed).not.toHaveBeenCalled();
  });
});
