import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockPrismaUser,
  mockPrismaTenantMember,
  mockWithBypassRls,
  mockSendEmail,
  mockCreateNotification,
  mockResolveUserLocale,
  mockGetLogger,
  mockLoggerInstance,
  mockVaultLockoutEmail,
} = vi.hoisted(() => {
  const mockLoggerInstance = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    mockPrismaUser: { findUnique: vi.fn() },
    mockPrismaTenantMember: { findMany: vi.fn() },
    mockWithBypassRls: vi.fn(),
    mockSendEmail: vi.fn(),
    mockCreateNotification: vi.fn(),
    mockResolveUserLocale: vi.fn().mockReturnValue("en"),
    mockGetLogger: vi.fn(() => mockLoggerInstance),
    mockLoggerInstance,
    mockVaultLockoutEmail: vi.fn().mockReturnValue({
      subject: "Vault lockout triggered",
      html: "<p>lockout</p>",
      text: "lockout",
    }),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: mockPrismaUser,
    tenantMember: mockPrismaTenantMember,
  },
}));
vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: mockWithBypassRls,
}));
vi.mock("@/lib/email", () => ({
  sendEmail: mockSendEmail,
}));
vi.mock("@/lib/email/templates/vault-lockout", () => ({
  vaultLockoutEmail: mockVaultLockoutEmail,
}));
vi.mock("@/lib/notification", () => ({
  createNotification: mockCreateNotification,
}));
vi.mock("@/lib/constants", () => ({
  NOTIFICATION_TYPE: { SECURITY_ALERT: "SECURITY_ALERT" },
  TENANT_ROLE: { OWNER: "OWNER", ADMIN: "ADMIN" },
}));
vi.mock("@/lib/notification-messages", () => ({
  notificationTitle: vi.fn().mockReturnValue("Vault lockout alert"),
  notificationBody: vi.fn().mockReturnValue("Vault locked for user@test.com — 15 minutes"),
}));
vi.mock("@/lib/locale", () => ({
  resolveUserLocale: mockResolveUserLocale,
}));
vi.mock("@/lib/logger", () => ({
  default: { child: () => mockLoggerInstance },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: mockGetLogger,
}));

import { notifyAdminsOfLockout } from "./lockout-admin-notify";
import { notificationBody } from "@/lib/notification-messages";

const baseParams = {
  userId: "user-1",
  attempts: 5,
  lockMinutes: 15,
  ip: "1.2.3.4",
};

function setupBypassRls(data: {
  userEmail: string | null;
  tenantId: string | null;
  admins: Array<{
    userId: string;
    user: { email: string | null; locale: string | null };
  }>;
} | null) {
  mockWithBypassRls.mockImplementation(async (_prisma: unknown, fn: () => Promise<unknown>) => {
    // Execute the callback but return our controlled data
    // This simulates withBypassRls running the callback inside a transaction
    mockPrismaUser.findUnique.mockResolvedValue(
      data ? { email: data.userEmail, tenantId: data.tenantId } : null,
    );
    mockPrismaTenantMember.findMany.mockResolvedValue(data?.admins ?? []);
    return fn();
  });
}

