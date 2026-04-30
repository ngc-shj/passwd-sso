import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const {
  mockAuth,
  mockPrismaAdminVaultResetFindFirst,
  mockPrismaAdminVaultResetUpdateMany,
  mockPrismaTenantMemberFindFirst,
  mockRateLimiterCheck,
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
    mockPrismaAdminVaultResetFindFirst: vi.fn(),
    mockPrismaAdminVaultResetUpdateMany: vi.fn(),
    mockPrismaTenantMemberFindFirst: vi.fn(),
    mockRateLimiterCheck: vi.fn(),
    mockLogAudit: vi.fn(),
    mockCreateNotification: vi.fn(),
    mockSendEmail: vi.fn(),
    mockAdminVaultResetEmail: vi.fn(),
    mockServerAppUrl: vi.fn(),
    mockResolveUserLocale: vi.fn(),
    mockRequireTenantPermission: vi.fn(),
    mockIsTenantRoleAbove: vi.fn(),
    mockWithTenantRls: vi.fn((_p: unknown, _t: unknown, fn: () => unknown) => fn()),
    mockNotificationTitle: vi.fn(),
    mockNotificationBody: vi.fn(),
    mockDecryptResetToken: vi.fn(),
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
  createRateLimiter: vi.fn(() => ({ check: mockRateLimiterCheck })),
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
  isTenantRoleAbove: mockIsTenantRoleAbove,
  TenantAuthError,
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: mockWithTenantRls,
  withBypassRls: vi.fn((_p: unknown, fn: () => unknown) => fn()),
}));
vi.mock("@/lib/notification/notification-messages", () => ({
  notificationTitle: mockNotificationTitle,
  notificationBody: mockNotificationBody,
}));
vi.mock("@/lib/vault/admin-reset-token-crypto", () => ({
  decryptResetToken: mockDecryptResetToken,
}));
vi.mock("@/lib/logger", () => ({
  default: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { POST } from "./route";

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
    mockPrismaAdminVaultResetFindFirst.mockResolvedValue(RESET_RECORD);
    mockPrismaTenantMemberFindFirst.mockResolvedValue(TARGET_MEMBER);
    mockPrismaAdminVaultResetUpdateMany.mockResolvedValue({ count: 1 });
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
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
  });

  it("returns 404 when target member is not found in tenant", async () => {
    mockPrismaTenantMemberFindFirst.mockResolvedValue(null);
    const res = await POST(buildReq(), buildParams());
    expect(res.status).toBe(404);
  });

  it("returns 403 when actor's role is not above target's", async () => {
    mockIsTenantRoleAbove.mockReturnValue(false);
    const res = await POST(buildReq(), buildParams());
    expect(res.status).toBe(403);
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

  it("returns 429 when actor rate limit is exceeded", async () => {
    mockRateLimiterCheck
      .mockResolvedValueOnce({ allowed: false, retryAfterMs: 5_000 })
      .mockResolvedValueOnce({ allowed: true });
    const res = await POST(buildReq(), buildParams());
    expect(res.status).toBe(429);
  });

  it("returns 429 when target rate limit is exceeded", async () => {
    mockRateLimiterCheck
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({ allowed: false, retryAfterMs: 5_000 });
    const res = await POST(buildReq(), buildParams());
    expect(res.status).toBe(429);
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
