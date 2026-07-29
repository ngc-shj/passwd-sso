import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockPrisma,
  mockWithBypassRls,
  mockExtractTenantClaimValue,
  mockResolveTenantByClaim,
  mockFindOrCreateTenantForClaim,
  mockTenantClaimStore,
  mockTenantClaimGetStore,
  mockSessionMetaGetStore,
  mockLogAudit,
  mockLoggerWarn,
  mockEmitAuthLoginFailure,
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
      findMany: vi.fn(),
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
      count: vi.fn(),
    },
    team: {
      count: vi.fn(),
    },
    $transaction: vi.fn(),
    // C13: audit_log_tenant_migrate is invoked via $executeRaw inside the
    // bootstrap-tenant merge. Default to a no-op so tests that don't
    // explicitly stub it still pass.
    $executeRaw: vi.fn().mockResolvedValue(0),
  };

  return {
    mockPrisma,
    mockWithBypassRls: vi.fn(async (prisma: unknown, fn: (tx: unknown) => unknown) => fn(prisma)),
    mockExtractTenantClaimValue: vi.fn(),
    // C5: @/lib/tenant/tenant-management is mocked at the module boundary
    // rather than driven through mockPrisma. That module's own contents
    // (C2/C3/C4) are owned and tested by a concurrent batch — its exact
    // Prisma call shapes (tenant_claims lookups, advisory locking, P2002
    // retry) are not stable inputs for this file. Mocking the two-function
    // contract (resolveTenantByClaim / findOrCreateTenantForClaim) lets
    // these tests assert exactly what src/auth.ts owns — the twelve-row
    // dispatch and its write ordering — without coupling to unlanded
    // internals that would need rewriting the moment C4 lands.
    mockResolveTenantByClaim: vi.fn(),
    mockFindOrCreateTenantForClaim: vi.fn(),
    mockTenantClaimStore: { tenantClaim: null as string | null },
    mockTenantClaimGetStore: vi.fn(),
    mockSessionMetaGetStore: vi.fn(),
    mockLogAudit: vi.fn(),
    // Stable warn spy: the getLogger() mock must return THIS spy on every call
    // so session-callback tests can observe getLogger().warn(...) (a fresh spy
    // per getLogger() call would be unobservable).
    mockLoggerWarn: vi.fn(),
    mockEmitAuthLoginFailure: vi.fn(),
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

vi.mock("@/lib/auth/session/auth-adapter", () => ({
  createCustomAdapter: vi.fn(() => ({})),
}));

vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
}));

vi.mock("@/lib/auth/session/session-meta", () => ({
  sessionMetaStorage: { getStore: mockSessionMetaGetStore },
}));

vi.mock("@/lib/auth/session/session-cache-helpers", () => ({
  invalidateCachedSessions: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: mockPrisma,
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));

vi.mock("@/lib/tenant/tenant-claim", () => ({
  extractTenantClaimValue: mockExtractTenantClaimValue,
}));

vi.mock("@/lib/tenant/tenant-claim-storage", () => ({
  tenantClaimStorage: { getStore: mockTenantClaimGetStore },
}));

vi.mock("@/lib/tenant/tenant-management", () => ({
  resolveTenantByClaim: mockResolveTenantByClaim,
  findOrCreateTenantForClaim: mockFindOrCreateTenantForClaim,
}));

vi.mock("@/lib/audit/auth-failure", () => ({
  emitAuthLoginFailure: mockEmitAuthLoginFailure,
}));

vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ info: vi.fn(), warn: mockLoggerWarn, error: vi.fn() }),
}));

vi.mock("./auth.config", () => ({
  default: { callbacks: {} },
}));

