import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockPrisma,
  mockWithBypassRls,
  mockExtractTenantClaimValue,
  mockSlugifyTenant,
} = vi.hoisted(() => {
  const mockPrisma = {
    tenant: {
      create: vi.fn(),
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
    tenantMember: {
      findMany: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
    },
    user: {
      update: vi.fn(),
      count: vi.fn(),
    },
    account: {
      updateMany: vi.fn(),
    },
    passwordEntry: {
      updateMany: vi.fn(),
    },
    tag: {
      updateMany: vi.fn(),
    },
    folder: {
      updateMany: vi.fn(),
    },
    session: {
      updateMany: vi.fn(),
    },
    extensionToken: {
      updateMany: vi.fn(),
    },
    passwordEntryHistory: {
      updateMany: vi.fn(),
    },
    auditLog: {
      updateMany: vi.fn(),
    },
    vaultKey: {
      updateMany: vi.fn(),
    },
    emergencyAccessGrant: {
      updateMany: vi.fn(),
    },
    emergencyAccessKeyPair: {
      updateMany: vi.fn(),
    },
    passwordShare: {
      updateMany: vi.fn(),
    },
    shareAccessLog: {
      updateMany: vi.fn(),
    },
    attachment: {
      updateMany: vi.fn(),
    },
    team: {
      count: vi.fn(),
    },
    $transaction: vi.fn(),
  };

  return {
    mockPrisma,
    mockWithBypassRls: vi.fn(async (_prisma: unknown, fn: () => unknown) => fn()),
    mockExtractTenantClaimValue: vi.fn(),
    mockSlugifyTenant: vi.fn(),
  };
});

vi.mock("next-auth", () => ({
  default: vi.fn(() => ({
    handlers: {},
    auth: vi.fn(),
    signIn: vi.fn(),
    signOut: vi.fn(),
  })),
}));

vi.mock("@/lib/auth-adapter", () => ({
  createCustomAdapter: vi.fn(() => ({})),
}));

vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: mockPrisma,
}));

vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: mockWithBypassRls,
}));

vi.mock("@/lib/tenant-claim", () => ({
  extractTenantClaimValue: mockExtractTenantClaimValue,
  slugifyTenant: mockSlugifyTenant,
}));

vi.mock("./auth.config", () => ({
  default: { callbacks: {} },
}));

import { ensureTenantMembershipForSignIn } from "./auth";

