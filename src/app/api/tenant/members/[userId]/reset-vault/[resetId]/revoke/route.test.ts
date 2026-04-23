import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const {
  mockAuth,
  mockPrismaAdminVaultResetUpdateMany,
  mockPrismaTenantMemberFindFirst,
  mockLogAudit,
  mockCreateNotification,
  mockSendEmail,
  mockAdminVaultResetRevokedEmail,
  mockResolveUserLocale,
  mockRequireTenantPermission,
  mockWithTenantRls,
  mockNotificationTitle,
  mockNotificationBody,
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
    mockPrismaAdminVaultResetUpdateMany: vi.fn(),
    mockPrismaTenantMemberFindFirst: vi.fn(),
    mockLogAudit: vi.fn(),
    mockCreateNotification: vi.fn(),
    mockSendEmail: vi.fn(),
    mockAdminVaultResetRevokedEmail: vi.fn(),
    mockResolveUserLocale: vi.fn(),
    mockRequireTenantPermission: vi.fn(),
    mockWithTenantRls: vi.fn((_p: unknown, _t: unknown, fn: () => unknown) => fn()),
    mockNotificationTitle: vi.fn(),
    mockNotificationBody: vi.fn(),
    TenantAuthError: _TenantAuthError,
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    adminVaultReset: {
      updateMany: mockPrismaAdminVaultResetUpdateMany,
    },
    tenantMember: {
      findFirst: mockPrismaTenantMemberFindFirst,
    },
  },
}));
vi.mock("@/lib/auth/csrf", () => ({ assertOrigin: vi.fn(() => null) }));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: vi.fn(() => ({ ip: "127.0.0.1", userAgent: "test" })),
  tenantAuditBase: vi.fn((_, userId, tenantId) => ({ scope: "TENANT", userId, tenantId })),
}));
vi.mock("@/lib/notification", () => ({ createNotification: mockCreateNotification }));
vi.mock("@/lib/email", () => ({ sendEmail: mockSendEmail }));
vi.mock("@/lib/email/templates/admin-vault-reset-revoked", () => ({
  adminVaultResetRevokedEmail: mockAdminVaultResetRevokedEmail,
}));
vi.mock("@/lib/locale", () => ({ resolveUserLocale: mockResolveUserLocale }));
vi.mock("@/lib/auth/tenant-auth", () => ({
  requireTenantPermission: mockRequireTenantPermission,
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
vi.mock("@/lib/logger", () => ({
  default: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { POST } from "./route";

const TENANT_ID = "tenant-1";
const TARGET_USER_ID = "user-target";
const ACTOR_USER_ID = "test-user-id";
const RESET_ID = "reset-1";

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
    email: "target@example.com",
    name: "Target User",
    locale: null,
  },
};

describe("POST /api/tenant/members/[userId]/reset-vault/[resetId]/revoke", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: ACTOR_USER_ID, name: "Admin User", email: "admin@example.com" } });
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockPrismaAdminVaultResetUpdateMany.mockResolvedValue({ count: 1 });
    mockPrismaTenantMemberFindFirst.mockResolvedValue(TARGET_MEMBER);
    mockResolveUserLocale.mockReturnValue("en");
    mockAdminVaultResetRevokedEmail.mockReturnValue({
      subject: "Vault reset revoked",
      html: "<p>Revoked</p>",
      text: "Revoked",
    });
    mockNotificationTitle.mockReturnValue("Vault Reset Revoked");
    mockNotificationBody.mockReturnValue("Your vault reset has been revoked.");
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", `http://localhost/api/tenant/members/${TARGET_USER_ID}/reset-vault/${RESET_ID}/revoke`),
      createParams({ userId: TARGET_USER_ID, resetId: RESET_ID }),
    );
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 403 when lacking MEMBER_VAULT_RESET permission", async () => {
    mockRequireTenantPermission.mockRejectedValue(new TenantAuthError("FORBIDDEN", 403));
    const res = await POST(
      createRequest("POST", `http://localhost/api/tenant/members/${TARGET_USER_ID}/reset-vault/${RESET_ID}/revoke`),
      createParams({ userId: TARGET_USER_ID, resetId: RESET_ID }),
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("FORBIDDEN");
  });

  it("rethrows non-TenantAuthError errors from permission check", async () => {
    mockRequireTenantPermission.mockRejectedValue(new Error("unexpected db error"));
    await expect(
      POST(
        createRequest("POST", `http://localhost/api/tenant/members/${TARGET_USER_ID}/reset-vault/${RESET_ID}/revoke`),
        createParams({ userId: TARGET_USER_ID, resetId: RESET_ID }),
      ),
    ).rejects.toThrow("unexpected db error");
  });

  it("returns 409 when reset is already processed (updateMany count is 0)", async () => {
    mockPrismaAdminVaultResetUpdateMany.mockResolvedValue({ count: 0 });
    const res = await POST(
      createRequest("POST", `http://localhost/api/tenant/members/${TARGET_USER_ID}/reset-vault/${RESET_ID}/revoke`),
      createParams({ userId: TARGET_USER_ID, resetId: RESET_ID }),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("CONFLICT");
  });

  it("returns 200 and updates revokedAt, logs audit, sends notification and email on success", async () => {
    const res = await POST(
      createRequest("POST", `http://localhost/api/tenant/members/${TARGET_USER_ID}/reset-vault/${RESET_ID}/revoke`),
      createParams({ userId: TARGET_USER_ID, resetId: RESET_ID }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);

    // updateMany called with correct conditions
    expect(mockPrismaAdminVaultResetUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: RESET_ID,
          tenantId: TENANT_ID,
          targetUserId: TARGET_USER_ID,
          executedAt: null,
          revokedAt: null,
        }),
        data: expect.objectContaining({
          revokedAt: expect.any(Date),
        }),
      }),
    );

    // Audit log
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ADMIN_VAULT_RESET_REVOKE",
        userId: ACTOR_USER_ID,
        tenantId: TENANT_ID,
        targetType: "User",
        targetId: TARGET_USER_ID,
        metadata: expect.objectContaining({
          revokedById: ACTOR_USER_ID,
          resetId: RESET_ID,
        }),
      }),
    );

    // In-app notification
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: TARGET_USER_ID,
        tenantId: TENANT_ID,
        type: "ADMIN_VAULT_RESET_REVOKED",
      }),
    );

    // Email notification
    expect(mockAdminVaultResetRevokedEmail).toHaveBeenCalled();
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "target@example.com",
        subject: "Vault reset revoked",
      }),
    );

    expect(mockWithTenantRls).toHaveBeenCalledWith(
      expect.anything(),
      TENANT_ID,
      expect.any(Function),
    );
  });

  it("calls requireTenantPermission with MEMBER_VAULT_RESET permission", async () => {
    await POST(
      createRequest("POST", `http://localhost/api/tenant/members/${TARGET_USER_ID}/reset-vault/${RESET_ID}/revoke`),
      createParams({ userId: TARGET_USER_ID, resetId: RESET_ID }),
    );
    expect(mockRequireTenantPermission).toHaveBeenCalledWith(
      ACTOR_USER_ID,
      "tenant:member:vaultReset",
    );
  });

  it("skips notification and email when target user cannot be found after revocation", async () => {
    mockPrismaTenantMemberFindFirst.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", `http://localhost/api/tenant/members/${TARGET_USER_ID}/reset-vault/${RESET_ID}/revoke`),
      createParams({ userId: TARGET_USER_ID, resetId: RESET_ID }),
    );
    expect(res.status).toBe(200);
    expect(mockCreateNotification).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("skips email but sends notification when target user has no email", async () => {
    mockPrismaTenantMemberFindFirst.mockResolvedValue({
      ...TARGET_MEMBER,
      user: { ...TARGET_MEMBER.user, email: null },
    });
    const res = await POST(
      createRequest("POST", `http://localhost/api/tenant/members/${TARGET_USER_ID}/reset-vault/${RESET_ID}/revoke`),
      createParams({ userId: TARGET_USER_ID, resetId: RESET_ID }),
    );
    expect(res.status).toBe(200);
    expect(mockCreateNotification).toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("passes resetId and userId in the updateMany where clause", async () => {
    const DIFFERENT_RESET_ID = "reset-999";
    const DIFFERENT_USER_ID = "other-user";
    mockPrismaAdminVaultResetUpdateMany.mockResolvedValue({ count: 1 });
    mockPrismaTenantMemberFindFirst.mockResolvedValue(TARGET_MEMBER);

    await POST(
      createRequest("POST", `http://localhost/api/tenant/members/${DIFFERENT_USER_ID}/reset-vault/${DIFFERENT_RESET_ID}/revoke`),
      createParams({ userId: DIFFERENT_USER_ID, resetId: DIFFERENT_RESET_ID }),
    );

    expect(mockPrismaAdminVaultResetUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: DIFFERENT_RESET_ID,
          targetUserId: DIFFERENT_USER_ID,
          tenantId: TENANT_ID,
        }),
      }),
    );
  });
});