import { ensureTenantMembershipForSignIn, assertBootstrapSingleMember } from "./auth";
// Real production predicate (NOT mocked): the fail-closed test asserts the
// actual enforcement verdict, not a re-implemented condition (RT5).
import { passkeyEnforcementBlocks } from "@/lib/auth/policy/passkey-enforcement";

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
  // Tenant ids used across the dispatch-table tests below:
  //   TENANT_CLAIMED    — the tenant resolveTenantByClaim resolves "tenant-acme" to.
  //   TENANT_NEW        — the tenant findOrCreateTenantForClaim creates for an
  //                       unregistered claim.
  //   TENANT_BOOTSTRAP  — an existing membership that IS the bootstrap tenant
  //                       (eligible for one-time migration).
  //   TENANT_OTHER      — an existing membership that is NOT the bootstrap
  //                       tenant (a genuine cross-tenant conflict).
  const TENANT_CLAIMED = "00000000-0000-4000-a000-000000000001";
  const TENANT_BOOTSTRAP = "00000000-0000-4000-a000-000000000002";
  const TENANT_OTHER = "00000000-0000-4000-a000-000000000003";
  const TENANT_NEW = "00000000-0000-4000-a000-000000000005";

  beforeEach(() => {
    vi.clearAllMocks();
    mockExtractTenantClaimValue.mockReturnValue("tenant-acme");
    // Row 4/5 default: the claim already resolves to a tenant. Individual
    // tests override to null for the rows where the claim has not been
    // registered yet (8 / 8b / 9a / 9b).
    mockResolveTenantByClaim.mockResolvedValue({ id: TENANT_CLAIMED });
    mockFindOrCreateTenantForClaim.mockResolvedValue({ id: TENANT_NEW });
    mockPrisma.tenant.findUnique.mockImplementation(async ({ where }: { where: { id?: string } }) => {
      if (where.id === TENANT_BOOTSTRAP) return { isBootstrap: true };
      if (where.id === TENANT_OTHER) return { isBootstrap: false };
      return null;
    });
    mockPrisma.tenantMember.findMany.mockResolvedValue([]);
    mockPrisma.tenantMember.upsert.mockResolvedValue({});
    mockPrisma.tenantMember.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.user.update.mockResolvedValue({});
    mockPrisma.account.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.user.count.mockResolvedValue(0);
    mockPrisma.passwordEntry.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.tag.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.folder.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.session.findMany.mockResolvedValue([]);
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

  // Row 1: no claim, no existing membership -> allow.
  it("row 1: allows sign-in when tenant claim is missing and no membership exists", async () => {
    mockExtractTenantClaimValue.mockReturnValue(null);

    const result = await ensureTenantMembershipForSignIn("user-1", null, null);

    expect(result.ok).toBe(true);
    expect(mockWithBypassRls).toHaveBeenCalledTimes(1);
    expect(mockPrisma.tenantMember.findMany).toHaveBeenCalledWith({
      where: { userId: "user-1", deactivatedAt: null },
      select: { tenantId: true },
      orderBy: { createdAt: "asc" },
      take: 2,
    });
    expect(mockResolveTenantByClaim).not.toHaveBeenCalled();
  });

  // Row 2: no claim, existing single-tenant membership -> allow.
  it("row 2: allows sign-in when tenant claim is missing but membership exists", async () => {
    mockExtractTenantClaimValue.mockReturnValue(null);
    mockPrisma.tenantMember.findMany.mockResolvedValue([{ tenantId: TENANT_CLAIMED }]);

    const result = await ensureTenantMembershipForSignIn("user-1", null, null);

    expect(result.ok).toBe(true);
    expect(mockWithBypassRls).toHaveBeenCalledTimes(1);
  });

  // Row 3: no claim, resolveUserTenantId finds >1 active membership -> deny,
  // tenant_mismatch, no write (the throw happens before withBypassRls's
  // dispatch callback is ever reached).
  it("row 3: denies with tenant_mismatch when the claimless user has multiple active memberships", async () => {
    mockExtractTenantClaimValue.mockReturnValue(null);
    mockPrisma.tenantMember.findMany.mockResolvedValue([
      { tenantId: "tenant-a" },
      { tenantId: "tenant-b" },
    ]);

    const result = await ensureTenantMembershipForSignIn("user-1", null, null);

    expect(result).toEqual({ ok: false, reason: "tenant_mismatch", tenantId: null, claim: null });
    expect(mockPrisma.tenantMember.upsert).not.toHaveBeenCalled();
    expect(mockFindOrCreateTenantForClaim).not.toHaveBeenCalled();
  });

  // Row 4: claim resolves, no existing membership -> upsert -> allow.
  it("row 4: joins the resolved claim tenant when the user has no existing membership", async () => {
    const result = await ensureTenantMembershipForSignIn("user-1", null, {});

    expect(result.ok).toBe(true);
    expect(mockResolveTenantByClaim).toHaveBeenCalledWith("tenant-acme", mockPrisma);
    expect(mockFindOrCreateTenantForClaim).not.toHaveBeenCalled();
    expect(mockPrisma.tenantMember.upsert).toHaveBeenCalledWith({
      where: { tenantId_userId: { tenantId: TENANT_CLAIMED, userId: "user-1" } },
      create: { tenantId: TENANT_CLAIMED, userId: "user-1", role: "MEMBER" },
      update: {},
    });
  });

  // Row 5: claim resolves to the user's existing tenant -> upsert -> allow.
  it("row 5: keeps existing tenant when already a member of the claimed tenant", async () => {
    mockPrisma.tenantMember.findMany.mockResolvedValue([{ tenantId: TENANT_CLAIMED }]);

    const result = await ensureTenantMembershipForSignIn("user-1", null, {});

    expect(result.ok).toBe(true);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.tenantMember.upsert).toHaveBeenCalledTimes(1);
  });

  // Regression (acceptance criterion): a second claim registered against the
  // same tenant reaches row 5 through a DIFFERENT resolved claim string —
  // proves the dispatch trusts the resolver's answer, not a hardcoded slug.
  it("regression: a second registered claim resolving to the user's existing tenant still allows sign-in", async () => {
    mockExtractTenantClaimValue.mockReturnValue("alias.example");
    mockResolveTenantByClaim.mockResolvedValue({ id: TENANT_CLAIMED });
    mockPrisma.tenantMember.findMany.mockResolvedValue([{ tenantId: TENANT_CLAIMED }]);

    const result = await ensureTenantMembershipForSignIn("user-1", null, {});

    expect(result.ok).toBe(true);
    expect(mockResolveTenantByClaim).toHaveBeenCalledWith("alias.example", mockPrisma);
    expect(mockPrisma.tenantMember.upsert).toHaveBeenCalledTimes(1);
  });

  // Row 6: claim resolves to a tenant different from the user's existing
  // BOOTSTRAP tenant -> one-time migration -> allow.
  it("row 6: migrates from the bootstrap tenant to the resolved claim tenant", async () => {
    mockPrisma.tenantMember.findMany.mockResolvedValue([{ tenantId: TENANT_BOOTSTRAP }]);

    const result = await ensureTenantMembershipForSignIn("user-1", null, {});

    expect(result.ok).toBe(true);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { tenantId: TENANT_CLAIMED },
    });
    expect(mockPrisma.account.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      data: { tenantId: TENANT_CLAIMED },
    });
    // Verify all tenant-scoped data tables are migrated
    expect(mockPrisma.passwordEntry.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", tenantId: TENANT_BOOTSTRAP },
      data: { tenantId: TENANT_CLAIMED },
    });
    for (const model of ["tag", "folder", "session", "extensionToken"] as const) {
      expect(mockPrisma[model].updateMany).toHaveBeenCalledWith({
        where: { userId: "user-1", tenantId: TENANT_BOOTSTRAP },
        data: { tenantId: TENANT_CLAIMED },
      });
    }
    // C13: audit_log tenant migration is now routed via SECURITY DEFINER
    // stored procedure (audit_log_tenant_migrate) instead of updateMany.
    expect(mockPrisma.$executeRaw).toHaveBeenCalled();
    // passwordEntryHistory has no userId — filtered by tenantId only
    expect(mockPrisma.passwordEntryHistory.updateMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT_BOOTSTRAP },
      data: { tenantId: TENANT_CLAIMED },
    });
    expect(mockPrisma.vaultKey.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", tenantId: TENANT_BOOTSTRAP },
      data: { tenantId: TENANT_CLAIMED },
    });
    // Emergency access, password shares, attachments
    expect(mockPrisma.emergencyAccessGrant.updateMany).toHaveBeenCalledWith({
      where: { ownerId: "user-1", tenantId: TENANT_BOOTSTRAP },
      data: { tenantId: TENANT_CLAIMED },
    });
    expect(mockPrisma.emergencyAccessKeyPair.updateMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT_BOOTSTRAP },
      data: { tenantId: TENANT_CLAIMED },
    });
    expect(mockPrisma.passwordShare.updateMany).toHaveBeenCalledWith({
      where: { createdById: "user-1", tenantId: TENANT_BOOTSTRAP },
      data: { tenantId: TENANT_CLAIMED },
    });
    expect(mockPrisma.shareAccessLog.updateMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT_BOOTSTRAP },
      data: { tenantId: TENANT_CLAIMED },
    });
    expect(mockPrisma.attachment.updateMany).toHaveBeenCalledWith({
      where: { createdById: "user-1", tenantId: TENANT_BOOTSTRAP },
      data: { tenantId: TENANT_CLAIMED },
    });
    expect(mockPrisma.tenantMember.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", tenantId: TENANT_BOOTSTRAP },
    });
    // Bootstrap migration returns early — no redundant upsert
    expect(mockPrisma.tenantMember.upsert).toHaveBeenCalledTimes(1);
    expect(mockPrisma.tenant.delete).not.toHaveBeenCalled();
  });

  // Row 6b: bootstrap tenant has >1 active member — assertBootstrapSingleMember
  // throws before any migration write runs. The throw propagates uncaught out
  // of ensureTenantMembershipForSignIn (the signIn callback's catch maps it to
  // provider_error).
  it("row 6b: propagates assertBootstrapSingleMember's throw with no migration write", async () => {
    mockPrisma.tenantMember.findMany.mockResolvedValue([{ tenantId: TENANT_BOOTSTRAP }]);
    mockPrisma.tenantMember.count.mockResolvedValue(2);

    await expect(
      ensureTenantMembershipForSignIn("user-1", null, {}),
    ).rejects.toThrow(/Bootstrap migration aborted/);

    expect(mockPrisma.user.update).not.toHaveBeenCalled();
    expect(mockPrisma.tenantMember.upsert).not.toHaveBeenCalled();
  });

  // Row 7: claim resolves, but the user's existing tenant is a DIFFERENT,
  // non-bootstrap tenant -> deny tenant_mismatch, no write.
  it("row 7: denies with tenant_mismatch for cross-tenant sign-in to a non-bootstrap tenant", async () => {
    mockPrisma.tenantMember.findMany.mockResolvedValue([{ tenantId: TENANT_OTHER }]);

    const result = await ensureTenantMembershipForSignIn("user-1", null, {});

    expect(result).toEqual({
      ok: false,
      reason: "tenant_mismatch",
      tenantId: TENANT_OTHER,
      claim: "tenant-acme",
    });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockFindOrCreateTenantForClaim).not.toHaveBeenCalled();
    expect(mockPrisma.tenantMember.upsert).not.toHaveBeenCalled();
  });

  // Row 7 variant: isBootstrap is authoritative regardless of which id it is.
  it("row 7: denies migration when isBootstrap is false even for a low-numbered tenant id", async () => {
    mockPrisma.tenantMember.findMany.mockResolvedValue([{ tenantId: TENANT_OTHER }]);
    mockPrisma.tenant.findUnique.mockImplementation(async ({ where }: { where: { id?: string } }) => {
      if (where.id === TENANT_OTHER) return { isBootstrap: false };
      return null;
    });

    const result = await ensureTenantMembershipForSignIn("user-1", null, {});

    expect(result.ok).toBe(false);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  // Row 7 variant: isBootstrap true is authoritative regardless of id pattern
  // (paired with the previous test — same predicate, opposite verdict).
  it("row 6 variant: allows migration when isBootstrap is true for any tenant id", async () => {
    const otherBootstrapId = "00000000-0000-4000-a000-000000000004";
    mockPrisma.tenantMember.findMany.mockResolvedValue([{ tenantId: otherBootstrapId }]);
    mockPrisma.tenant.findUnique.mockImplementation(async ({ where }: { where: { id?: string } }) => {
      if (where.id === otherBootstrapId) return { isBootstrap: true };
      return null;
    });

    const result = await ensureTenantMembershipForSignIn("user-1", null, {});

    expect(result.ok).toBe(true);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
  });

  // Row 8: claim unresolved, no existing membership -> create -> upsert -> allow.
  it("row 8: creates and joins a new tenant for an unregistered claim with no existing membership", async () => {
    mockResolveTenantByClaim.mockResolvedValue(null);

    const result = await ensureTenantMembershipForSignIn("user-1", null, {});

    expect(result.ok).toBe(true);
    expect(mockFindOrCreateTenantForClaim).toHaveBeenCalledWith("tenant-acme", mockPrisma);
    expect(mockPrisma.tenantMember.upsert).toHaveBeenCalledWith({
      where: { tenantId_userId: { tenantId: TENANT_NEW, userId: "user-1" } },
      create: { tenantId: TENANT_NEW, userId: "user-1", role: "MEMBER" },
      update: {},
    });
  });

  // Row 8b (defensive, D2): findOrCreateTenantForClaim returns null (claim
  // collides with a revoked tenant_claims row) -> deny tenant_mismatch, no write.
  it("row 8b: denies with tenant_mismatch when creation returns null (defensive, D2)", async () => {
    mockResolveTenantByClaim.mockResolvedValue(null);
    mockFindOrCreateTenantForClaim.mockResolvedValue(null);

    const result = await ensureTenantMembershipForSignIn("user-1", null, {});

    expect(result).toEqual({ ok: false, reason: "tenant_mismatch", tenantId: null, claim: "tenant-acme" });
    expect(mockPrisma.tenantMember.upsert).not.toHaveBeenCalled();
  });

  // An unexpected (non-null-returning) error from findOrCreateTenantForClaim
  // must propagate uncaught, same as the pre-existing findOrCreateSsoTenant
  // contract. The internal retry mechanics (P2002, etc.) are C4's own
  // obligation, tested in tenant-management.test.ts — this only pins that
  // ensureTenantMembershipForSignIn does not swallow the error.
  it("propagates an unexpected error thrown by findOrCreateTenantForClaim", async () => {
    mockResolveTenantByClaim.mockResolvedValue(null);
    mockFindOrCreateTenantForClaim.mockRejectedValueOnce(new Error("slug conflict"));

    await expect(
      ensureTenantMembershipForSignIn("user-1", null, {}),
    ).rejects.toThrow("slug conflict");
  });

  // Row 9a (load-bearing, round-3 CR10): claim unresolved, existing
  // membership IS the bootstrap tenant -> create THEN migrate -> allow. Denying
  // here would regress the primary bootstrap->SSO onboarding path.
  it("row 9a: creates the claim tenant and migrates from bootstrap in one sign-in", async () => {
    mockResolveTenantByClaim.mockResolvedValue(null);
    mockPrisma.tenantMember.findMany.mockResolvedValue([{ tenantId: TENANT_BOOTSTRAP }]);

    const result = await ensureTenantMembershipForSignIn("user-1", null, {});

    expect(result.ok).toBe(true);
    expect(mockFindOrCreateTenantForClaim).toHaveBeenCalledWith("tenant-acme", mockPrisma);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { tenantId: TENANT_NEW },
    });
    expect(mockPrisma.tenantMember.upsert).toHaveBeenCalledWith({
      where: { tenantId_userId: { tenantId: TENANT_NEW, userId: "user-1" } },
      create: { tenantId: TENANT_NEW, userId: "user-1", role: "MEMBER" },
      update: {},
    });
  });

  // Row 9a defensive null (D2): same as row 8b but reached via the bootstrap
  // branch -> deny tenant_mismatch, no write.
  it("row 9a: denies with tenant_mismatch when creation returns null on the bootstrap branch (defensive, D2)", async () => {
    mockResolveTenantByClaim.mockResolvedValue(null);
    mockFindOrCreateTenantForClaim.mockResolvedValue(null);
    mockPrisma.tenantMember.findMany.mockResolvedValue([{ tenantId: TENANT_BOOTSTRAP }]);

    const result = await ensureTenantMembershipForSignIn("user-1", null, {});

    expect(result).toEqual({ ok: false, reason: "tenant_mismatch", tenantId: TENANT_BOOTSTRAP, claim: "tenant-acme" });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.tenantMember.upsert).not.toHaveBeenCalled();
  });

  // Row 9b: the reported production bug. Claim unresolved AND the existing
  // tenant is neither the claimed tenant nor bootstrap -> deny
  // tenant_claim_unmapped (not tenant_mismatch — the operator action differs),
  // no write, and findOrCreateTenantForClaim must never be reached (D2: no
  // create on a path that goes on to deny).
  it("row 9b: denies with tenant_claim_unmapped for an unregistered claim and a non-bootstrap existing tenant", async () => {
    mockResolveTenantByClaim.mockResolvedValue(null);
    mockPrisma.tenantMember.findMany.mockResolvedValue([{ tenantId: TENANT_OTHER }]);

    const result = await ensureTenantMembershipForSignIn("user-1", null, {});

    expect(result).toEqual({
      ok: false,
      reason: "tenant_claim_unmapped",
      tenantId: TENANT_OTHER,
      claim: "tenant-acme",
    });
    expect(mockFindOrCreateTenantForClaim).not.toHaveBeenCalled();
    expect(mockPrisma.tenantMember.upsert).not.toHaveBeenCalled();
  });

  // Row 10: resolveUserTenantIdFromClient (called AFTER resolveTenantByClaim,
  // per the mandated ordering) finds >1 active membership and throws. The
  // throw propagates uncaught (mapped to provider_error at the signIn
  // callback). Proves the reorder: findOrCreateTenantForClaim must never be
  // reached, because the throw happens before the dispatch ever branches.
  it("row 10: propagates the multi-membership throw with no write and no create call", async () => {
    mockPrisma.tenantMember.findMany.mockResolvedValue([
      { tenantId: "tenant-a" },
      { tenantId: "tenant-b" },
    ]);

    await expect(
      ensureTenantMembershipForSignIn("user-1", null, {}),
    ).rejects.toThrow("MULTI_TENANT_MEMBERSHIP_NOT_SUPPORTED");

    expect(mockFindOrCreateTenantForClaim).not.toHaveBeenCalled();
    expect(mockPrisma.tenantMember.upsert).not.toHaveBeenCalled();
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
    mockResolveTenantByClaim.mockResolvedValue({ id: "00000000-0000-4000-a000-000000000001" });
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

  // T11 (round-2): the emit is asserted at the signIn callback level, not at
  // the dispatch level. Rows 1-10 of ensureTenantMembershipForSignIn's own
  // suite only test the RETURNED reason; a forgotten hard-coded
  // reason: "tenant_mismatch" at the emit site (src/auth.ts's signIn
  // callback) would leave every one of those tests green while the audit
  // trail is wrong. These two tests drive the real signIn callback and
  // assert what actually reaches emitAuthLoginFailure.
  it("emits tenant_claim_unmapped via emitAuthLoginFailure (row 9b, driven through signIn)", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: "real-db-id" });
    mockExtractTenantClaimValue.mockReturnValue("newco.example");
    mockResolveTenantByClaim.mockResolvedValue(null);
    mockPrisma.tenantMember.findMany.mockResolvedValue([{ tenantId: "00000000-0000-4000-a000-000000000003" }]);
    mockPrisma.tenant.findUnique.mockResolvedValue({ isBootstrap: false });

    const result = await signInCallback({
      user: { id: "pre-gen-id", email: "user@newco.example" },
      account: { provider: "google" },
      profile: { hd: "newco.example" },
    });

    expect(result).toBe(false);
    expect(mockEmitAuthLoginFailure).toHaveBeenCalledWith({
      email: "user@newco.example",
      provider: "google",
      reason: "tenant_claim_unmapped",
      tenantId: "00000000-0000-4000-a000-000000000003",
      userId: "real-db-id",
      claim: "newco.example",
    });
    expect(mockPrisma.tenantMember.upsert).not.toHaveBeenCalled();
  });

  it("emits tenant_mismatch via emitAuthLoginFailure (row 7, driven through signIn)", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: "real-db-id" });
    mockExtractTenantClaimValue.mockReturnValue("tenant-acme");
    mockResolveTenantByClaim.mockResolvedValue({ id: "00000000-0000-4000-a000-000000000001" });
    mockPrisma.tenantMember.findMany.mockResolvedValue([{ tenantId: "00000000-0000-4000-a000-000000000003" }]);
    mockPrisma.tenant.findUnique.mockResolvedValue({ isBootstrap: false });

    const result = await signInCallback({
      user: { id: "pre-gen-id", email: "user@acme.com" },
      account: { provider: "google" },
      profile: { hd: "acme.com" },
    });

    expect(result).toBe(false);
    expect(mockEmitAuthLoginFailure).toHaveBeenCalledWith({
      email: "user@acme.com",
      provider: "google",
      reason: "tenant_mismatch",
      tenantId: "00000000-0000-4000-a000-000000000003",
      userId: "real-db-id",
      claim: "tenant-acme",
    });
    expect(mockPrisma.tenantMember.upsert).not.toHaveBeenCalled();
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

