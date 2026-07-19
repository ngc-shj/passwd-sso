import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";
import { assertRedisFailClosed, snapshotFactory } from "@/__tests__/helpers/fail-closed";

const {
  mockAuth,
  mockPrismaAdminVaultResetFindFirst,
  mockPrismaAdminVaultResetUpdateMany,
  mockPrismaTenantMemberFindFirst,
  mockActorLimiterCheck,
  mockTargetLimiterCheck,
  mockCreateRateLimiter,
  mockLogAudit,
  mockCreateNotification,
  mockSendEmail,
  mockAdminVaultResetEmail,
  mockServerAppUrl,
  mockResolveUserLocale,
  mockRequireTenantPermission,
  mockIsTenantRoleAbove,
  mockWithTenantRls,
  mockNotificationTitle,
  mockNotificationBody,
  mockDecryptResetToken,
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
  const mockActorLimiterCheck = vi.fn();
  const mockTargetLimiterCheck = vi.fn();
  return {
    mockAuth: vi.fn(),
    mockPrismaAdminVaultResetFindFirst: vi.fn(),
    mockPrismaAdminVaultResetUpdateMany: vi.fn(),
    mockPrismaTenantMemberFindFirst: vi.fn(),
    mockActorLimiterCheck,
    mockTargetLimiterCheck,
    // Recording factory — creation order matches route.ts: approveLimiter
    // (:47) THEN approveTargetLimiter (:55). assertRedisFailClosed's
    // factory-attribution step reads mockCreateRateLimiter.mock.{calls,results}.
    mockCreateRateLimiter: vi
      .fn()
      .mockImplementationOnce((_opts: unknown) => ({ check: mockActorLimiterCheck, clear: vi.fn() }))
      .mockImplementationOnce((_opts: unknown) => ({ check: mockTargetLimiterCheck, clear: vi.fn() })),
    mockLogAudit: vi.fn(),
    mockCreateNotification: vi.fn(),
    mockSendEmail: vi.fn(),
    mockAdminVaultResetEmail: vi.fn(),
    mockServerAppUrl: vi.fn(),
    mockResolveUserLocale: vi.fn(),
    mockRequireTenantPermission: vi.fn(),
    mockIsTenantRoleAbove: vi.fn(),
    mockWithTenantRls: vi.fn((p: unknown, _t: unknown, fn: (tx: unknown) => unknown) => fn(p)),
    mockNotificationTitle: vi.fn(),
    mockNotificationBody: vi.fn(),
    mockDecryptResetToken: vi.fn(),
    mockRequireRecentSession: vi.fn(),
    TenantAuthError: _TenantAuthError,
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    adminVaultReset: {
      findFirst: mockPrismaAdminVaultResetFindFirst,
      updateMany: mockPrismaAdminVaultResetUpdateMany,
    },
    tenantMember: {
      findFirst: mockPrismaTenantMemberFindFirst,
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
vi.mock("@/lib/notification", () => ({ createNotification: mockCreateNotification }));
vi.mock("@/lib/email", () => ({ sendEmail: mockSendEmail }));
vi.mock("@/lib/email/templates/admin-vault-reset", () => ({
  adminVaultResetEmail: mockAdminVaultResetEmail,
}));
vi.mock("@/lib/url-helpers", () => ({ serverAppUrl: mockServerAppUrl }));
vi.mock("@/lib/locale", () => ({ resolveUserLocale: mockResolveUserLocale }));
vi.mock("@/lib/auth/access/tenant-auth", () => ({
  requireTenantPermission: mockRequireTenantPermission,
  TenantAuthError,
}));
// isTenantRoleAbove is now imported via the pure tenant-role-hierarchy
// module (so client bundles don't drag in pg/prisma). The approve route
// reaches it transitively via admin-reset-eligibility — mock it at the
// pure module to control the role-hierarchy branch.
vi.mock("@/lib/auth/access/tenant-role-hierarchy", () => ({
  isTenantRoleAbove: mockIsTenantRoleAbove,
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: mockWithTenantRls,
  withBypassRls: vi.fn((p: unknown, fn: (tx: unknown) => unknown) => fn(p)),
}));
vi.mock("@/lib/notification/notification-messages", () => ({
  notificationTitle: mockNotificationTitle,
  notificationBody: mockNotificationBody,
}));
vi.mock("@/lib/vault/admin-reset-token-crypto", () => ({
  decryptResetToken: mockDecryptResetToken,
}));
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: mockRequireRecentSession,
}));
vi.mock("@/lib/logger", () => ({
  default: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { POST } from "./route";

// Module-scope snapshot (route.ts:47 `const approveLimiter = createRateLimiter(...)`
// then :55 `const approveTargetLimiter = createRateLimiter(...)` run at
// import time, above, in that order — matches mockCreateRateLimiter's two
// queued implementations). See fail-closed.ts module doc.
const approveLimiterFactorySnapshot = snapshotFactory(mockCreateRateLimiter);
const approveLimiter = mockCreateRateLimiter.mock.results[0]!.value as {
  check: typeof mockActorLimiterCheck;
};
const approveTargetLimiterFactorySnapshot = snapshotFactory(mockCreateRateLimiter);
const approveTargetLimiter = mockCreateRateLimiter.mock.results[1]!.value as {
  check: typeof mockTargetLimiterCheck;
};

const TENANT_ID = "tenant-1";
const TARGET_USER_ID = "user-target";
const ACTOR_USER_ID = "actor-approver";
const INITIATOR_ID = "initiator-1";
const RESET_ID = "reset-1";
const TARGET_EMAIL = "target@example.com";

const ACTOR = {
  id: "membership-actor",
  tenantId: TENANT_ID,
  userId: ACTOR_USER_ID,
  role: "OWNER",
};

const TARGET_MEMBER = {
  id: "membership-target",
  tenantId: TENANT_ID,
  userId: TARGET_USER_ID,
  role: "MEMBER",
  user: {
    id: TARGET_USER_ID,
    email: TARGET_EMAIL,
    name: "Target User",
    locale: null,
  },
};

const RESET_RECORD = {
  id: RESET_ID,
  tenantId: TENANT_ID,
  teamId: null,
  targetUserId: TARGET_USER_ID,
  initiatedById: INITIATOR_ID,
  tokenHash: "hash",
  encryptedToken: "psoenc1:0:cipher",
  targetEmailAtInitiate: TARGET_EMAIL,
  approvedAt: null,
  approvedById: null,
  executedAt: null,
  revokedAt: null,
  createdAt: new Date(Date.now() - 60_000),
  expiresAt: new Date(Date.now() + 23 * 60 * 60_000),
};

function buildReq() {
  return createRequest(
    "POST",
    `http://localhost/api/tenant/members/${TARGET_USER_ID}/reset-vault/${RESET_ID}/approve`,
  );
}

function buildParams() {
  return createParams({ userId: TARGET_USER_ID, resetId: RESET_ID });
}

describe("POST /api/tenant/members/[userId]/reset-vault/[resetId]/approve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({
      user: {
        id: ACTOR_USER_ID,
        name: "Approver",
        email: "approver@example.com",
      },
    });
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockIsTenantRoleAbove.mockReturnValue(true);
    // Step-up passes by default (null = recent enough). Denial tests override.
    mockRequireRecentSession.mockResolvedValue(null);
    mockPrismaAdminVaultResetFindFirst.mockResolvedValue(RESET_RECORD);
    mockPrismaTenantMemberFindFirst.mockResolvedValue(TARGET_MEMBER);
    mockPrismaAdminVaultResetUpdateMany.mockResolvedValue({ count: 1 });
    mockActorLimiterCheck.mockResolvedValue({ allowed: true });
    mockTargetLimiterCheck.mockResolvedValue({ allowed: true });
    mockResolveUserLocale.mockReturnValue("en");
    mockServerAppUrl.mockReturnValue("http://localhost/en/vault-reset/admin");
    mockDecryptResetToken.mockReturnValue("plaintext-token");
    mockAdminVaultResetEmail.mockReturnValue({
      subject: "Vault reset initiated by an admin",
      html: "<p>Reset</p>",
      text: "Reset",
    });
    mockNotificationTitle.mockReturnValue("Vault reset initiated");
    mockNotificationBody.mockReturnValue(
      "A tenant admin has initiated a vault reset for your account.",
    );
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(buildReq(), buildParams());
    expect(res.status).toBe(401);
  });

  it("returns 403 when lacking MEMBER_VAULT_RESET permission", async () => {
    mockRequireTenantPermission.mockRejectedValue(
      new TenantAuthError("FORBIDDEN", 403),
    );
    const res = await POST(buildReq(), buildParams());
    expect(res.status).toBe(403);
  });

  it("returns 404 when reset record does not exist", async () => {
    mockPrismaAdminVaultResetFindFirst.mockResolvedValue(null);
    const res = await POST(buildReq(), buildParams());
    expect(res.status).toBe(404);
  });

  it("returns 403 when actor is the initiator (self-approval blocked at app level)", async () => {
    mockPrismaAdminVaultResetFindFirst.mockResolvedValue({
      ...RESET_RECORD,
      initiatedById: ACTOR_USER_ID,
    });
    const res = await POST(buildReq(), buildParams());
    expect(res.status).toBe(403);
    expect(mockPrismaAdminVaultResetUpdateMany).not.toHaveBeenCalled();
    // Forensic audit row emitted with FORBIDDEN_SELF_APPROVAL cause for
    // incident-response visibility (suspicious-behavior signal).
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ADMIN_VAULT_RESET_APPROVE",
        targetId: TARGET_USER_ID,
        metadata: expect.objectContaining({
          cause: "FORBIDDEN_SELF_APPROVAL",
        }),
      }),
    );
  });

  it("returns 404 when target member is not found in tenant", async () => {
    mockPrismaTenantMemberFindFirst.mockResolvedValue(null);
    const res = await POST(buildReq(), buildParams());
    expect(res.status).toBe(404);
  });

  it("returns 403 FORBIDDEN_INSUFFICIENT_ROLE when actor's role is not above target's", async () => {
    mockIsTenantRoleAbove.mockReturnValue(false);
    const res = await POST(buildReq(), buildParams());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("FORBIDDEN_INSUFFICIENT_ROLE");
    expect(mockPrismaAdminVaultResetUpdateMany).not.toHaveBeenCalled();
  });

  it("returns 409 RESET_TARGET_EMAIL_CHANGED when email differs since initiate (FR12)", async () => {
    mockPrismaTenantMemberFindFirst.mockResolvedValue({
      ...TARGET_MEMBER,
      user: { ...TARGET_MEMBER.user, email: "new-email@example.com" },
    });
    const res = await POST(buildReq(), buildParams());
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("RESET_TARGET_EMAIL_CHANGED");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ADMIN_VAULT_RESET_APPROVE",
        metadata: expect.objectContaining({
          cause: "RESET_TARGET_EMAIL_CHANGED",
        }),
      }),
    );
    expect(mockPrismaAdminVaultResetUpdateMany).not.toHaveBeenCalled();
  });

  it("returns step-up Response and performs no privileged work when session is stale (M1, RT8)", async () => {
    mockRequireRecentSession.mockResolvedValueOnce(
      Response.json({ error: "SESSION_STEP_UP_REQUIRED" }, { status: 403 }),
    );

    const res = await POST(buildReq(), buildParams());

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("SESSION_STEP_UP_REQUIRED");

    // RT8: every guarded side effect must be skipped on the denial path.
    // The gate sits before the rate-limit block, so the limiter is untouched
    // (a stale session must not burn the low per-target cap — griefing lever).
    expect(mockActorLimiterCheck).not.toHaveBeenCalled();
    expect(mockTargetLimiterCheck).not.toHaveBeenCalled();
    expect(mockDecryptResetToken).not.toHaveBeenCalled();
    expect(mockPrismaAdminVaultResetUpdateMany).not.toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("does not invoke step-up before authz/eligibility checks (M1 ordering)", async () => {
    // A wrong-role attempt must 403 on eligibility WITHOUT prompting reauth.
    mockIsTenantRoleAbove.mockReturnValue(false);
    const res = await POST(buildReq(), buildParams());
    expect(res.status).toBe(403);
    expect(mockRequireRecentSession).not.toHaveBeenCalled();
  });

  it("returns 429 when actor rate limit is exceeded", async () => {
    mockActorLimiterCheck.mockResolvedValueOnce({ allowed: false, retryAfterMs: 5_000 });
    mockTargetLimiterCheck.mockResolvedValueOnce({ allowed: true });
    const res = await POST(buildReq(), buildParams());
    expect(res.status).toBe(429);
  });

  it("returns 429 when target rate limit is exceeded", async () => {
    mockActorLimiterCheck.mockResolvedValueOnce({ allowed: true });
    mockTargetLimiterCheck.mockResolvedValueOnce({ allowed: false, retryAfterMs: 5_000 });
    const res = await POST(buildReq(), buildParams());
    expect(res.status).toBe(429);
  });

  it("fails closed (503, no mutation) when Redis is unavailable — actor limiter", async () => {
    await assertRedisFailClosed({
      invoke: () => POST(buildReq(), buildParams()),
      limiter: approveLimiter,
      expectation: { envelope: "canonical" },
      assertNoMutation: [mockPrismaAdminVaultResetUpdateMany, mockCreateNotification],
      limiterFactory: approveLimiterFactorySnapshot.replay(),
      failure: { allowed: false, redisErrored: true },
    });
  });

  it("fails closed (503, no mutation) when Redis is unavailable — target limiter", async () => {
    mockActorLimiterCheck.mockResolvedValue({ allowed: true });
    await assertRedisFailClosed({
      invoke: () => POST(buildReq(), buildParams()),
      limiter: approveTargetLimiter,
      expectation: { envelope: "canonical" },
      assertNoMutation: [mockPrismaAdminVaultResetUpdateMany, mockCreateNotification],
      limiterFactory: approveTargetLimiterFactorySnapshot.replay(),
      failure: { allowed: false, redisErrored: true },
    });
  });

  it("returns 409 RESET_NOT_APPROVABLE when decrypt fails (F7) and leaves row unchanged", async () => {
    mockDecryptResetToken.mockImplementation(() => {
      throw new Error("decrypt failed");
    });
    const res = await POST(buildReq(), buildParams());
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("RESET_NOT_APPROVABLE");
    // Row was NOT touched.
    expect(mockPrismaAdminVaultResetUpdateMany).not.toHaveBeenCalled();
    // Audit metadata records the coarse cause only (S16) — no leak of the
    // underlying decrypt error message.
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ADMIN_VAULT_RESET_APPROVE",
        metadata: expect.objectContaining({
          resetId: RESET_ID,
          cause: "RESET_NOT_APPROVABLE",
        }),
      }),
    );
  });

  it("returns 409 RESET_NOT_APPROVABLE for legacy row with null encryptedToken", async () => {
    mockPrismaAdminVaultResetFindFirst.mockResolvedValue({
      ...RESET_RECORD,
      encryptedToken: null,
    });
    const res = await POST(buildReq(), buildParams());
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("RESET_NOT_APPROVABLE");
    expect(mockPrismaAdminVaultResetUpdateMany).not.toHaveBeenCalled();
  });

  it("returns 409 RESET_NOT_APPROVABLE when CAS race is lost (count = 0)", async () => {
    mockPrismaAdminVaultResetUpdateMany.mockResolvedValue({ count: 0 });
    const res = await POST(buildReq(), buildParams());
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("RESET_NOT_APPROVABLE");
    // Notification + email NOT sent on race-loss.
    expect(mockCreateNotification).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("approves: CAS WHERE includes load-bearing self-approval guard + state checks", async () => {
    await POST(buildReq(), buildParams());
    expect(mockPrismaAdminVaultResetUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: RESET_ID,
          tenantId: TENANT_ID,
          targetUserId: TARGET_USER_ID,
          approvedAt: null,
          executedAt: null,
          revokedAt: null,
          expiresAt: { gt: expect.any(Date) },
          initiatedById: { not: ACTOR_USER_ID },
        }),
        data: expect.objectContaining({
          approvedAt: expect.any(Date),
          approvedById: ACTOR_USER_ID,
          expiresAt: expect.any(Date),
        }),
      }),
    );
  });

  it("happy path: returns 200, sends email + notification to target, emits audit", async () => {
    const res = await POST(buildReq(), buildParams());
    expect(res.status).toBe(200);

    // Decrypt called with AAD pieces.
    expect(mockDecryptResetToken).toHaveBeenCalledWith(
      "psoenc1:0:cipher",
      expect.objectContaining({
        tenantId: TENANT_ID,
        resetId: RESET_ID,
        targetEmailAtInitiate: TARGET_EMAIL,
      }),
    );

    // Target receives in-app notification.
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: TARGET_USER_ID,
        tenantId: TENANT_ID,
        type: "ADMIN_VAULT_RESET",
      }),
    );

    // Email sent to target with token in URL fragment.
    expect(mockAdminVaultResetEmail).toHaveBeenCalled();
    const emailCall = mockAdminVaultResetEmail.mock.calls[0];
    expect(emailCall[2]).toContain("#token=plaintext-token");
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: TARGET_EMAIL }),
    );

    // Audit metadata records initiator + target + new expiresAt.
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ADMIN_VAULT_RESET_APPROVE",
        userId: ACTOR_USER_ID,
        tenantId: TENANT_ID,
        targetType: "User",
        targetId: TARGET_USER_ID,
        metadata: expect.objectContaining({
          resetId: RESET_ID,
          initiatedById: INITIATOR_ID,
          targetUserId: TARGET_USER_ID,
          newExpiresAt: expect.any(String),
        }),
      }),
    );
  });

  it("AAD-binding: decrypt receives the row's targetEmailAtInitiate, not the current member email (N7)", async () => {
    // Simulate a row whose targetEmailAtInitiate differs from the current
    // member email, then have the decrypt-in-prod fail because AAD bytes
    // would not match. The pre-check (FR12 snapshot) catches this earlier;
    // this test asserts that ordering: when the snapshot still matches the
    // row, decrypt is called with the SNAPSHOT, not the current member's
    // email.
    const ROW_EMAIL = "snapshot@example.com";
    mockPrismaAdminVaultResetFindFirst.mockResolvedValue({
      ...RESET_RECORD,
      targetEmailAtInitiate: ROW_EMAIL,
    });
    mockPrismaTenantMemberFindFirst.mockResolvedValue({
      ...TARGET_MEMBER,
      user: { ...TARGET_MEMBER.user, email: ROW_EMAIL },
    });
    await POST(buildReq(), buildParams());
    expect(mockDecryptResetToken).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ targetEmailAtInitiate: ROW_EMAIL }),
    );
  });
});
