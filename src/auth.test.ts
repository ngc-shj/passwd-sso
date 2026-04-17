import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockPrisma,
  mockWithBypassRls,
  mockExtractTenantClaimValue,
  mockSlugifyTenant,
  mockTenantClaimStore,
  mockTenantClaimGetStore,
  mockSessionMetaGetStore,
  mockLogAudit,
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
      findUnique: vi.fn(),
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
    notification: {
      updateMany: vi.fn(),
    },
    apiKey: {
      updateMany: vi.fn(),
    },
    webAuthnCredential: {
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
    mockTenantClaimStore: { tenantClaim: null as string | null },
    mockTenantClaimGetStore: vi.fn(),
    mockSessionMetaGetStore: vi.fn(),
    mockLogAudit: vi.fn(),
  };
});

const { mockNextAuth } = vi.hoisted(() => ({
  mockNextAuth: vi.fn(() => ({
    handlers: {},
    auth: vi.fn(),
    signIn: vi.fn(),
    signOut: vi.fn(),
  })),
}));

vi.mock("next-auth", () => ({
  default: mockNextAuth,
}));

vi.mock("@/lib/auth-adapter", () => ({
  createCustomAdapter: vi.fn(() => ({})),
}));

vi.mock("@/lib/audit", () => ({
  logAuditAsync: mockLogAudit,
}));

vi.mock("@/lib/session-meta", () => ({
  sessionMetaStorage: { getStore: mockSessionMetaGetStore },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: mockPrisma,
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));

vi.mock("@/lib/tenant-claim", () => ({
  extractTenantClaimValue: mockExtractTenantClaimValue,
  slugifyTenant: mockSlugifyTenant,
}));

vi.mock("@/lib/tenant-claim-storage", () => ({
  tenantClaimStorage: { getStore: mockTenantClaimGetStore },
}));

vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("./auth.config", () => ({
  default: { callbacks: {} },
}));

import { ensureTenantMembershipForSignIn, assertBootstrapSingleMember } from "./auth";

// Capture the NextAuth call args at import time, before beforeEach clears mocks
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nextAuthInitArgs = (mockNextAuth.mock.calls as any[])[0];

describe("assertBootstrapSingleMember", () => {
  it("does not throw when tenant has exactly one active member", async () => {
    const countFn = vi.fn().mockResolvedValue(1);
    const tx = { tenantMember: { count: countFn } } as unknown as Parameters<typeof assertBootstrapSingleMember>[0];
    await expect(assertBootstrapSingleMember(tx, "tenant-1")).resolves.toBeUndefined();
    expect(countFn).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1", deactivatedAt: null },
    });
  });

  it("throws when tenant has more than one active member", async () => {
    const tx = { tenantMember: { count: vi.fn().mockResolvedValue(2) } } as unknown as Parameters<typeof assertBootstrapSingleMember>[0];
    await expect(assertBootstrapSingleMember(tx, "tenant-1")).rejects.toThrow(/Bootstrap migration aborted/);
  });
});

