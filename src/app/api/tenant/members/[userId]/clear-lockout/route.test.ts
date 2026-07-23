import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";
import { assertRedisFailClosed, snapshotFactory } from "@/__tests__/helpers/fail-closed";
import { __resetThrottleForTests } from "@/lib/security/rate-limit-audit";

const {
  mockAuth,
  mockPrismaTenantMemberFindFirst,
  mockPrismaUserUpdate,
  mockAdminLimiterCheck,
  mockTargetLimiterCheck,
  mockCreateRateLimiter,
  mockLogAudit,
  mockRequireTenantPermission,
  mockIsTenantRoleAbove,
  mockWithTenantRls,
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
  const mockAdminLimiterCheck = vi.fn();
  const mockTargetLimiterCheck = vi.fn();
  return {
    mockAuth: vi.fn(),
    mockPrismaTenantMemberFindFirst: vi.fn(),
    mockPrismaUserUpdate: vi.fn(),
    mockAdminLimiterCheck,
    mockTargetLimiterCheck,
    mockCreateRateLimiter: vi
      .fn()
      .mockImplementationOnce((_opts: unknown) => ({ check: mockAdminLimiterCheck, clear: vi.fn() }))
      .mockImplementationOnce((_opts: unknown) => ({ check: mockTargetLimiterCheck, clear: vi.fn() })),
    mockLogAudit: vi.fn(),
    mockRequireTenantPermission: vi.fn(),
    mockIsTenantRoleAbove: vi.fn(),
    mockWithTenantRls: vi.fn(
      (p: unknown, _t: unknown, fn: (tx: unknown) => unknown) => fn(p),
    ),
    mockRequireRecentSession: vi.fn().mockResolvedValue(null),
    TenantAuthError: _TenantAuthError,
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: mockRequireRecentSession,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantMember: {
      findFirst: mockPrismaTenantMemberFindFirst,
    },
    user: {
      update: mockPrismaUserUpdate,
    },
  },
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: mockCreateRateLimiter,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: vi.fn(() => ({ ip: "127.0.0.1", userAgent: "test" })),
  tenantAuditBase: vi.fn((_, userId, tenantId) => ({ scope: "TENANT", userId, tenantId })),
}));
vi.mock("@/lib/auth/access/tenant-auth", () => ({
  requireTenantPermission: mockRequireTenantPermission,
  isTenantRoleAbove: mockIsTenantRoleAbove,
  TenantAuthError,
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: mockWithTenantRls,
}));

import { POST } from "./route";

const adminLimiterFactorySnapshot = snapshotFactory(mockCreateRateLimiter);
const adminLockoutClearLimiter = mockCreateRateLimiter.mock.results[0]!.value as {
  check: typeof mockAdminLimiterCheck;
};
const targetLimiterFactorySnapshot = snapshotFactory(mockCreateRateLimiter);
const targetLockoutClearLimiter = mockCreateRateLimiter.mock.results[1]!.value as {
  check: typeof mockTargetLimiterCheck;
};

const TENANT_ID = "tenant-1";
const TARGET_USER_ID = "user-target";
const ACTOR_USER_ID = "test-user-id";

const ACTOR = {
  id: "membership-owner",
  tenantId: TENANT_ID,
  userId: ACTOR_USER_ID,
  role: "OWNER",
};

const TARGET_MEMBER = { role: "MEMBER" };

