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
    mockPrisma.tenant.findUnique.mockResolvedValue({ id: "tenant-acme" });
    mockPrisma.tenant.create.mockResolvedValue({ id: "tenant-acme" });
    mockPrisma.tenantMember.findMany.mockResolvedValue([]);
    mockPrisma.tenantMember.upsert.mockResolvedValue({});
    mockPrisma.tenantMember.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.user.update.mockResolvedValue({});
    mockPrisma.account.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.user.count.mockResolvedValue(0);
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
    mockPrisma.tenantMember.findMany.mockResolvedValue([{ tenantId: "tenant-acme" }]);

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

  it("migrates bootstrap tenant to IdP tenant on first sign-in", async () => {
    mockPrisma.tenantMember.findMany.mockResolvedValue([{ tenantId: "tenant_usr_legacy" }]);

    const ok = await ensureTenantMembershipForSignIn("user-1", null, {});

    expect(ok).toBe(true);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { tenantId: "tenant-acme" },
    });
    expect(mockPrisma.account.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      data: { tenantId: "tenant-acme" },
    });
    expect(mockPrisma.tenantMember.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", tenantId: "tenant_usr_legacy" },
    });
    expect(mockPrisma.tenant.delete).not.toHaveBeenCalled();
  });

  it("keeps existing tenant when already in target tenant", async () => {
    mockPrisma.tenantMember.findMany.mockResolvedValue([{ tenantId: "tenant-acme" }]);

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
});