describe("ensureTenantMembershipForSignIn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExtractTenantClaimValue.mockReturnValue("tenant-acme");
    mockSlugifyTenant.mockReturnValue("tenant-acme");
    mockPrisma.tenant.findUnique.mockImplementation(async ({ where }: { where: { id?: string; externalId?: string } }) => {
      if (where.externalId === "tenant-acme") return { id: "00000000-0000-4000-a000-000000000001" };
      if (where.id === "00000000-0000-4000-a000-000000000002") return { isBootstrap: true };
      return null;
    });
    mockPrisma.tenant.create.mockResolvedValue({ id: "00000000-0000-4000-a000-000000000001" });
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
    mockPrisma.tenantMember.findMany.mockResolvedValue([{ tenantId: "00000000-0000-4000-a000-000000000001" }]);

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
    mockPrisma.tenantMember.findMany.mockResolvedValue([{ tenantId: "00000000-0000-4000-a000-000000000002" }]);

    const ok = await ensureTenantMembershipForSignIn("user-1", null, {});

    expect(ok).toBe(true);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { tenantId: "00000000-0000-4000-a000-000000000001" },
    });
    expect(mockPrisma.account.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      data: { tenantId: "00000000-0000-4000-a000-000000000001" },
    });
    // Verify all tenant-scoped data tables are migrated
    expect(mockPrisma.passwordEntry.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", tenantId: "00000000-0000-4000-a000-000000000002" },
      data: { tenantId: "00000000-0000-4000-a000-000000000001" },
    });
    for (const model of ["tag", "folder", "session", "extensionToken", "auditLog"] as const) {
      expect(mockPrisma[model].updateMany).toHaveBeenCalledWith({
        where: { userId: "user-1", tenantId: "00000000-0000-4000-a000-000000000002" },
        data: { tenantId: "00000000-0000-4000-a000-000000000001" },
      });
    }
    // passwordEntryHistory has no userId — filtered by tenantId only
    expect(mockPrisma.passwordEntryHistory.updateMany).toHaveBeenCalledWith({
      where: { tenantId: "00000000-0000-4000-a000-000000000002" },
      data: { tenantId: "00000000-0000-4000-a000-000000000001" },
    });
    expect(mockPrisma.vaultKey.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", tenantId: "00000000-0000-4000-a000-000000000002" },
      data: { tenantId: "00000000-0000-4000-a000-000000000001" },
    });
    // Emergency access, password shares, attachments
    expect(mockPrisma.emergencyAccessGrant.updateMany).toHaveBeenCalledWith({
      where: { ownerId: "user-1", tenantId: "00000000-0000-4000-a000-000000000002" },
      data: { tenantId: "00000000-0000-4000-a000-000000000001" },
    });
    expect(mockPrisma.emergencyAccessKeyPair.updateMany).toHaveBeenCalledWith({
      where: { tenantId: "00000000-0000-4000-a000-000000000002" },
      data: { tenantId: "00000000-0000-4000-a000-000000000001" },
    });
    expect(mockPrisma.passwordShare.updateMany).toHaveBeenCalledWith({
      where: { createdById: "user-1", tenantId: "00000000-0000-4000-a000-000000000002" },
      data: { tenantId: "00000000-0000-4000-a000-000000000001" },
    });
    expect(mockPrisma.shareAccessLog.updateMany).toHaveBeenCalledWith({
      where: { tenantId: "00000000-0000-4000-a000-000000000002" },
      data: { tenantId: "00000000-0000-4000-a000-000000000001" },
    });
    expect(mockPrisma.attachment.updateMany).toHaveBeenCalledWith({
      where: { createdById: "user-1", tenantId: "00000000-0000-4000-a000-000000000002" },
      data: { tenantId: "00000000-0000-4000-a000-000000000001" },
    });
    expect(mockPrisma.tenantMember.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", tenantId: "00000000-0000-4000-a000-000000000002" },
    });
    // Bootstrap migration returns early — no redundant upsert
    expect(mockPrisma.tenantMember.upsert).toHaveBeenCalledTimes(1);
    expect(mockPrisma.tenant.delete).not.toHaveBeenCalled();
  });

  it("keeps existing tenant when already in target tenant", async () => {
    mockPrisma.tenantMember.findMany.mockResolvedValue([{ tenantId: "00000000-0000-4000-a000-000000000001" }]);

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
    mockPrisma.tenant.create.mockResolvedValue({ id: "00000000-0000-4000-a000-000000000001" });

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
      .mockResolvedValueOnce({ id: "00000000-0000-4000-a000-000000000001" });
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
    mockPrisma.tenantMember.findMany.mockResolvedValue([{ tenantId: "00000000-0000-4000-a000-000000000003" }]);
    mockPrisma.tenant.findUnique.mockImplementation(async ({ where }: { where: { id?: string; externalId?: string } }) => {
      if (where.externalId === "tenant-acme") return { id: "00000000-0000-4000-a000-000000000001" };
      if (where.id === "00000000-0000-4000-a000-000000000003") return { isBootstrap: false };
      return null;
    });

    const ok = await ensureTenantMembershipForSignIn("user-1", null, {});

    expect(ok).toBe(false);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("allows migration when isBootstrap is true regardless of slug pattern", async () => {
    mockPrisma.tenantMember.findMany.mockResolvedValue([{ tenantId: "00000000-0000-4000-a000-000000000004" }]);
    mockPrisma.tenant.findUnique.mockImplementation(async ({ where }: { where: { id?: string; externalId?: string } }) => {
      if (where.externalId === "tenant-acme") return { id: "00000000-0000-4000-a000-000000000001" };
      if (where.id === "00000000-0000-4000-a000-000000000004") return { isBootstrap: true };
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
      .mockResolvedValueOnce({ id: "00000000-0000-4000-a000-000000000005" });

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
    // withBypassRls is called but findOrCreateSsoTenant returns null
    expect(mockWithBypassRls).toHaveBeenCalledTimes(1);
  });
});

describe("signIn callback", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const signInCallback = (nextAuthInitArgs[0] as any).callbacks.signIn as (
    params: {
      user: { id?: string; email?: string };
      account?: { provider: string } | null;
      profile?: Record<string, unknown> | null;
    },
  ) => Promise<boolean>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockTenantClaimStore.tenantClaim = null;
    mockTenantClaimGetStore.mockReturnValue(mockTenantClaimStore);
    mockExtractTenantClaimValue.mockReturnValue(null);
    mockSlugifyTenant.mockReturnValue(null);
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.tenantMember.findMany.mockResolvedValue([]);
  });

  it("returns true for new user with pre-generated id not in DB", async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);

    const result = await signInCallback({
      user: { id: "pre-gen-id", email: "new@example.com" },
      account: { provider: "google" },
      profile: {},
    });

    expect(result).toBe(true);
    // Should have looked up by email
    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: "new@example.com" },
      select: { id: true },
    });
    // Should NOT have tried to upsert tenant membership
    expect(mockPrisma.tenantMember.upsert).not.toHaveBeenCalled();
  });

  it("uses DB id (not pre-generated id) for existing user", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: "real-db-id" });
    mockPrisma.tenantMember.findMany.mockResolvedValue([]);

    const result = await signInCallback({
      user: { id: "pre-gen-id", email: "existing@example.com" },
      account: { provider: "google" },
      profile: {},
    });

    expect(result).toBe(true);
    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: "existing@example.com" },
      select: { id: true },
    });
  });

  it("returns true when user has no email", async () => {
    const result = await signInCallback({
      user: { id: "some-id" },
      account: { provider: "google" },
      profile: {},
    });

    expect(result).toBe(true);
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("stores tenant claim in tenantClaimStorage for new user", async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockExtractTenantClaimValue.mockReturnValue("acme.com");

    const result = await signInCallback({
      user: { id: "pre-gen-id", email: "new@acme.com" },
      account: { provider: "google" },
      profile: { hd: "acme.com" },
    });

    expect(result).toBe(true);
    expect(mockTenantClaimStore.tenantClaim).toBe("acme.com");
    // ensureTenantMembershipForSignIn should NOT be called for new users
    expect(mockPrisma.tenantMember.upsert).not.toHaveBeenCalled();
  });

  it("does not store tenant claim when no claim is extracted", async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockExtractTenantClaimValue.mockReturnValue(null);

    const result = await signInCallback({
      user: { id: "pre-gen-id", email: "new@example.com" },
      account: { provider: "google" },
      profile: {},
    });

    expect(result).toBe(true);
    expect(mockTenantClaimStore.tenantClaim).toBeNull();
  });

  it("returns true without storing claim when tenantClaimStorage is not active", async () => {
    mockTenantClaimGetStore.mockReturnValue(undefined);
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockExtractTenantClaimValue.mockReturnValue("acme.com");

    const result = await signInCallback({
      user: { id: "pre-gen-id", email: "new@acme.com" },
      account: { provider: "google" },
      profile: { hd: "acme.com" },
    });

    expect(result).toBe(true);
    // Store was undefined, so tenantClaim should remain null
    expect(mockTenantClaimStore.tenantClaim).toBeNull();
  });

  it("calls ensureTenantMembershipForSignIn with DB id for existing user with tenant claim", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: "real-db-id" });
    mockExtractTenantClaimValue.mockReturnValue("tenant-acme");
    mockSlugifyTenant.mockReturnValue("tenant-acme");
    mockPrisma.tenant.findUnique.mockResolvedValue({ id: "00000000-0000-4000-a000-000000000001" });
    mockPrisma.tenantMember.findMany.mockResolvedValue([]);
    mockPrisma.tenantMember.upsert.mockResolvedValue({});

    const result = await signInCallback({
      user: { id: "pre-gen-id", email: "user@acme.com" },
      account: { provider: "google" },
      profile: { hd: "acme.com" },
    });

    expect(result).toBe(true);
    // Tenant member upsert should use real DB id, not pre-generated id
    expect(mockPrisma.tenantMember.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ userId: "real-db-id" }),
      }),
    );
  });

  describe("nodemailer provider", () => {
    it("returns true for new user (no existing DB record)", async () => {
      // user.findUnique returns null twice: once for nodemailer check, once for userId lookup
      mockPrisma.user.findUnique.mockResolvedValue(null);

      const result = await signInCallback({
        user: { id: "pre-gen-id", email: "newuser@example.com" },
        account: { provider: "nodemailer" },
        profile: null,
      });

      expect(result).toBe(true);
      // ensureTenantMembershipForSignIn must NOT be called for new users
      expect(mockPrisma.tenantMember.upsert).not.toHaveBeenCalled();
    });

    it("returns true for existing user in bootstrap tenant", async () => {
      // First findUnique (nodemailer guard): existing user with bootstrap tenant
      mockPrisma.user.findUnique
        .mockResolvedValueOnce({ id: "real-db-id", tenant: { isBootstrap: true } })
        // Second findUnique (userId lookup via email): existing user
        .mockResolvedValueOnce({ id: "real-db-id" });
      mockPrisma.tenantMember.findMany.mockResolvedValue([]);
      mockPrisma.tenantMember.upsert.mockResolvedValue({});

      const result = await signInCallback({
        user: { id: "pre-gen-id", email: "bootstrap@example.com" },
        account: { provider: "nodemailer" },
        profile: null,
      });

      expect(result).toBe(true);
    });

    it("returns false for existing user in SSO (non-bootstrap) tenant", async () => {
      // nodemailer guard findUnique: user exists in a non-bootstrap (SSO) tenant
      mockPrisma.user.findUnique.mockResolvedValueOnce({
        id: "real-db-id",
        tenant: { isBootstrap: false },
      });

      const result = await signInCallback({
        user: { id: "pre-gen-id", email: "sso-user@corp.com" },
        account: { provider: "nodemailer" },
        profile: null,
      });

      expect(result).toBe(false);
      // Should bail out before reaching ensureTenantMembershipForSignIn
      expect(mockPrisma.tenantMember.upsert).not.toHaveBeenCalled();
    });

    it("returns false when ensureTenantMembershipForSignIn throws unexpected error", async () => {
      // First findUnique (nodemailer guard): bootstrap user — allowed through
      mockPrisma.user.findUnique
        .mockResolvedValueOnce({ id: "real-db-id", tenant: { isBootstrap: true } })
        // Second findUnique (userId lookup): user exists
        .mockResolvedValueOnce({ id: "real-db-id" });
      // tenantMember.findMany throws an unexpected error inside ensureTenantMembershipForSignIn
      mockPrisma.tenantMember.findMany.mockRejectedValueOnce(new Error("unexpected DB failure"));

      const result = await signInCallback({
        user: { id: "pre-gen-id", email: "bootstrap@example.com" },
        account: { provider: "nodemailer" },
        profile: null,
      });

      // The try-catch in signIn callback catches the error and returns false
      expect(result).toBe(false);
    });
  });
});

