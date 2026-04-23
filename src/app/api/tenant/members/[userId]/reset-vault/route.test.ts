import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const {
  mockAuth,
  mockPrismaTenantMemberFindFirst,
  mockPrismaAdminVaultResetCount,
  mockPrismaAdminVaultResetCreate,
  mockPrismaAdminVaultResetFindMany,
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
    mockPrismaAdminVaultResetCount: vi.fn(),
    mockPrismaAdminVaultResetCreate: vi.fn(),
    mockPrismaAdminVaultResetFindMany: vi.fn(),
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
    TenantAuthError: _TenantAuthError,
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantMember: { findFirst: mockPrismaTenantMemberFindFirst },
    adminVaultReset: {
      count: mockPrismaAdminVaultResetCount,
      create: mockPrismaAdminVaultResetCreate,
      findMany: mockPrismaAdminVaultResetFindMany,
    },
  },
}));
vi.mock("@/lib/csrf", () => ({ assertOrigin: vi.fn(() => null) }));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: vi.fn(() => ({ check: mockRateLimiterCheck })),
}));
vi.mock("@/lib/audit", () => ({
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
vi.mock("@/lib/auth/tenant-auth", () => ({
  requireTenantPermission: mockRequireTenantPermission,
  isTenantRoleAbove: mockIsTenantRoleAbove,
  TenantAuthError,
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: mockWithTenantRls,
  withBypassRls: vi.fn((_p: unknown, fn: () => unknown) => fn()),
}));
vi.mock("@/lib/notification-messages", () => ({
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
    mockPrismaAdminVaultResetCount.mockResolvedValue(0);
    mockPrismaAdminVaultResetCreate.mockResolvedValue({ id: "reset-1" });
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
    mockResolveUserLocale.mockReturnValue("en");
    mockServerAppUrl.mockReturnValue("http://localhost");
    mockAdminVaultResetEmail.mockReturnValue({
      subject: "Vault reset initiated",
      html: "<p>Reset</p>",
      text: "Reset",
    });
    mockNotificationTitle.mockReturnValue("Vault Reset");
    mockNotificationBody.mockReturnValue("Your vault has been reset by an admin.");
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

  it("returns 200 and creates reset record, logs audit, sends notification and email on success", async () => {
    const res = await POST(
      createRequest("POST", `http://localhost/api/tenant/members/${TARGET_USER_ID}/reset-vault`),
      createParams({ userId: TARGET_USER_ID }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);

    // Reset record created
    expect(mockPrismaAdminVaultResetCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: TENANT_ID,
          teamId: null,
          targetUserId: TARGET_USER_ID,
          initiatedById: ACTOR_USER_ID,
          tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          expiresAt: expect.any(Date),
        }),
      }),
    );

    // Audit log
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ADMIN_VAULT_RESET_INITIATE",
        userId: ACTOR_USER_ID,
        tenantId: TENANT_ID,
        targetType: "User",
        targetId: TARGET_USER_ID,
      }),
    );

    // In-app notification
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: TARGET_USER_ID,
        tenantId: TENANT_ID,
        type: "ADMIN_VAULT_RESET",
      }),
    );

    // Email notification
    expect(mockAdminVaultResetEmail).toHaveBeenCalled();
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "target@example.com",
        subject: "Vault reset initiated",
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
      createRequest("POST", `http://localhost/api/tenant/members/${TARGET_USER_ID}/reset-vault`),
      createParams({ userId: TARGET_USER_ID }),
    );
    expect(mockRequireTenantPermission).toHaveBeenCalledWith(
      ACTOR_USER_ID,
      "tenant:member:vaultReset",
    );
  });

  it("skips email when target user has no email", async () => {
    mockPrismaTenantMemberFindFirst.mockResolvedValue({
      ...TARGET_MEMBER,
      user: { ...TARGET_MEMBER.user, email: null },
    });
    const res = await POST(
      createRequest("POST", `http://localhost/api/tenant/members/${TARGET_USER_ID}/reset-vault`),
      createParams({ userId: TARGET_USER_ID }),
    );
    expect(res.status).toBe(200);
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
    createdAt: new Date("2024-01-01T00:00:00Z"),
    expiresAt: FUTURE_DATE,
    executedAt: null,
    revokedAt: null,
    initiatedBy: { name: "Admin User", email: "admin@example.com" },
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

  it("returns reset history with pending status for active non-executed reset", async () => {
    const res = await GET(
      createRequest("GET", `http://localhost/api/tenant/members/${TARGET_USER_ID}/reset-vault`),
      createParams({ userId: TARGET_USER_ID }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveLength(1);
    expect(json[0]).toMatchObject({
      id: "reset-1",
      status: "pending",
      initiatedBy: { name: "Admin User", email: "admin@example.com" },
    });
    expect(mockWithTenantRls).toHaveBeenCalledWith(
      expect.anything(),
      TENANT_ID,
      expect.any(Function),
    );
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

  it("returns correct shape with all required fields", async () => {
    const res = await GET(
      createRequest("GET", `http://localhost/api/tenant/members/${TARGET_USER_ID}/reset-vault`),
      createParams({ userId: TARGET_USER_ID }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json[0]).toHaveProperty("id");
    expect(json[0]).toHaveProperty("status");
    expect(json[0]).toHaveProperty("createdAt");
    expect(json[0]).toHaveProperty("expiresAt");
    expect(json[0]).toHaveProperty("executedAt");
    expect(json[0]).toHaveProperty("revokedAt");
    expect(json[0]).toHaveProperty("initiatedBy");
    expect(json[0].initiatedBy).toHaveProperty("name");
    expect(json[0].initiatedBy).toHaveProperty("email");
  });
});