describe("ensureTenantMembershipForSignIn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExtractTenantClaimValue.mockReturnValue("tenant-acme");
    mockSlugifyTenant.mockReturnValue("tenant-acme");
    mockPrisma.tenant.findUnique.mockImplementation(async ({ where }: { where: { id?: string; externalId?: string } }) => {
      if (where.externalId === "tenant-acme") return { id: "cuid_acme_1" };
      if (where.id === "cuid_bootstrap_1") return { isBootstrap: true };
      return null;
    });
    mockPrisma.tenant.create.mockResolvedValue({ id: "cuid_acme_1" });
    mockPrisma.tenantMember.findMany.mockResolvedValue([]);
    mockPrisma.tenantMember.upsert.mockResolvedValue({});
    mockPrisma.tenantMember.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.user.update.mockResolvedValue({});
    mockPrisma.account.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.user.count.mockResolvedValue(0);
    mockPrisma.passwordEntry.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.tag.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.folder.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.session.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.extensionToken.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.passwordEntryHistory.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.auditLog.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.vaultKey.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.emergencyAccessGrant.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.emergencyAccessKeyPair.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.passwordShare.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.shareAccessLog.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.attachment.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.team.count.mockResolvedValue(0);
    mockPrisma.tenantMember.count.mockResolvedValue(0);
    mockPrisma.tenant.delete.mockResolvedValue({});
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => unknown) => fn(mockPrisma));
  });

  it("allows sign-in when tenant claim is missing and no membership exists", async () => {
    mockExtractTenantClaimValue.mockReturnValue(null);

    const ok = await ensureTenantMembershipForSignIn("user-1", null, null);

    expect(ok).toBe(true);
    expect(mockWithBypassRls).toHaveBeenCalledTimes(1);
    expect(mockPrisma.tenantMember.findMany).toHaveBeenCalledWith({
      where: { userId: "user-1", deactivatedAt: null },
      select: { tenantId: true },
      orderBy: { createdAt: "asc" },
      take: 2,
    });
  });

  it("throws when tenant creation fails with non-retryable error", async () => {
    mockPrisma.tenant.findUnique.mockResolvedValue(null);
    mockPrisma.tenant.create.mockRejectedValueOnce(
      new Error("slug conflict"),
    );

    await expect(
      ensureTenantMembershipForSignIn("user-1", null, {}),
    ).rejects.toThrow("slug conflict");
  });

  it("allows sign-in when tenant claim is missing but membership exists", async () => {
    mockExtractTenantClaimValue.mockReturnValue(null);
    mockPrisma.tenantMember.findMany.mockResolvedValue([{ tenantId: "cuid_acme_1" }]);

    const ok = await ensureTenantMembershipForSignIn("user-1", null, null);

    expect(ok).toBe(true);
    expect(mockWithBypassRls).toHaveBeenCalledTimes(1);
  });

  it("rejects cross-tenant sign-in for non-bootstrap membership", async () => {
    mockPrisma.tenantMember.findMany.mockResolvedValue([{ tenantId: "tenant-other" }]);

    const ok = await ensureTenantMembershipForSignIn("user-1", null, {});

    expect(ok).toBe(false);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("migrates bootstrap tenant identified by bootstrap slug", async () => {
    mockPrisma.tenantMember.findMany.mockResolvedValue([{ tenantId: "cuid_bootstrap_1" }]);

    const ok = await ensureTenantMembershipForSignIn("user-1", null, {});

    expect(ok).toBe(true);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { tenantId: "cuid_acme_1" },
    });
    expect(mockPrisma.account.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      data: { tenantId: "cuid_acme_1" },
    });
    // Verify all tenant-scoped data tables are migrated
    expect(mockPrisma.passwordEntry.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", tenantId: "cuid_bootstrap_1" },
      data: { tenantId: "cuid_acme_1" },
    });
    for (const model of ["tag", "folder", "session", "extensionToken", "auditLog"] as const) {
      expect(mockPrisma[model].updateMany).toHaveBeenCalledWith({
        where: { userId: "user-1", tenantId: "cuid_bootstrap_1" },
        data: { tenantId: "cuid_acme_1" },
      });
    }
    // passwordEntryHistory has no userId — filtered by tenantId only
    expect(mockPrisma.passwordEntryHistory.updateMany).toHaveBeenCalledWith({
      where: { tenantId: "cuid_bootstrap_1" },
      data: { tenantId: "cuid_acme_1" },
    });
    expect(mockPrisma.vaultKey.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", tenantId: "cuid_bootstrap_1" },
      data: { tenantId: "cuid_acme_1" },
    });
    // Emergency access, password shares, attachments
    expect(mockPrisma.emergencyAccessGrant.updateMany).toHaveBeenCalledWith({
      where: { ownerId: "user-1", tenantId: "cuid_bootstrap_1" },
      data: { tenantId: "cuid_acme_1" },
    });
    expect(mockPrisma.emergencyAccessKeyPair.updateMany).toHaveBeenCalledWith({
      where: { tenantId: "cuid_bootstrap_1" },
      data: { tenantId: "cuid_acme_1" },
    });
    expect(mockPrisma.passwordShare.updateMany).toHaveBeenCalledWith({
      where: { createdById: "user-1", tenantId: "cuid_bootstrap_1" },
      data: { tenantId: "cuid_acme_1" },
    });
    expect(mockPrisma.shareAccessLog.updateMany).toHaveBeenCalledWith({
      where: { tenantId: "cuid_bootstrap_1" },
      data: { tenantId: "cuid_acme_1" },
    });
    expect(mockPrisma.attachment.updateMany).toHaveBeenCalledWith({
      where: { createdById: "user-1", tenantId: "cuid_bootstrap_1" },
      data: { tenantId: "cuid_acme_1" },
    });
    expect(mockPrisma.tenantMember.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", tenantId: "cuid_bootstrap_1" },
    });
    // Bootstrap migration returns early — no redundant upsert
    expect(mockPrisma.tenantMember.upsert).toHaveBeenCalledTimes(1);
    expect(mockPrisma.tenant.delete).not.toHaveBeenCalled();
  });

  it("keeps existing tenant when already in target tenant", async () => {
    mockPrisma.tenantMember.findMany.mockResolvedValue([{ tenantId: "cuid_acme_1" }]);

    const ok = await ensureTenantMembershipForSignIn("user-1", null, {});

    expect(ok).toBe(true);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.tenantMember.upsert).toHaveBeenCalledTimes(1);
    expect(mockPrisma.tenantMember.findMany).toHaveBeenCalledWith({
      where: { userId: "user-1", deactivatedAt: null },
      select: { tenantId: true },
      orderBy: { createdAt: "asc" },
      take: 2,
    });
  });

  it("creates tenant with externalId (not id) in data", async () => {
    mockPrisma.tenant.findUnique.mockResolvedValue(null);
    mockPrisma.tenant.create.mockResolvedValue({ id: "cuid_acme_1" });

    await ensureTenantMembershipForSignIn("user-1", null, {});

    expect(mockPrisma.tenant.create).toHaveBeenCalledWith({
      data: {
        externalId: "tenant-acme",
        name: "tenant-acme",
        slug: "tenant-acme",
      },
      select: { id: true },
    });
    const createData = mockPrisma.tenant.create.mock.calls[0][0].data;
    expect(createData).not.toHaveProperty("id");
  });

  it("retries findUnique by externalId after P2002 from tenant create", async () => {
    const { Prisma } = await import("@prisma/client");
    mockPrisma.tenant.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "cuid_acme_1" });
    mockPrisma.tenant.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("unique", {
        code: "P2002",
        clientVersion: "7.0.0",
      }),
    );

    const ok = await ensureTenantMembershipForSignIn("user-1", null, {});

    expect(ok).toBe(true);
    expect(mockPrisma.tenant.findUnique).toHaveBeenCalledTimes(2);
    expect(mockPrisma.tenant.findUnique).toHaveBeenNthCalledWith(1, {
      where: { externalId: "tenant-acme" },
      select: { id: true },
    });
    expect(mockPrisma.tenant.findUnique).toHaveBeenNthCalledWith(2, {
      where: { externalId: "tenant-acme" },
      select: { id: true },
    });
  });

  it("rejects migration when isBootstrap is false even if slug resembles bootstrap", async () => {
    mockPrisma.tenantMember.findMany.mockResolvedValue([{ tenantId: "cuid_fake_boot" }]);
    mockPrisma.tenant.findUnique.mockImplementation(async ({ where }: { where: { id?: string; externalId?: string } }) => {
      if (where.externalId === "tenant-acme") return { id: "cuid_acme_1" };
      if (where.id === "cuid_fake_boot") return { isBootstrap: false };
      return null;
    });

    const ok = await ensureTenantMembershipForSignIn("user-1", null, {});

    expect(ok).toBe(false);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("allows migration when isBootstrap is true regardless of slug pattern", async () => {
    mockPrisma.tenantMember.findMany.mockResolvedValue([{ tenantId: "cuid_odd_slug" }]);
    mockPrisma.tenant.findUnique.mockImplementation(async ({ where }: { where: { id?: string; externalId?: string } }) => {
      if (where.externalId === "tenant-acme") return { id: "cuid_acme_1" };
      if (where.id === "cuid_odd_slug") return { isBootstrap: true };
      return null;
    });

    const ok = await ensureTenantMembershipForSignIn("user-1", null, {});

    expect(ok).toBe(true);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("retries with fallback slug when P2002 is slug collision (not externalId)", async () => {
    const { Prisma } = await import("@prisma/client");
    // findUnique returns null both times (externalId not found)
    mockPrisma.tenant.findUnique.mockResolvedValue(null);
    // First create fails with P2002 (slug collision)
    mockPrisma.tenant.create
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("unique", {
          code: "P2002",
          clientVersion: "7.0.0",
        }),
      )
      // Second create with fallback slug succeeds
      .mockResolvedValueOnce({ id: "cuid_acme_2" });

    const ok = await ensureTenantMembershipForSignIn("user-1", null, {});

    expect(ok).toBe(true);
    expect(mockPrisma.tenant.create).toHaveBeenCalledTimes(2);
    // Second create should have a slug with random suffix
    const secondCreate = mockPrisma.tenant.create.mock.calls[1][0];
    expect(secondCreate.data.slug).toMatch(/^tenant-acme-[0-9a-f]{8}$/);
    expect(secondCreate.data.externalId).toBe("tenant-acme");
  });

  it("returns false when slugifyTenant returns empty string", async () => {
    mockSlugifyTenant.mockReturnValue("");

    const ok = await ensureTenantMembershipForSignIn("user-1", null, {});

    expect(ok).toBe(false);
    expect(mockWithBypassRls).not.toHaveBeenCalled();
  });
});