describe("session callback — passkey enforcement fail-closed", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sessionCallback = (nextAuthInitArgs[0] as any).callbacks.session as (
    params: {
      session: { expires: string };
      user: { id: string; name?: string | null; email?: string | null; image?: string | null };
    },
  ) => Promise<{
    user: {
      id: string;
      hasPasskey: boolean;
      requirePasskey: boolean;
      requirePasskeyEnabledAt: string | null;
      passkeyGracePeriodDays: number | null;
      fetchFavicons: boolean;
    };
    expires: string;
  }>;

  // The safe-blocking bundle the catch must install on fetch failure. Kept in
  // one place so the four-field expectation is stated once (RT3).
  const FAIL_CLOSED = {
    requirePasskey: true,
    hasPasskey: false,
    requirePasskeyEnabledAt: null,
    passkeyGracePeriodDays: null,
  } as const;

  const baseParams = {
    session: { expires: "2099-01-01T00:00:00.000Z" },
    user: { id: "user-1", name: "U", email: "u@example.com", image: null },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockWithBypassRls.mockImplementation(
      async (prisma: unknown, fn: (tx: unknown) => unknown) => fn(prisma),
    );
  });

  it("fails closed when the passkey-enforcement fetch throws (blocks, does not fail open)", async () => {
    // Simulate a transient DB/Redis failure inside the withBypassRls fetch.
    mockWithBypassRls.mockRejectedValueOnce(new Error("db down"));

    const result = await sessionCallback(baseParams);

    // All four enforcement fields fail closed (asserting all four, not just
    // requirePasskey, is what makes the partial-fail-open guard provable: a
    // stale non-null enabledAt would fail requirePasskeyEnabledAt === null).
    expect(result.user.requirePasskey).toBe(FAIL_CLOSED.requirePasskey);
    expect(result.user.hasPasskey).toBe(FAIL_CLOSED.hasPasskey);
    expect(result.user.requirePasskeyEnabledAt).toBe(FAIL_CLOSED.requirePasskeyEnabledAt);
    expect(result.user.passkeyGracePeriodDays).toBe(FAIL_CLOSED.passkeyGracePeriodDays);

    // And the REAL production predicate confirms the enforcement gate blocks.
    expect(passkeyEnforcementBlocks(result.user)).toBe(true);
  });

  it("fails closed when a successful fetch returns no tenant (row vanished / FK-orphaned)", async () => {
    // User.tenantId is a non-null FK (onDelete: Restrict), so a null tenant on
    // a SUCCESSFUL query means the user row disappeared mid-session — no policy
    // to trust. Must fail closed (throw → catch bundle), not default to false.
    mockPrisma.webAuthnCredential.count.mockResolvedValueOnce(0);
    mockPrisma.user.findUnique.mockResolvedValueOnce(null);

    const result = await sessionCallback(baseParams);

    expect(result.user.requirePasskey).toBe(FAIL_CLOSED.requirePasskey);
    expect(result.user.hasPasskey).toBe(FAIL_CLOSED.hasPasskey);
    expect(result.user.requirePasskeyEnabledAt).toBe(FAIL_CLOSED.requirePasskeyEnabledAt);
    expect(result.user.passkeyGracePeriodDays).toBe(FAIL_CLOSED.passkeyGracePeriodDays);
    expect(passkeyEnforcementBlocks(result.user)).toBe(true);
  });

  it("passes the real tenant values through on the happy path (fetch succeeds)", async () => {
    const enabledAt = new Date("2020-01-01T00:00:00.000Z");
    mockPrisma.webAuthnCredential.count.mockResolvedValueOnce(0);
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      fetchFavicons: true,
      tenant: {
        requirePasskey: true,
        requirePasskeyEnabledAt: enabledAt,
        passkeyGracePeriodDays: 7,
      },
    });

    const result = await sessionCallback(baseParams);

    expect(result.user.requirePasskey).toBe(true);
    expect(result.user.hasPasskey).toBe(false);
    expect(result.user.requirePasskeyEnabledAt).toBe(enabledAt.toISOString());
    expect(result.user.passkeyGracePeriodDays).toBe(7);
  });

  it("does not block a passkey-holding user on the happy path (fail-closed, not always-closed)", async () => {
    // requirePasskey tenant, grace expired, but the user HAS a passkey.
    mockPrisma.webAuthnCredential.count.mockResolvedValueOnce(1);
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      fetchFavicons: false,
      tenant: {
        requirePasskey: true,
        requirePasskeyEnabledAt: null, // immediate enforcement window
        passkeyGracePeriodDays: null,
      },
    });

    const result = await sessionCallback(baseParams);

    expect(result.user.hasPasskey).toBe(true);
    // The real predicate must NOT block a user who has a passkey — proves the
    // fix is fail-CLOSED (blocks the unknown state), not always-closed.
    expect(passkeyEnforcementBlocks(result.user)).toBe(false);
  });

  it("still logs auth.session.passkey_data_fetch_failed on fetch failure (ops visibility)", async () => {
    mockWithBypassRls.mockRejectedValueOnce(new Error("db down"));

    await sessionCallback(baseParams);

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" }),
      "auth.session.passkey_data_fetch_failed",
    );
  });
});
