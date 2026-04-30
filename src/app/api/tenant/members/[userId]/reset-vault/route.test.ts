import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const {
  mockAuth,
  mockPrismaTenantMemberFindFirst,
  mockPrismaTenantMemberFindMany,
  mockPrismaAdminVaultResetCount,
  mockPrismaAdminVaultResetCreate,
  mockPrismaAdminVaultResetFindMany,
  mockRateLimiterCheck,
  mockLogAudit,
  mockCreateNotification,
  mockSendEmail,
  mockAdminVaultResetPendingEmail,
  mockResolveUserLocale,
  mockRequireTenantPermission,
  mockIsTenantRoleAbove,
  mockWithTenantRls,
  mockNotificationTitle,
  mockNotificationBody,
  mockEncryptResetToken,
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
    mockPrismaTenantMemberFindFirst: vi.fn(),
    mockPrismaTenantMemberFindMany: vi.fn(),
    mockPrismaAdminVaultResetCount: vi.fn(),
    mockPrismaAdminVaultResetCreate: vi.fn(),
    mockPrismaAdminVaultResetFindMany: vi.fn(),
    mockRateLimiterCheck: vi.fn(),
    mockLogAudit: vi.fn(),
    mockCreateNotification: vi.fn(),
    mockSendEmail: vi.fn(),
    mockAdminVaultResetPendingEmail: vi.fn(),
    mockResolveUserLocale: vi.fn(),
    mockRequireTenantPermission: vi.fn(),
    mockIsTenantRoleAbove: vi.fn(),
    // The route uses both signatures: `withTenantRls(prisma, tenantId, () => ...)`
    // for single-call paths and `withTenantRls(prisma, tenantId, async (tx) => ...)`
    // for the GET handler's combined fetch. Pass the mocked prisma as `tx` so
    // either form resolves correctly under test.
    mockWithTenantRls: vi.fn(
      (p: unknown, _t: unknown, fn: (tx: unknown) => unknown) => fn(p),
    ),
    mockNotificationTitle: vi.fn(),
    mockNotificationBody: vi.fn(),
    mockEncryptResetToken: vi.fn(),
    TenantAuthError: _TenantAuthError,
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantMember: {
      findFirst: mockPrismaTenantMemberFindFirst,
      findMany: mockPrismaTenantMemberFindMany,
    },
    adminVaultReset: {
      count: mockPrismaAdminVaultResetCount,
      create: mockPrismaAdminVaultResetCreate,
      findMany: mockPrismaAdminVaultResetFindMany,
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
vi.mock("@/lib/email/templates/admin-vault-reset-pending", () => ({
  adminVaultResetPendingEmail: mockAdminVaultResetPendingEmail,
}));
vi.mock("@/lib/locale", () => ({ resolveUserLocale: mockResolveUserLocale }));
vi.mock("@/lib/vault/admin-reset-token-crypto", () => ({
  encryptResetToken: mockEncryptResetToken,
}));
vi.mock("@/lib/auth/access/tenant-auth", () => ({
  requireTenantPermission: mockRequireTenantPermission,
  isTenantRoleAbove: mockIsTenantRoleAbove,
  TenantAuthError,
}));
// admin-reset-eligibility imports isTenantRoleAbove from the pure
// hierarchy module (to avoid pulling pg into client bundles). Mock both
// paths against the same vi.fn() so role-hierarchy stubs apply uniformly.
vi.mock("@/lib/auth/access/tenant-role-hierarchy", () => ({
  isTenantRoleAbove: mockIsTenantRoleAbove,
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: mockWithTenantRls,
  withBypassRls: vi.fn((_p: unknown, fn: () => unknown) => fn()),
}));
vi.mock("@/lib/notification/notification-messages", () => ({
  notificationTitle: mockNotificationTitle,
  notificationBody: mockNotificationBody,
}));
vi.mock("@/lib/logger", () => ({
  default: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { POST, GET } from "./route";
import { MS_PER_DAY } from "@/lib/constants/time";

const TENANT_ID = "tenant-1";
const TARGET_USER_ID = "user-target";
const ACTOR_USER_ID = "test-user-id";

const ACTOR = {
  id: "membership-owner",
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
    email: "target@example.com",
    name: "Target User",
    locale: null,
  },
};

describe("POST /api/tenant/members/[userId]/reset-vault", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: ACTOR_USER_ID, name: "Admin User", email: "admin@example.com" } });
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockIsTenantRoleAbove.mockReturnValue(true);
    mockPrismaTenantMemberFindFirst.mockResolvedValue(TARGET_MEMBER);
    // Default: one other admin eligible to approve.
    mockPrismaTenantMemberFindMany.mockResolvedValue([
      {
        id: "membership-other-admin",
        tenantId: TENANT_ID,
        userId: "other-admin",
        role: "ADMIN",
        user: {
          id: "other-admin",
          email: "other-admin@example.com",
          name: "Other Admin",
          locale: null,
        },
      },
    ]);
    mockPrismaAdminVaultResetCount.mockResolvedValue(0);
    mockPrismaAdminVaultResetCreate.mockImplementation(({ data }) =>
      Promise.resolve({ id: data.id ?? "reset-1" }),
    );
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
    mockResolveUserLocale.mockReturnValue("en");
    mockEncryptResetToken.mockReturnValue("psoenc1:0:cipher");
    mockAdminVaultResetPendingEmail.mockReturnValue({
      subject: "Vault reset awaiting approval",
      html: "<p>Pending</p>",
      text: "Pending",
    });
    mockNotificationTitle.mockReturnValue("Vault reset awaiting approval");
    mockNotificationBody.mockReturnValue(
      "An admin has initiated a vault reset for target@example.com.",
    );
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", `http://localhost/api/tenant/members/${TARGET_USER_ID}/reset-vault`),
      createParams({ userId: TARGET_USER_ID }),
    );
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 403 when lacking MEMBER_VAULT_RESET permission", async () => {
    mockRequireTenantPermission.mockRejectedValue(new TenantAuthError("FORBIDDEN", 403));
    const res = await POST(
      createRequest("POST", `http://localhost/api/tenant/members/${TARGET_USER_ID}/reset-vault`),
      createParams({ userId: TARGET_USER_ID }),
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("FORBIDDEN");
  });

  it("rethrows non-TenantAuthError errors from permission check", async () => {
    mockRequireTenantPermission.mockRejectedValue(new Error("unexpected db error"));
    await expect(
      POST(
        createRequest("POST", `http://localhost/api/tenant/members/${TARGET_USER_ID}/reset-vault`),
        createParams({ userId: TARGET_USER_ID }),
      ),
    ).rejects.toThrow("unexpected db error");
  });

  it("returns 403 when trying to reset own vault", async () => {
    const res = await POST(
      createRequest("POST", `http://localhost/api/tenant/members/${ACTOR_USER_ID}/reset-vault`),
      createParams({ userId: ACTOR_USER_ID }),
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("FORBIDDEN");
  });

  it("returns 404 when target member not found in tenant", async () => {
    mockPrismaTenantMemberFindFirst.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", `http://localhost/api/tenant/members/${TARGET_USER_ID}/reset-vault`),
      createParams({ userId: TARGET_USER_ID }),
    );
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("NOT_FOUND");
  });

  it("returns 403 when ADMIN tries to reset another ADMIN (isTenantRoleAbove returns false)", async () => {
    mockRequireTenantPermission.mockResolvedValue({ ...ACTOR, role: "ADMIN" });
    mockIsTenantRoleAbove.mockReturnValue(false);
    mockPrismaTenantMemberFindFirst.mockResolvedValue({
      ...TARGET_MEMBER,
      role: "ADMIN",
    });
    const res = await POST(
      createRequest("POST", `http://localhost/api/tenant/members/${TARGET_USER_ID}/reset-vault`),
      createParams({ userId: TARGET_USER_ID }),
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("FORBIDDEN");
  });

  it("returns 429 when admin rate limit is exceeded", async () => {
    // First call (admin limiter) returns false, second (target limiter) returns true
    mockRateLimiterCheck
      .mockResolvedValueOnce({ allowed: false })
      .mockResolvedValueOnce({ allowed: true });
    const res = await POST(
      createRequest("POST", `http://localhost/api/tenant/members/${TARGET_USER_ID}/reset-vault`),
      createParams({ userId: TARGET_USER_ID }),
    );
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.error).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("returns 429 when target rate limit is exceeded", async () => {
    // First call (admin limiter) returns true, second (target limiter) returns false
    mockRateLimiterCheck
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({ allowed: false });
    const res = await POST(
      createRequest("POST", `http://localhost/api/tenant/members/${TARGET_USER_ID}/reset-vault`),
      createParams({ userId: TARGET_USER_ID }),
    );
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.error).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("returns 429 when max pending resets (3) reached", async () => {
    mockPrismaAdminVaultResetCount.mockResolvedValue(3);
    const res = await POST(
      createRequest("POST", `http://localhost/api/tenant/members/${TARGET_USER_ID}/reset-vault`),
      createParams({ userId: TARGET_USER_ID }),
    );
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.error).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("returns 200, stores encryptedToken + targetEmailAtInitiate, notifies other admins (NOT target)", async () => {
    const res = await POST(
      createRequest("POST", `http://localhost/api/tenant/members/${TARGET_USER_ID}/reset-vault`),
      createParams({ userId: TARGET_USER_ID }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);

    // Reset record stores encryptedToken + targetEmailAtInitiate snapshot.
    expect(mockPrismaAdminVaultResetCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          id: expect.any(String),
          tenantId: TENANT_ID,
          teamId: null,
          targetUserId: TARGET_USER_ID,
          initiatedById: ACTOR_USER_ID,
          tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          encryptedToken: "psoenc1:0:cipher",
          targetEmailAtInitiate: "target@example.com",
          expiresAt: expect.any(Date),
        }),
      }),
    );

    // encryptResetToken called with the AAD inputs (FR12).
    expect(mockEncryptResetToken).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        tenantId: TENANT_ID,
        resetId: expect.any(String),
        targetEmailAtInitiate: "target@example.com",
      }),
    );

    // Audit metadata includes resetId + expiresAt (F23).
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ADMIN_VAULT_RESET_INITIATE",
        userId: ACTOR_USER_ID,
        tenantId: TENANT_ID,
        targetType: "User",
        targetId: TARGET_USER_ID,
        metadata: expect.objectContaining({
          resetId: expect.any(String),
          expiresAt: expect.any(String),
        }),
      }),
    );

    // Target receives NOTHING at initiate (FR8).
    expect(mockCreateNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ userId: TARGET_USER_ID }),
    );
    expect(mockSendEmail).not.toHaveBeenCalledWith(
      expect.objectContaining({ to: "target@example.com" }),
    );

    // Eligible approver receives notification + email.
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "other-admin",
        tenantId: TENANT_ID,
        type: "ADMIN_VAULT_RESET_PENDING_APPROVAL",
      }),
    );
    expect(mockAdminVaultResetPendingEmail).toHaveBeenCalled();
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "other-admin@example.com",
        subject: "Vault reset awaiting approval",
      }),
    );

    expect(mockWithTenantRls).toHaveBeenCalledWith(
      expect.anything(),
      TENANT_ID,
      expect.any(Function),
    );
  });

  it("notifies zero approvers when no other admins exist (T10)", async () => {
    mockPrismaTenantMemberFindMany.mockResolvedValue([]);
    const res = await POST(
      createRequest("POST", `http://localhost/api/tenant/members/${TARGET_USER_ID}/reset-vault`),
      createParams({ userId: TARGET_USER_ID }),
    );
    expect(res.status).toBe(200);
    expect(mockCreateNotification).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("filters approvers to those whose role is above target's (S6)", async () => {
    // Other ADMIN (eligible) + a MEMBER (NOT eligible — role check uses the
    // mock; in the route the filter calls isTenantRoleAbove(member.role,
    // target.role)). The role-filter at DB-level already restricts to
    // OWNER/ADMIN; we additionally filter app-side.
    mockPrismaTenantMemberFindMany.mockResolvedValue([
      {
        id: "m-admin",
        tenantId: TENANT_ID,
        userId: "admin-1",
        role: "ADMIN",
        user: { id: "admin-1", email: "admin1@example.com", name: "A1", locale: null },
      },
      {
        id: "m-owner",
        tenantId: TENANT_ID,
        userId: "owner-2",
        role: "OWNER",
        user: { id: "owner-2", email: "owner2@example.com", name: "O2", locale: null },
      },
    ]);
    // isTenantRoleAbove called against target's MEMBER role: both ADMIN
    // and OWNER return true.
    mockIsTenantRoleAbove.mockReturnValue(true);
    const res = await POST(
      createRequest("POST", `http://localhost/api/tenant/members/${TARGET_USER_ID}/reset-vault`),
      createParams({ userId: TARGET_USER_ID }),
    );
    expect(res.status).toBe(200);
    expect(mockCreateNotification).toHaveBeenCalledTimes(2);
  });

  it("calls requireTenantPermission with MEMBER_VAULT_RESET permission", async () => {
    await POST(
      createRequest("POST", `http://localhost/api/tenant/members/${TARGET_USER_ID}/reset-vault`),
      createParams({ userId: TARGET_USER_ID }),
    );
    expect(mockRequireTenantPermission).toHaveBeenCalledWith(
      ACTOR_USER_ID,
      "tenant:member:vaultReset",
    );
  });

  it("returns 404 when target user has no email (FR12 snapshot guard)", async () => {
    mockPrismaTenantMemberFindFirst.mockResolvedValue({
      ...TARGET_MEMBER,
      user: { ...TARGET_MEMBER.user, email: null },
    });
    const res = await POST(
      createRequest("POST", `http://localhost/api/tenant/members/${TARGET_USER_ID}/reset-vault`),
      createParams({ userId: TARGET_USER_ID }),
    );
    expect(res.status).toBe(404);
    expect(mockPrismaAdminVaultResetCreate).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("skips email to approver when approver has no email but still notifies in-app", async () => {
    mockPrismaTenantMemberFindMany.mockResolvedValue([
      {
        id: "m-admin",
        tenantId: TENANT_ID,
        userId: "admin-no-email",
        role: "ADMIN",
        user: { id: "admin-no-email", email: null, name: "A", locale: null },
      },
    ]);
    const res = await POST(
      createRequest("POST", `http://localhost/api/tenant/members/${TARGET_USER_ID}/reset-vault`),
      createParams({ userId: TARGET_USER_ID }),
    );
    expect(res.status).toBe(200);
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

describe("GET /api/tenant/members/[userId]/reset-vault", () => {
  const PAST_DATE = new Date(Date.now() - 2 * MS_PER_DAY); // 2 days ago
  const FUTURE_DATE = new Date(Date.now() + MS_PER_DAY); // 1 day from now

  const BASE_RESET = {
    id: "reset-1",
    tenantId: TENANT_ID,
    targetUserId: TARGET_USER_ID,
    initiatedById: ACTOR_USER_ID,
    tokenHash: "abc123",
    targetEmailAtInitiate: "target@example.com",
    createdAt: new Date("2024-01-01T00:00:00Z"),
    expiresAt: FUTURE_DATE,
    approvedAt: null,
    approvedById: null,
    executedAt: null,
    revokedAt: null,
    initiatedBy: { id: ACTOR_USER_ID, name: "Admin User", email: "admin@example.com" },
    approvedBy: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: ACTOR_USER_ID } });
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockPrismaAdminVaultResetFindMany.mockResolvedValue([BASE_RESET]);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", `http://localhost/api/tenant/members/${TARGET_USER_ID}/reset-vault`),
      createParams({ userId: TARGET_USER_ID }),
    );
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 403 when lacking permission", async () => {
    mockRequireTenantPermission.mockRejectedValue(new TenantAuthError("FORBIDDEN", 403));
    const res = await GET(
      createRequest("GET", `http://localhost/api/tenant/members/${TARGET_USER_ID}/reset-vault`),
      createParams({ userId: TARGET_USER_ID }),
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("FORBIDDEN");
  });

  it("rethrows non-TenantAuthError errors from permission check", async () => {
    mockRequireTenantPermission.mockRejectedValue(new Error("unexpected"));
    await expect(
      GET(
        createRequest("GET", `http://localhost/api/tenant/members/${TARGET_USER_ID}/reset-vault`),
        createParams({ userId: TARGET_USER_ID }),
      ),
    ).rejects.toThrow("unexpected");
  });

  it("returns reset history with pending_approval status for active non-approved reset", async () => {
    const res = await GET(
      createRequest("GET", `http://localhost/api/tenant/members/${TARGET_USER_ID}/reset-vault`),
      createParams({ userId: TARGET_USER_ID }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveLength(1);
    expect(json[0]).toMatchObject({
      id: "reset-1",
      status: "pending_approval",
      approvedBy: null,
      targetEmailAtInitiate: "target@example.com",
      initiatedBy: { id: ACTOR_USER_ID, name: "Admin User", email: "admin@example.com" },
    });
    expect(mockWithTenantRls).toHaveBeenCalledWith(
      expect.anything(),
      TENANT_ID,
      expect.any(Function),
    );
  });

  it("derives approved status when approvedAt is set and not executed/revoked/expired", async () => {
    mockPrismaAdminVaultResetFindMany.mockResolvedValue([
      {
        ...BASE_RESET,
        approvedAt: new Date("2024-01-01T01:00:00Z"),
        approvedById: "approver-1",
        approvedBy: { id: "approver-1", name: "Approver", email: "approver@example.com" },
      },
    ]);
    const res = await GET(
      createRequest("GET", `http://localhost/api/tenant/members/${TARGET_USER_ID}/reset-vault`),
      createParams({ userId: TARGET_USER_ID }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json[0].status).toBe("approved");
    expect(json[0].approvedBy).toEqual({
      id: "approver-1",
      name: "Approver",
      email: "approver@example.com",
    });
  });

  it("derives executed status when executedAt is set", async () => {
    mockPrismaAdminVaultResetFindMany.mockResolvedValue([
      { ...BASE_RESET, executedAt: new Date("2024-01-02T00:00:00Z") },
    ]);
    const res = await GET(
      createRequest("GET", `http://localhost/api/tenant/members/${TARGET_USER_ID}/reset-vault`),
      createParams({ userId: TARGET_USER_ID }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json[0].status).toBe("executed");
  });

  it("derives revoked status when revokedAt is set", async () => {
    mockPrismaAdminVaultResetFindMany.mockResolvedValue([
      { ...BASE_RESET, revokedAt: new Date("2024-01-02T00:00:00Z") },
    ]);
    const res = await GET(
      createRequest("GET", `http://localhost/api/tenant/members/${TARGET_USER_ID}/reset-vault`),
      createParams({ userId: TARGET_USER_ID }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json[0].status).toBe("revoked");
  });

  it("derives expired status when expiresAt is in the past and not executed or revoked", async () => {
    mockPrismaAdminVaultResetFindMany.mockResolvedValue([
      { ...BASE_RESET, expiresAt: PAST_DATE },
    ]);
    const res = await GET(
      createRequest("GET", `http://localhost/api/tenant/members/${TARGET_USER_ID}/reset-vault`),
      createParams({ userId: TARGET_USER_ID }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json[0].status).toBe("expired");
  });

  it("prefers executed status over expired when executedAt is set even if expiresAt is past", async () => {
    mockPrismaAdminVaultResetFindMany.mockResolvedValue([
      { ...BASE_RESET, expiresAt: PAST_DATE, executedAt: new Date("2024-01-02T00:00:00Z") },
    ]);
    const res = await GET(
      createRequest("GET", `http://localhost/api/tenant/members/${TARGET_USER_ID}/reset-vault`),
      createParams({ userId: TARGET_USER_ID }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json[0].status).toBe("executed");
  });

  it("returns empty array when no resets exist", async () => {
    mockPrismaAdminVaultResetFindMany.mockResolvedValue([]);
    const res = await GET(
      createRequest("GET", `http://localhost/api/tenant/members/${TARGET_USER_ID}/reset-vault`),
      createParams({ userId: TARGET_USER_ID }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveLength(0);
  });

  it("returns exact response shape (R19 — strict equality blocks accidental field leaks like tokenHash/encryptedToken)", async () => {
    const res = await GET(
      createRequest("GET", `http://localhost/api/tenant/members/${TARGET_USER_ID}/reset-vault`),
      createParams({ userId: TARGET_USER_ID }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    // Strict key-set assertion catches new fields leaking into the response
    // (especially sensitive ones like tokenHash, encryptedToken).
    expect(Object.keys(json[0]).sort()).toEqual(
      [
        "approveEligibility",
        "approvedAt",
        "approvedBy",
        "createdAt",
        "executedAt",
        "expiresAt",
        "id",
        "initiatedBy",
        "revokedAt",
        "status",
        "targetEmailAtInitiate",
      ].sort(),
    );
    expect(Object.keys(json[0].initiatedBy).sort()).toEqual(["email", "id", "name"].sort());
  });
});