describe("notifyAdminsOfLockout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendEmail.mockResolvedValue(undefined);
  });

  it("sends email + notification to all OWNER and ADMIN", async () => {
    setupBypassRls({
      userEmail: "victim@test.com",
      tenantId: "tenant-1",
      admins: [
        { userId: "admin-1", user: { email: "admin1@test.com", locale: "en" } },
        { userId: "owner-1", user: { email: "owner1@test.com", locale: "ja" } },
      ],
    });

    await notifyAdminsOfLockout(baseParams);

    expect(mockSendEmail).toHaveBeenCalledTimes(2);
    expect(mockCreateNotification).toHaveBeenCalledTimes(2);
  });

  it("passes tenantId to createNotification to avoid double lookup", async () => {
    setupBypassRls({
      userEmail: "victim@test.com",
      tenantId: "tenant-1",
      admins: [
        { userId: "admin-1", user: { email: "admin1@test.com", locale: "en" } },
      ],
    });

    await notifyAdminsOfLockout(baseParams);

    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "admin-1",
        tenantId: "tenant-1",
        type: "SECURITY_ALERT",
      }),
    );
  });

  it("skips admins without email", async () => {
    setupBypassRls({
      userEmail: "victim@test.com",
      tenantId: "tenant-1",
      admins: [
        { userId: "admin-1", user: { email: null, locale: "en" } },
        { userId: "admin-2", user: { email: "admin2@test.com", locale: "en" } },
      ],
    });

    await notifyAdminsOfLockout(baseParams);

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
  });

  it("does nothing when user has no tenantId", async () => {
    setupBypassRls({
      userEmail: "victim@test.com",
      tenantId: null,
      admins: [],
    });

    await notifyAdminsOfLockout(baseParams);

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it("does nothing when user not found", async () => {
    mockWithBypassRls.mockImplementation(async (_prisma: unknown, fn: () => Promise<unknown>) => {
      mockPrismaUser.findUnique.mockResolvedValue(null);
      return fn();
    });

    await notifyAdminsOfLockout(baseParams);

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it("resolves locale per admin", async () => {
    setupBypassRls({
      userEmail: "victim@test.com",
      tenantId: "tenant-1",
      admins: [
        { userId: "admin-1", user: { email: "admin1@test.com", locale: "ja" } },
        { userId: "admin-2", user: { email: "admin2@test.com", locale: "en" } },
      ],
    });

    await notifyAdminsOfLockout(baseParams);

    expect(mockResolveUserLocale).toHaveBeenCalledWith("ja");
    expect(mockResolveUserLocale).toHaveBeenCalledWith("en");
  });

  it("passes lockMinutes as string to notificationBody", async () => {
    setupBypassRls({
      userEmail: "victim@test.com",
      tenantId: "tenant-1",
      admins: [
        { userId: "admin-1", user: { email: "admin1@test.com", locale: "en" } },
      ],
    });

    await notifyAdminsOfLockout(baseParams);

    expect(notificationBody).toHaveBeenCalledWith(
      "VAULT_LOCKOUT",
      expect.any(String),
      "victim@test.com",
      "15", // String, not number
    );
  });

  it("swallows withBypassRls errors and logs warning", async () => {
    mockWithBypassRls.mockRejectedValue(new Error("db connection lost"));

    await notifyAdminsOfLockout(baseParams);

    // Should not throw
    expect(mockLoggerInstance.warn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" }),
      "lockout.adminNotify.error",
    );
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("swallows sendEmail errors per admin and continues to next admin", async () => {
    setupBypassRls({
      userEmail: "victim@test.com",
      tenantId: "tenant-1",
      admins: [
        { userId: "admin-1", user: { email: "admin1@test.com", locale: "en" } },
        { userId: "admin-2", user: { email: "admin2@test.com", locale: "en" } },
      ],
    });
    mockSendEmail
      .mockRejectedValueOnce(new Error("smtp failure"))
      .mockResolvedValueOnce(undefined);

    await notifyAdminsOfLockout(baseParams);

    // First admin failed — per-admin catch logs warning
    expect(mockLoggerInstance.warn).toHaveBeenCalledWith(
      expect.objectContaining({ adminUserId: "admin-1" }),
      "lockout.adminNotify.perAdmin.error",
    );
    // First admin's createNotification was skipped (sendEmail threw before it)
    // Second admin succeeded — sendEmail called twice, createNotification once
    expect(mockSendEmail).toHaveBeenCalledTimes(2);
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "admin-2" }),
    );
  });

  it("uses 'unknown' when user email is null", async () => {
    setupBypassRls({
      userEmail: null,
      tenantId: "tenant-1",
      admins: [
        { userId: "admin-1", user: { email: "admin1@test.com", locale: "en" } },
      ],
    });

    await notifyAdminsOfLockout(baseParams);

    expect(notificationBody).toHaveBeenCalledWith(
      "VAULT_LOCKOUT",
      expect.any(String),
      "unknown",
      "15",
    );
  });

  it("excludes deactivated admins", async () => {
    setupBypassRls({
      userEmail: "victim@test.com",
      tenantId: "tenant-1",
      admins: [
        { userId: "active-admin", user: { email: "active@test.com", locale: "en" } },
      ],
    });

    await notifyAdminsOfLockout(baseParams);

    // Verify the query includes deactivatedAt: null filter
    expect(mockPrismaTenantMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          deactivatedAt: null,
        }),
      }),
    );
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
  });

  it("uses 'Unknown' for ip when ip is null", async () => {
    setupBypassRls({
      userEmail: "victim@test.com",
      tenantId: "tenant-1",
      admins: [
        { userId: "admin-1", user: { email: "admin1@test.com", locale: "en" } },
      ],
    });

    await notifyAdminsOfLockout({ ...baseParams, ip: null });

    expect(mockVaultLockoutEmail).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ ipAddress: "Unknown" }),
    );
  });
});