describe("NextAuth basePath", () => {
  it("passes basePath to NextAuth (defaults to /api/auth when env is unset)", () => {
    // nextAuthInitArgs was captured at module import time.
    // In standard test/CI environments NEXT_PUBLIC_BASE_PATH is unset.
    expect(nextAuthInitArgs).toBeDefined();
    const config = nextAuthInitArgs[0] as Record<string, unknown>;
    expect(config).toHaveProperty("basePath");
    expect(typeof config.basePath).toBe("string");
    expect((config.basePath as string).endsWith("/api/auth")).toBe(true);
  });
});

describe("auth events", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const events = (nextAuthInitArgs[0] as any).events as {
    signIn: (params: { user: { id?: string } }) => Promise<void>;
    signOut: (message: { session?: { userId?: string } }) => Promise<void>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("signIn event", () => {
    it("logs AUTH_LOGIN with IP/UA from sessionMetaStorage", async () => {
      mockSessionMetaGetStore.mockReturnValue({
        ip: "192.168.1.1",
        userAgent: "Mozilla/5.0",
        acceptLanguage: "ja",
      });

      await events.signIn({ user: { id: "user-1" } });

      expect(mockLogAudit).toHaveBeenCalledWith({
        scope: "PERSONAL",
        action: "AUTH_LOGIN",
        userId: "user-1",
        ip: "192.168.1.1",
        userAgent: "Mozilla/5.0",
      });
    });

    it("falls back to null when sessionMetaStorage is empty", async () => {
      mockSessionMetaGetStore.mockReturnValue(undefined);

      await events.signIn({ user: { id: "user-1" } });

      expect(mockLogAudit).toHaveBeenCalledWith({
        scope: "PERSONAL",
        action: "AUTH_LOGIN",
        userId: "user-1",
        ip: null,
        userAgent: null,
      });
    });

    it("does not log when user.id is missing", async () => {
      await events.signIn({ user: {} });

      expect(mockLogAudit).not.toHaveBeenCalled();
    });
  });

  describe("signOut event", () => {
    it("logs AUTH_LOGOUT with IP/UA from sessionMetaStorage", async () => {
      mockSessionMetaGetStore.mockReturnValue({
        ip: "10.0.0.1",
        userAgent: "Chrome/120",
        acceptLanguage: "en",
      });

      await events.signOut({ session: { userId: "user-2" } });

      expect(mockLogAudit).toHaveBeenCalledWith({
        scope: "PERSONAL",
        action: "AUTH_LOGOUT",
        userId: "user-2",
        ip: "10.0.0.1",
        userAgent: "Chrome/120",
      });
    });

    it("falls back to null when sessionMetaStorage is empty", async () => {
      mockSessionMetaGetStore.mockReturnValue(undefined);

      await events.signOut({ session: { userId: "user-2" } });

      expect(mockLogAudit).toHaveBeenCalledWith({
        scope: "PERSONAL",
        action: "AUTH_LOGOUT",
        userId: "user-2",
        ip: null,
        userAgent: null,
      });
    });

    it("does not log when session is missing", async () => {
      await events.signOut({});

      expect(mockLogAudit).not.toHaveBeenCalled();
    });
  });
});