describe("POST /api/tenant/members/[userId]/clear-lockout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetThrottleForTests();
    mockAuth.mockResolvedValue({ user: { id: ACTOR_USER_ID } });
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockIsTenantRoleAbove.mockReturnValue(true);
    mockPrismaTenantMemberFindFirst.mockResolvedValue(TARGET_MEMBER);
    mockPrismaUserUpdate.mockResolvedValue({ id: TARGET_USER_ID });
    mockAdminLimiterCheck.mockResolvedValue({ allowed: true });
    mockTargetLimiterCheck.mockResolvedValue({ allowed: true });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", `http://localhost/api/tenant/members/${TARGET_USER_ID}/clear-lockout`),
      createParams({ userId: TARGET_USER_ID }),
    );
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("UNAUTHORIZED");
    expect(mockPrismaUserUpdate).not.toHaveBeenCalled();
  });

  it("returns 403 when lacking MEMBER_MANAGE permission", async () => {
    mockRequireTenantPermission.mockRejectedValue(new TenantAuthError("FORBIDDEN", 403));
    const res = await POST(
      createRequest("POST", `http://localhost/api/tenant/members/${TARGET_USER_ID}/clear-lockout`),
      createParams({ userId: TARGET_USER_ID }),
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("FORBIDDEN");
    expect(mockPrismaUserUpdate).not.toHaveBeenCalled();
  });

  it("rethrows non-TenantAuthError errors from permission check", async () => {
    mockRequireTenantPermission.mockRejectedValue(new Error("unexpected db error"));
    await expect(
      POST(
        createRequest("POST", `http://localhost/api/tenant/members/${TARGET_USER_ID}/clear-lockout`),
        createParams({ userId: TARGET_USER_ID }),
      ),
    ).rejects.toThrow("unexpected db error");
  });

  it("returns 404 when target member not found in tenant", async () => {
    mockPrismaTenantMemberFindFirst.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", `http://localhost/api/tenant/members/${TARGET_USER_ID}/clear-lockout`),
      createParams({ userId: TARGET_USER_ID }),
    );
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("NOT_FOUND");
    expect(mockPrismaUserUpdate).not.toHaveBeenCalled();
  });

  it("returns 403 when ADMIN targets an OWNER (hierarchy)", async () => {
    mockRequireTenantPermission.mockResolvedValue({ ...ACTOR, role: "ADMIN" });
    mockIsTenantRoleAbove.mockReturnValue(false);
    mockPrismaTenantMemberFindFirst.mockResolvedValue({ role: "OWNER" });
    const res = await POST(
      createRequest("POST", `http://localhost/api/tenant/members/${TARGET_USER_ID}/clear-lockout`),
      createParams({ userId: TARGET_USER_ID }),
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("FORBIDDEN");
    expect(mockPrismaUserUpdate).not.toHaveBeenCalled();
  });

  it("OWNER clears own lockout -> 200 (self-exemption, hierarchy bypassed)", async () => {
    mockRequireTenantPermission.mockResolvedValue({ ...ACTOR, role: "OWNER" });
    // isTenantRoleAbove would return false for equal roles; the self-target
    // branch must skip the hierarchy check entirely, never calling it.
    mockIsTenantRoleAbove.mockReturnValue(false);
    mockPrismaTenantMemberFindFirst.mockResolvedValue({ role: "OWNER" });
    const res = await POST(
      createRequest("POST", `http://localhost/api/tenant/members/${ACTOR_USER_ID}/clear-lockout`),
      createParams({ userId: ACTOR_USER_ID }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(mockIsTenantRoleAbove).not.toHaveBeenCalled();
  });

  it("ADMIN clears own lockout -> 200 (self-exemption)", async () => {
    mockRequireTenantPermission.mockResolvedValue({ ...ACTOR, role: "ADMIN", userId: ACTOR_USER_ID });
    mockIsTenantRoleAbove.mockReturnValue(false);
    mockPrismaTenantMemberFindFirst.mockResolvedValue({ role: "ADMIN" });
    const res = await POST(
      createRequest("POST", `http://localhost/api/tenant/members/${ACTOR_USER_ID}/clear-lockout`),
      createParams({ userId: ACTOR_USER_ID }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });

  it("returns 404 for a cross-tenant target (not found in actor's tenant)", async () => {
    mockPrismaTenantMemberFindFirst.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", `http://localhost/api/tenant/members/${TARGET_USER_ID}/clear-lockout`),
      createParams({ userId: TARGET_USER_ID }),
    );
    expect(res.status).toBe(404);
    expect(mockPrismaTenantMemberFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: TENANT_ID, userId: TARGET_USER_ID }),
      }),
    );
  });

  it("returns 403 from step-up gate and does not clear lockout", async () => {
    mockRequireRecentSession.mockResolvedValueOnce(
      Response.json({ error: "SESSION_STEP_UP_REQUIRED" }, { status: 403 }),
    );
    const res = await POST(
      createRequest("POST", `http://localhost/api/tenant/members/${TARGET_USER_ID}/clear-lockout`),
      createParams({ userId: TARGET_USER_ID }),
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("SESSION_STEP_UP_REQUIRED");
    expect(mockPrismaUserUpdate).not.toHaveBeenCalled();
  });

  it("returns 429 when admin rate limit is exceeded", async () => {
    mockAdminLimiterCheck.mockResolvedValue({ allowed: false });
    mockTargetLimiterCheck.mockResolvedValue({ allowed: true });
    const res = await POST(
      createRequest("POST", `http://localhost/api/tenant/members/${TARGET_USER_ID}/clear-lockout`),
      createParams({ userId: TARGET_USER_ID }),
    );
    expect(res.status).toBe(429);
    expect(mockPrismaUserUpdate).not.toHaveBeenCalled();
  });

  it("returns 429 when target rate limit is exceeded", async () => {
    mockAdminLimiterCheck.mockResolvedValue({ allowed: true });
    mockTargetLimiterCheck.mockResolvedValue({ allowed: false });
    const res = await POST(
      createRequest("POST", `http://localhost/api/tenant/members/${TARGET_USER_ID}/clear-lockout`),
      createParams({ userId: TARGET_USER_ID }),
    );
    expect(res.status).toBe(429);
    expect(mockPrismaUserUpdate).not.toHaveBeenCalled();
  });

  it("fails closed (503, no mutation) when Redis is unavailable — admin limiter", async () => {
    await assertRedisFailClosed({
      invoke: () =>
        POST(
          createRequest("POST", `http://localhost/api/tenant/members/${TARGET_USER_ID}/clear-lockout`),
          createParams({ userId: TARGET_USER_ID }),
        ),
      limiter: adminLockoutClearLimiter,
      expectation: { envelope: "canonical" },
      assertNoMutation: [mockPrismaUserUpdate],
      limiterFactory: adminLimiterFactorySnapshot.replay(),
      failure: { allowed: false, redisErrored: true },
    });
  });

  it("fails closed (503, no mutation) when Redis is unavailable — target limiter", async () => {
    mockAdminLimiterCheck.mockResolvedValue({ allowed: true });
    await assertRedisFailClosed({
      invoke: () =>
        POST(
          createRequest("POST", `http://localhost/api/tenant/members/${TARGET_USER_ID}/clear-lockout`),
          createParams({ userId: TARGET_USER_ID }),
        ),
      limiter: targetLockoutClearLimiter,
      expectation: { envelope: "canonical" },
      assertNoMutation: [mockPrismaUserUpdate],
      limiterFactory: targetLimiterFactorySnapshot.replay(),
      failure: { allowed: false, redisErrored: true },
    });
  });

  it("success clears all three lockout fields and emits audit", async () => {
    const res = await POST(
      createRequest("POST", `http://localhost/api/tenant/members/${TARGET_USER_ID}/clear-lockout`),
      createParams({ userId: TARGET_USER_ID }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);

    expect(mockPrismaUserUpdate).toHaveBeenCalledWith({
      where: { id: TARGET_USER_ID },
      data: {
        failedUnlockAttempts: 0,
        accountLockedUntil: null,
        lastFailedUnlockAt: null,
      },
    });

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "TENANT_MEMBER_LOCKOUT_CLEAR",
        userId: ACTOR_USER_ID,
        tenantId: TENANT_ID,
        targetType: "User",
        targetId: TARGET_USER_ID,
      }),
    );
  });

  it("only checks the two lockout-clear limiters, never a vault_unlock-keyed one", async () => {
    // Route-level regression pin: the two rl:lockout_clear_* keys are checked,
    // and no call uses a rl:vault_unlock:* key — the independent vault-unlock
    // throttle (account-lockout.ts) must survive an admin lockout clear.
    await POST(
      createRequest("POST", `http://localhost/api/tenant/members/${TARGET_USER_ID}/clear-lockout`),
      createParams({ userId: TARGET_USER_ID }),
    );
    expect(mockAdminLimiterCheck).toHaveBeenCalledWith(`rl:lockout_clear_admin:${ACTOR_USER_ID}`);
    expect(mockTargetLimiterCheck).toHaveBeenCalledWith(`rl:lockout_clear_target:${TARGET_USER_ID}`);
    const allCalledKeys = [
      ...mockAdminLimiterCheck.mock.calls.map((c) => c[0]),
      ...mockTargetLimiterCheck.mock.calls.map((c) => c[0]),
    ];
    expect(allCalledKeys.every((k) => !String(k).includes("vault_unlock"))).toBe(true);
  });
});
