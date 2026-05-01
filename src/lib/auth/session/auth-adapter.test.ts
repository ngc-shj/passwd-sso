import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockPrismaSession, mockPrismaUser, mockPrismaTenant, mockPrismaTenantMember, mockPrismaAccount, mockPrismaTransaction, mockSessionMetaGetStore, mockTenantClaimStoreGetStore, mockFindOrCreateSsoTenant, mockWithBypassRls, mockTxSession, mockTxTenant, mockLogAudit, mockCreateNotification, mockResolveEffectiveSessionTimeouts, mockInvalidateCachedSessions } = vi.hoisted(() => ({
  mockPrismaSession: {
    create: vi.fn(),
    update: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    delete: vi.fn(),
  },
  mockPrismaUser: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  mockPrismaTenant: {
    create: vi.fn(),
    findUnique: vi.fn(),
  },
  mockPrismaTenantMember: {
    create: vi.fn(),
  },
  mockPrismaAccount: {
    create: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    delete: vi.fn(),
  },
  mockPrismaTransaction: vi.fn(),
  mockSessionMetaGetStore: vi.fn(),
  mockTenantClaimStoreGetStore: vi.fn(),
  mockFindOrCreateSsoTenant: vi.fn(),
  mockWithBypassRls: vi.fn(async (_prisma: unknown, fn: () => unknown) => fn()),
  mockTxSession: {
    create: vi.fn(),
    findMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  mockTxTenant: {
    findUnique: vi.fn(),
  },
  mockLogAudit: vi.fn(),
  mockCreateNotification: vi.fn(),
  mockResolveEffectiveSessionTimeouts: vi.fn(),
  mockInvalidateCachedSessions: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    session: mockPrismaSession,
    user: mockPrismaUser,
    tenant: mockPrismaTenant,
    tenantMember: mockPrismaTenantMember,
    account: mockPrismaAccount,
    $transaction: mockPrismaTransaction,
  },
}));
vi.mock("@/lib/auth/session/session-meta", () => ({
  sessionMetaStorage: { getStore: mockSessionMetaGetStore },
}));
vi.mock("@/lib/tenant/tenant-claim-storage", () => ({
  tenantClaimStorage: { getStore: mockTenantClaimStoreGetStore },
}));
vi.mock("@/lib/tenant/tenant-management", () => ({
  findOrCreateSsoTenant: mockFindOrCreateSsoTenant,
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));
vi.mock("@auth/prisma-adapter", () => ({
  PrismaAdapter: () => ({
    // Base adapter methods (not used in tests but spread into custom adapter)
  }),
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
}));
vi.mock("@/lib/notification", () => ({
  createNotification: mockCreateNotification,
}));
vi.mock("@/lib/auth/policy/new-device-detection", () => ({
  checkNewDeviceAndNotify: vi.fn(),
}));
vi.mock("@/lib/auth/session/session-timeout", () => ({
  resolveEffectiveSessionTimeouts: mockResolveEffectiveSessionTimeouts,
}));
vi.mock("@/lib/auth/session/session-cache-helpers", () => ({
  invalidateCachedSessions: mockInvalidateCachedSessions,
}));

import { createCustomAdapter } from "./auth-adapter";
import {
  expectInvalidatedAfterCommit,
  expectNotInvalidatedOnDbThrow,
} from "@/__tests__/helpers/session-cache-assertions";

describe("createCustomAdapter", () => {
  const expires = new Date("2025-06-01T00:00:00Z");

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no pending tenant claim
    mockTenantClaimStoreGetStore.mockReturnValue({ tenantClaim: null });
    mockFindOrCreateSsoTenant.mockResolvedValue(null);
    mockPrismaTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        tenant: { ...mockPrismaTenant, findUnique: mockTxTenant.findUnique },
        user: mockPrismaUser,
        tenantMember: mockPrismaTenantMember,
        session: mockTxSession,
      }),
    );
    // Default: no session limit
    mockTxTenant.findUnique.mockResolvedValue({ maxConcurrentSessions: null });
    mockTxSession.findMany.mockResolvedValue([]);
    // Default: generous resolver values (no tenant/team restrictions hit in tests)
    mockResolveEffectiveSessionTimeouts.mockResolvedValue({
      idleMinutes: 480,       // 8h
      absoluteMinutes: 43200, // 30d
      tenantId: "tenant-1",
    });
  });

  describe("createUser", () => {
    it("creates bootstrap tenant, user, and owner membership", async () => {
      mockPrismaTenant.create.mockResolvedValue({ id: "tenant-1" });
      mockPrismaUser.create.mockResolvedValue({
        id: "user-1",
        name: "Test User",
        email: "test@example.com",
        image: "https://example.com/avatar.png",
        emailVerified: null,
      });
      mockPrismaTenantMember.create.mockResolvedValue({ id: "tm-1" });

      const adapter = createCustomAdapter();
      const user = await adapter.createUser!({
        id: "",
        name: "Test User",
        email: "test@example.com",
        image: "https://example.com/avatar.png",
        emailVerified: null,
      });

      expect(mockPrismaTenant.create).toHaveBeenCalledTimes(1);
      expect(mockPrismaTenant.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ isBootstrap: true }),
        select: { id: true },
      });
      expect(mockPrismaUser.create).toHaveBeenCalledWith({
        data: {
          name: "Test User",
          email: "test@example.com",
          image: "https://example.com/avatar.png",
          emailVerified: null,
          tenantId: "tenant-1",
        },
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
          emailVerified: true,
        },
      });
      expect(mockPrismaTenantMember.create).toHaveBeenCalledWith({
        data: {
          tenantId: "tenant-1",
          userId: "user-1",
          role: "OWNER",
        },
      });
      expect(user).toEqual({
        id: "user-1",
        name: "Test User",
        email: "test@example.com",
        image: "https://example.com/avatar.png",
        emailVerified: null,
      });
    });

    it("places user in SSO tenant when tenant claim is pending", async () => {
      mockTenantClaimStoreGetStore.mockReturnValue({ tenantClaim: "acme.com" });
      mockFindOrCreateSsoTenant.mockResolvedValue({ id: "sso-tenant-1" });
      mockPrismaUser.create.mockResolvedValue({
        id: "user-2",
        name: "SSO User",
        email: "user@acme.com",
        image: null,
        emailVerified: null,
      });
      mockPrismaTenantMember.create.mockResolvedValue({ id: "tm-2" });

      const adapter = createCustomAdapter();
      await adapter.createUser!({
        id: "",
        name: "SSO User",
        email: "user@acme.com",
        image: null,
        emailVerified: null,
      });

      // Bootstrap tenant.create should NOT be called
      expect(mockPrismaTenant.create).not.toHaveBeenCalled();
      expect(mockFindOrCreateSsoTenant).toHaveBeenCalledWith("acme.com");
      // User should be created with SSO tenant ID
      expect(mockPrismaUser.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ tenantId: "sso-tenant-1" }),
        }),
      );
      // Membership should be MEMBER, not OWNER
      expect(mockPrismaTenantMember.create).toHaveBeenCalledWith({
        data: {
          tenantId: "sso-tenant-1",
          userId: "user-2",
          role: "MEMBER",
        },
      });
    });

    it("falls back to bootstrap when findOrCreateSsoTenant returns null", async () => {
      mockTenantClaimStoreGetStore.mockReturnValue({ tenantClaim: "invalid" });
      mockFindOrCreateSsoTenant.mockResolvedValue(null);
      mockPrismaTenant.create.mockResolvedValue({ id: "bootstrap-1" });
      mockPrismaUser.create.mockResolvedValue({
        id: "user-3",
        name: "Fallback User",
        email: "user@invalid.test",
        image: null,
        emailVerified: null,
      });
      mockPrismaTenantMember.create.mockResolvedValue({ id: "tm-3" });

      const adapter = createCustomAdapter();
      await adapter.createUser!({
        id: "",
        name: "Fallback User",
        email: "user@invalid.test",
        image: null,
        emailVerified: null,
      });

      // Bootstrap tenant should be created as fallback
      expect(mockPrismaTenant.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ isBootstrap: true }),
        select: { id: true },
      });
      expect(mockPrismaTenantMember.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ role: "OWNER" }),
      });
    });

    it("creates bootstrap tenant when no tenant claim store exists", async () => {
      mockTenantClaimStoreGetStore.mockReturnValue(undefined);
      mockPrismaTenant.create.mockResolvedValue({ id: "bootstrap-2" });
      mockPrismaUser.create.mockResolvedValue({
        id: "user-4",
        name: "No Store User",
        email: "user@example.com",
        image: null,
        emailVerified: null,
      });
      mockPrismaTenantMember.create.mockResolvedValue({ id: "tm-4" });

      const adapter = createCustomAdapter();
      await adapter.createUser!({
        id: "",
        name: "No Store User",
        email: "user@example.com",
        image: null,
        emailVerified: null,
      });

      expect(mockFindOrCreateSsoTenant).not.toHaveBeenCalled();
      expect(mockPrismaTenant.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ isBootstrap: true }),
        select: { id: true },
      });
      expect(mockPrismaTenantMember.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ role: "OWNER" }),
      });
    });

    it("propagates error when findOrCreateSsoTenant throws", async () => {
      mockTenantClaimStoreGetStore.mockReturnValue({ tenantClaim: "acme.com" });
      mockFindOrCreateSsoTenant.mockRejectedValue(new Error("DB down"));

      const adapter = createCustomAdapter();
      await expect(
        adapter.createUser!({
          id: "",
          name: "Error User",
          email: "user@acme.com",
          image: null,
          emailVerified: null,
        }),
      ).rejects.toThrow("DB down");

      // Should not fall back to bootstrap tenant
      expect(mockPrismaTenant.create).not.toHaveBeenCalled();
    });
  });

  describe("createSession", () => {
    it("captures IP and userAgent from sessionMetaStorage", async () => {
      mockSessionMetaGetStore.mockReturnValue({
        ip: "192.168.1.1",
        userAgent: "Mozilla/5.0",
      });
      mockPrismaUser.findUnique.mockResolvedValue({ tenantId: "tenant-1" });
      mockTxSession.create.mockResolvedValue({
        sessionToken: "tok-1",
        userId: "u-1",
        expires,
      });

      const adapter = createCustomAdapter();
      const result = await adapter.createSession!({
        sessionToken: "tok-1",
        userId: "u-1",
        expires,
      });

      // createSession now overrides Auth.js's default expires with resolver
      // values. Default resolver mock returns idleMinutes=480 → expires = now + 480min.
      // We assert on field presence and resolver-sourced expires, not the caller-passed expires.
      const call = mockTxSession.create.mock.calls[0][0];
      expect(call.data).toMatchObject({
        sessionToken: "tok-1",
        userId: "u-1",
        tenantId: "tenant-1",
        ipAddress: "192.168.1.1",
        userAgent: "Mozilla/5.0",
        provider: null,
      });
      expect(call.data.expires).toBeInstanceOf(Date);
      expect(call.data.expires.getTime()).not.toBe(expires.getTime()); // overridden, not pass-through
      expect(call.select).toEqual({ sessionToken: true, userId: true, expires: true });
      expect(result).toEqual({
        sessionToken: "tok-1",
        userId: "u-1",
        expires,
      });
    });

    it("records provider from sessionMetaStorage on the session row", async () => {
      mockSessionMetaGetStore.mockReturnValue({
        ip: null,
        userAgent: null,
        provider: "google",
      });
      mockPrismaUser.findUnique.mockResolvedValue({ tenantId: "tenant-1" });
      mockTxSession.create.mockResolvedValue({
        sessionToken: "tok-prov",
        userId: "u-1",
        expires,
      });

      const adapter = createCustomAdapter();
      await adapter.createSession!({ sessionToken: "tok-prov", userId: "u-1", expires });

      expect(mockTxSession.create.mock.calls[0][0].data.provider).toBe("google");
      expect(mockResolveEffectiveSessionTimeouts).toHaveBeenCalledWith("u-1", "google");
    });

    it("sets null when sessionMetaStorage has no store (undefined)", async () => {
      mockSessionMetaGetStore.mockReturnValue(undefined);
      mockPrismaUser.findUnique.mockResolvedValue({ tenantId: "tenant-2" });
      mockTxSession.create.mockResolvedValue({
        sessionToken: "tok-2",
        userId: "u-2",
        expires,
      });

      const adapter = createCustomAdapter();
      await adapter.createSession!({
        sessionToken: "tok-2",
        userId: "u-2",
        expires,
      });

      expect(mockTxSession.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          ipAddress: null,
          userAgent: null,
        }),
        select: {
          sessionToken: true,
          userId: true,
          expires: true,
        },
      });
    });

    it("truncates userAgent to 512 characters", async () => {
      const longUA = "X".repeat(1000);
      mockSessionMetaGetStore.mockReturnValue({
        ip: "10.0.0.1",
        userAgent: longUA,
      });
      mockPrismaUser.findUnique.mockResolvedValue({ tenantId: "tenant-3" });
      mockTxSession.create.mockResolvedValue({
        sessionToken: "tok-3",
        userId: "u-3",
        expires,
      });

      const adapter = createCustomAdapter();
      await adapter.createSession!({
        sessionToken: "tok-3",
        userId: "u-3",
        expires,
      });

      expect(mockTxSession.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userAgent: "X".repeat(512),
        }),
        select: {
          sessionToken: true,
          userId: true,
          expires: true,
        },
      });
    });

    it("evicts oldest session when at concurrent limit", async () => {
      mockSessionMetaGetStore.mockReturnValue({ ip: "10.0.0.1", userAgent: "new-device" });
      mockPrismaUser.findUnique.mockResolvedValue({ tenantId: "tenant-1" });
      mockTxTenant.findUnique.mockResolvedValue({ maxConcurrentSessions: 2 });
      mockTxSession.findMany.mockResolvedValue([
        { id: "old-s1", sessionToken: "old-tok-1", ipAddress: "1.1.1.1", userAgent: "old-1" },
        { id: "old-s2", sessionToken: "old-tok-2", ipAddress: "2.2.2.2", userAgent: "old-2" },
      ]);
      mockTxSession.deleteMany.mockResolvedValue({ count: 1 });
      mockTxSession.create.mockResolvedValue({
        sessionToken: "tok-new",
        userId: "u-1",
        expires,
      });

      const adapter = createCustomAdapter();
      await adapter.createSession!({
        sessionToken: "tok-new",
        userId: "u-1",
        expires,
      });

      // Should evict oldest session (old-s1) to make room
      expect(mockTxSession.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ["old-s1"] } },
      });

      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "SESSION_EVICTED",
          targetId: "old-s1",
        }),
      );

      expect(mockCreateNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "SESSION_EVICTED",
          userId: "u-1",
        }),
      );

      // R3: cache invalidation for evicted token
      expectInvalidatedAfterCommit(mockInvalidateCachedSessions, ["old-tok-1"]);
    });

    it("evicts multiple sessions when well over limit", async () => {
      mockSessionMetaGetStore.mockReturnValue({ ip: "10.0.0.1", userAgent: "new" });
      mockPrismaUser.findUnique.mockResolvedValue({ tenantId: "tenant-1" });
      mockTxTenant.findUnique.mockResolvedValue({ maxConcurrentSessions: 2 });
      mockTxSession.findMany.mockResolvedValue([
        { id: "s1", sessionToken: "tok-s1", ipAddress: "1.1.1.1", userAgent: "ua1" },
        { id: "s2", sessionToken: "tok-s2", ipAddress: "2.2.2.2", userAgent: "ua2" },
        { id: "s3", sessionToken: "tok-s3", ipAddress: "3.3.3.3", userAgent: "ua3" },
      ]);
      mockTxSession.deleteMany.mockResolvedValue({ count: 2 });
      mockTxSession.create.mockResolvedValue({
        sessionToken: "tok-new",
        userId: "u-1",
        expires,
      });

      const adapter = createCustomAdapter();
      await adapter.createSession!({
        sessionToken: "tok-new",
        userId: "u-1",
        expires,
      });

      // Should evict s1 and s2 (oldest 2) to make room for new session
      expect(mockTxSession.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ["s1", "s2"] } },
      });

      // R3: cache invalidation for both evicted tokens
      expectInvalidatedAfterCommit(mockInvalidateCachedSessions, [
        "tok-s1",
        "tok-s2",
      ]);
    });

    it("does not evict when under concurrent limit", async () => {
      mockSessionMetaGetStore.mockReturnValue({ ip: "10.0.0.1", userAgent: "ok" });
      mockPrismaUser.findUnique.mockResolvedValue({ tenantId: "tenant-1" });
      mockTxTenant.findUnique.mockResolvedValue({ maxConcurrentSessions: 3 });
      mockTxSession.findMany.mockResolvedValue([
        { id: "s1", sessionToken: "tok-s1", ipAddress: "1.1.1.1", userAgent: "ua1" },
      ]);
      mockTxSession.create.mockResolvedValue({
        sessionToken: "tok-ok",
        userId: "u-1",
        expires,
      });

      const adapter = createCustomAdapter();
      await adapter.createSession!({
        sessionToken: "tok-ok",
        userId: "u-1",
        expires,
      });

      expect(mockTxSession.deleteMany).not.toHaveBeenCalled();
      expect(mockLogAudit).not.toHaveBeenCalled();
      // No eviction → no cache invalidation.
      expectNotInvalidatedOnDbThrow(mockInvalidateCachedSessions);
    });

    it("does not invalidate cache when $transaction throws (sequencing invariant)", async () => {
      mockSessionMetaGetStore.mockReturnValue({ ip: "10.0.0.1", userAgent: "x" });
      mockPrismaUser.findUnique.mockResolvedValue({ tenantId: "tenant-1" });
      mockPrismaTransaction.mockRejectedValue(new Error("tx rolled back"));

      const adapter = createCustomAdapter();
      await expect(
        adapter.createSession!({
          sessionToken: "tok-fail",
          userId: "u-1",
          expires,
        }),
      ).rejects.toThrow("tx rolled back");

      expectNotInvalidatedOnDbThrow(mockInvalidateCachedSessions);
    });
  });

  describe("linkAccount", () => {
    it("writes account with resolved tenantId", async () => {
      mockPrismaUser.findUnique.mockResolvedValue({ tenantId: "tenant-1" });
      mockPrismaAccount.create.mockResolvedValue({ id: "acc-1" });

      const adapter = createCustomAdapter();
      await adapter.linkAccount!({
        userId: "u-1",
        type: "oidc",
        provider: "google",
        providerAccountId: "google-1",
        access_token: "access",
        token_type: "bearer",
        session_state: 42 as unknown as string,
      });

      expect(mockPrismaAccount.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: "u-1",
          tenantId: "tenant-1",
          provider: "google",
          providerAccountId: "google-1",
          session_state: "42",
        }),
        select: { id: true },
      });
    });

    it("throws when user does not exist", async () => {
      mockPrismaUser.findUnique.mockResolvedValue(null);

      const adapter = createCustomAdapter();
      await expect(
        adapter.linkAccount!({
          userId: "missing-user",
          type: "oidc",
          provider: "google",
          providerAccountId: "google-1",
        }),
      ).rejects.toThrow("USER_NOT_FOUND");
      expect(mockPrismaAccount.create).not.toHaveBeenCalled();
    });

    it("encrypts refresh_token, access_token, and id_token before persisting", async () => {
      mockPrismaUser.findUnique.mockResolvedValue({ tenantId: "tenant-1" });
      mockPrismaAccount.create.mockResolvedValue({ id: "acc-1" });

      const adapter = createCustomAdapter();
      await adapter.linkAccount!({
        userId: "u-1",
        type: "oidc",
        provider: "google",
        providerAccountId: "google-2",
        refresh_token: "rt-plain",
        access_token: "at-plain",
        id_token: "idt-plain",
        token_type: "bearer",
      });

      const callArgs = mockPrismaAccount.create.mock.calls[0][0];
      // Ciphertext does not contain the plaintext anywhere.
      expect(callArgs.data.refresh_token).toMatch(/^psoenc1:/);
      expect(callArgs.data.refresh_token).not.toContain("rt-plain");
      expect(callArgs.data.access_token).toMatch(/^psoenc1:/);
      expect(callArgs.data.access_token).not.toContain("at-plain");
      expect(callArgs.data.id_token).toMatch(/^psoenc1:/);
      expect(callArgs.data.id_token).not.toContain("idt-plain");
    });

    it("leaves null/undefined token fields null after encryption", async () => {
      mockPrismaUser.findUnique.mockResolvedValue({ tenantId: "tenant-1" });
      mockPrismaAccount.create.mockResolvedValue({ id: "acc-1" });

      const adapter = createCustomAdapter();
      await adapter.linkAccount!({
        userId: "u-1",
        type: "oidc",
        provider: "google",
        providerAccountId: "google-3",
        // No tokens supplied
      });

      const callArgs = mockPrismaAccount.create.mock.calls[0][0];
      expect(callArgs.data.refresh_token).toBeNull();
      expect(callArgs.data.access_token).toBeNull();
      expect(callArgs.data.id_token).toBeNull();
    });
  });

  describe("updateSession", () => {
    afterEach(() => vi.useRealTimers());

    function seedSession(params: {
      userId?: string;
      createdAt: Date;
      lastActiveAt: Date;
      tenantId?: string;
      provider?: string | null;
    }) {
      mockPrismaSession.findUnique.mockResolvedValue({
        userId: params.userId ?? "u-1",
        createdAt: params.createdAt,
        lastActiveAt: params.lastActiveAt,
        tenantId: params.tenantId ?? "tenant-1",
        provider: params.provider ?? null,
      });
    }

    it("reads current session with provider and updates expires from resolver", async () => {
      const now = new Date("2025-03-15T12:00:00Z");
      vi.setSystemTime(now);

      seedSession({
        createdAt: new Date("2025-03-15T11:00:00Z"),
        lastActiveAt: new Date("2025-03-15T11:59:00Z"),
        provider: "google",
      });
      mockResolveEffectiveSessionTimeouts.mockResolvedValue({
        idleMinutes: 480,
        absoluteMinutes: 43200,
        tenantId: "tenant-1",
      });
      mockPrismaSession.update.mockResolvedValue({
        sessionToken: "tok-1",
        userId: "u-1",
        expires,
      });

      const adapter = createCustomAdapter();
      const result = await adapter.updateSession!({ sessionToken: "tok-1", expires });

      expect(mockPrismaSession.findUnique).toHaveBeenCalledWith({
        where: { sessionToken: "tok-1" },
        select: { userId: true, createdAt: true, lastActiveAt: true, tenantId: true, provider: true },
      });
      expect(mockResolveEffectiveSessionTimeouts).toHaveBeenCalledWith("u-1", "google");
      // expires = min(now + 480min, createdAt + 43200min) = now + 480min
      const expected = new Date(now.getTime() + 480 * 60_000);
      const updateCall = mockPrismaSession.update.mock.calls[0][0];
      expect(updateCall.data.expires.getTime()).toBe(expected.getTime());
      expect(updateCall.data.lastActiveAt.getTime()).toBe(now.getTime());
      expect(result).toEqual({ sessionToken: "tok-1", userId: "u-1", expires });
    });

    it("expires is clamped to the absolute deadline when idle window would exceed it", async () => {
      const now = new Date("2025-03-15T12:00:00Z");
      vi.setSystemTime(now);

      // createdAt = 11.5h ago, absolute = 12h ⇒ remaining absolute = 30min
      seedSession({
        createdAt: new Date("2025-03-15T00:30:00Z"),
        lastActiveAt: new Date("2025-03-15T11:59:00Z"),
      });
      mockResolveEffectiveSessionTimeouts.mockResolvedValue({
        idleMinutes: 480,       // 8h idle (would extend past absolute)
        absoluteMinutes: 720,   // 12h absolute cap
        tenantId: "tenant-1",
      });
      mockPrismaSession.update.mockResolvedValue({
        sessionToken: "tok-abs",
        userId: "u-1",
        expires,
      });

      const adapter = createCustomAdapter();
      await adapter.updateSession!({ sessionToken: "tok-abs" });

      const updateCall = mockPrismaSession.update.mock.calls[0][0];
      const expectedAbsDeadline = new Date("2025-03-15T00:30:00Z").getTime() + 720 * 60_000;
      expect(updateCall.data.expires.getTime()).toBe(expectedAbsDeadline);
    });

    it("deletes session when idle timeout exceeded (rolling)", async () => {
      const now = new Date("2025-03-15T12:00:00Z");
      vi.setSystemTime(now);

      // 10 min idle, tenant allows 5 min
      seedSession({
        createdAt: new Date("2025-03-15T11:00:00Z"),
        lastActiveAt: new Date("2025-03-15T11:49:00Z"),
      });
      mockResolveEffectiveSessionTimeouts.mockResolvedValue({
        idleMinutes: 5,
        absoluteMinutes: 43200,
        tenantId: "tenant-1",
      });
      mockPrismaSession.delete.mockResolvedValue({});

      const adapter = createCustomAdapter();
      const result = await adapter.updateSession!({ sessionToken: "tok-idle" });

      expect(result).toBeNull();
      expect(mockPrismaSession.delete).toHaveBeenCalledWith({ where: { sessionToken: "tok-idle" } });
      expect(mockPrismaSession.update).not.toHaveBeenCalled();

      // R3: cache invalidation after DB delete commits.
      expectInvalidatedAfterCommit(mockInvalidateCachedSessions, ["tok-idle"]);
    });

    it("deletes session when absolute timeout exceeded and emits SESSION_REVOKE audit", async () => {
      const now = new Date("2025-03-15T12:00:00Z");
      vi.setSystemTime(now);

      // createdAt = 2h ago, absolute = 60min ⇒ exceeded
      seedSession({
        createdAt: new Date("2025-03-15T10:00:00Z"),
        lastActiveAt: new Date("2025-03-15T11:55:00Z"),
      });
      mockResolveEffectiveSessionTimeouts.mockResolvedValue({
        idleMinutes: 480,
        absoluteMinutes: 60,
        tenantId: "tenant-1",
      });
      mockPrismaSession.delete.mockResolvedValue({});

      const adapter = createCustomAdapter();
      const result = await adapter.updateSession!({ sessionToken: "tok-abs-ex" });

      expect(result).toBeNull();
      expect(mockPrismaSession.delete).toHaveBeenCalledWith({ where: { sessionToken: "tok-abs-ex" } });
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "SESSION_REVOKE",
          metadata: expect.objectContaining({
            reason: "tenant_absolute_session_duration_exceeded",
            absoluteMinutes: 60,
          }),
        }),
      );

      // R3: cache invalidation after DB delete commits.
      expectInvalidatedAfterCommit(mockInvalidateCachedSessions, ["tok-abs-ex"]);
    });

    it("survives when createdAt + absolute is 1s in the future (off-by-one)", async () => {
      const now = new Date("2025-03-15T12:00:00Z");
      vi.setSystemTime(now);

      // absolute deadline = now + 1s
      seedSession({
        createdAt: new Date(now.getTime() - 60 * 60_000 + 1_000), // 60min - 1s ago
        lastActiveAt: new Date(now.getTime() - 1_000),
      });
      mockResolveEffectiveSessionTimeouts.mockResolvedValue({
        idleMinutes: 480,
        absoluteMinutes: 60,
        tenantId: "tenant-1",
      });
      mockPrismaSession.update.mockResolvedValue({
        sessionToken: "tok-boundary",
        userId: "u-1",
        expires,
      });

      const adapter = createCustomAdapter();
      const result = await adapter.updateSession!({ sessionToken: "tok-boundary" });

      expect(result).not.toBeNull();
      expect(mockPrismaSession.delete).not.toHaveBeenCalled();
    });

    it("deletes when createdAt + absolute is 1s in the past (off-by-one)", async () => {
      const now = new Date("2025-03-15T12:00:00Z");
      vi.setSystemTime(now);

      seedSession({
        createdAt: new Date(now.getTime() - 60 * 60_000 - 1_000), // 60min + 1s ago
        lastActiveAt: new Date(now.getTime() - 1_000),
      });
      mockResolveEffectiveSessionTimeouts.mockResolvedValue({
        idleMinutes: 480,
        absoluteMinutes: 60,
        tenantId: "tenant-1",
      });
      mockPrismaSession.delete.mockResolvedValue({});

      const adapter = createCustomAdapter();
      const result = await adapter.updateSession!({ sessionToken: "tok-boundary-neg" });

      expect(result).toBeNull();
      expect(mockPrismaSession.delete).toHaveBeenCalled();
    });

    it("passes webauthn provider to resolver (AAL3 clamp relies on it)", async () => {
      const now = new Date("2025-03-15T12:00:00Z");
      vi.setSystemTime(now);

      seedSession({
        createdAt: new Date(now.getTime() - 60_000),
        lastActiveAt: new Date(now.getTime() - 60_000),
        provider: "webauthn",
      });
      mockResolveEffectiveSessionTimeouts.mockResolvedValue({
        idleMinutes: 15,
        absoluteMinutes: 720,
        tenantId: "tenant-1",
      });
      mockPrismaSession.update.mockResolvedValue({
        sessionToken: "tok-wa",
        userId: "u-1",
        expires,
      });

      const adapter = createCustomAdapter();
      await adapter.updateSession!({ sessionToken: "tok-wa" });

      expect(mockResolveEffectiveSessionTimeouts).toHaveBeenCalledWith("u-1", "webauthn");
    });

    it("returns null when session not found", async () => {
      mockPrismaSession.findUnique.mockResolvedValue(null);

      const adapter = createCustomAdapter();
      const result = await adapter.updateSession!({ sessionToken: "deleted-tok" });

      expect(result).toBeNull();
    });

    it("returns null on P2025 during update", async () => {
      const now = new Date("2025-03-15T12:00:00Z");
      vi.setSystemTime(now);

      const { Prisma } = await import("@prisma/client");
      const p2025 = new Prisma.PrismaClientKnownRequestError(
        "Record not found",
        { code: "P2025", clientVersion: "7.0.0" },
      );
      seedSession({
        createdAt: new Date(now.getTime() - 60_000),
        lastActiveAt: new Date(now.getTime() - 60_000),
      });
      mockPrismaSession.update.mockRejectedValue(p2025);

      const adapter = createCustomAdapter();
      const result = await adapter.updateSession!({ sessionToken: "tok-1" });

      expect(result).toBeNull();
    });

    it("re-throws non-P2025 Prisma errors", async () => {
      const now = new Date("2025-03-15T12:00:00Z");
      vi.setSystemTime(now);

      seedSession({
        createdAt: new Date(now.getTime() - 60_000),
        lastActiveAt: new Date(now.getTime() - 60_000),
      });
      mockPrismaSession.update.mockRejectedValue(new Error("connection lost"));

      const adapter = createCustomAdapter();
      await expect(
        adapter.updateSession!({ sessionToken: "tok-1" }),
      ).rejects.toThrow("connection lost");
    });
  });

  describe("getUser", () => {
    it("returns user when found with email", async () => {
      mockPrismaUser.findUnique.mockResolvedValue({
        id: "u-1", name: "Test", email: "test@example.com", image: null, emailVerified: null,
      });
      const adapter = createCustomAdapter();
      const user = await adapter.getUser!("u-1");
      expect(mockWithBypassRls).toHaveBeenCalled();
      expect(mockPrismaUser.findUnique).toHaveBeenCalledWith({
        where: { id: "u-1" },
        select: { id: true, name: true, email: true, image: true, emailVerified: true },
      });
      expect(user).toEqual({
        id: "u-1", name: "Test", email: "test@example.com", image: null, emailVerified: null,
      });
    });

    it("returns null when user not found", async () => {
      mockPrismaUser.findUnique.mockResolvedValue(null);
      const adapter = createCustomAdapter();
      expect(await adapter.getUser!("missing")).toBeNull();
    });

    it("returns null when user has no email", async () => {
      mockPrismaUser.findUnique.mockResolvedValue({
        id: "u-1", name: "No Email", email: null, image: null, emailVerified: null,
      });
      const adapter = createCustomAdapter();
      expect(await adapter.getUser!("u-1")).toBeNull();
    });
  });

  describe("getUserByEmail", () => {
    it("returns user when found", async () => {
      mockPrismaUser.findUnique.mockResolvedValue({
        id: "u-1", name: "Test", email: "test@example.com", image: null, emailVerified: null,
      });
      const adapter = createCustomAdapter();
      const user = await adapter.getUserByEmail!("test@example.com");
      expect(mockWithBypassRls).toHaveBeenCalled();
      expect(user).toEqual({
        id: "u-1", name: "Test", email: "test@example.com", image: null, emailVerified: null,
      });
    });

    it("returns null when not found", async () => {
      mockPrismaUser.findUnique.mockResolvedValue(null);
      const adapter = createCustomAdapter();
      expect(await adapter.getUserByEmail!("no@example.com")).toBeNull();
    });
  });

  describe("getUserByAccount", () => {
    it("returns user when account found", async () => {
      mockPrismaAccount.findUnique.mockResolvedValue({
        user: { id: "u-1", name: "Test", email: "test@example.com", image: null, emailVerified: null },
      });
      const adapter = createCustomAdapter();
      const user = await adapter.getUserByAccount!({
        provider: "google", providerAccountId: "g-1",
      });
      expect(mockWithBypassRls).toHaveBeenCalled();
      expect(user).toEqual({
        id: "u-1", name: "Test", email: "test@example.com", image: null, emailVerified: null,
      });
    });

    it("returns null when account not found", async () => {
      mockPrismaAccount.findUnique.mockResolvedValue(null);
      const adapter = createCustomAdapter();
      expect(await adapter.getUserByAccount!({
        provider: "google", providerAccountId: "missing",
      })).toBeNull();
    });

    it("returns null when user has no email", async () => {
      mockPrismaAccount.findUnique.mockResolvedValue({
        user: { id: "u-1", name: "Test", email: null, image: null, emailVerified: null },
      });
      const adapter = createCustomAdapter();
      expect(await adapter.getUserByAccount!({
        provider: "google", providerAccountId: "g-1",
      })).toBeNull();
    });
  });

  describe("updateUser", () => {
    it("updates and returns user", async () => {
      mockPrismaUser.update.mockResolvedValue({
        id: "u-1", name: "Updated", email: "test@example.com", image: null, emailVerified: null,
      });
      const adapter = createCustomAdapter();
      const user = await adapter.updateUser!({ id: "u-1", name: "Updated" });
      expect(mockWithBypassRls).toHaveBeenCalled();
      expect(mockPrismaUser.update).toHaveBeenCalledWith({
        where: { id: "u-1" },
        data: { name: "Updated" },
        select: { id: true, name: true, email: true, image: true, emailVerified: true },
      });
      expect(user).toEqual({
        id: "u-1", name: "Updated", email: "test@example.com", image: null, emailVerified: null,
      });
    });

    it("throws when updated user has no email", async () => {
      mockPrismaUser.update.mockResolvedValue({
        id: "u-1", name: "Test", email: null, image: null, emailVerified: null,
      });
      const adapter = createCustomAdapter();
      await expect(adapter.updateUser!({ id: "u-1", name: "Test" })).rejects.toThrow("USER_EMAIL_MISSING");
    });
  });

  describe("deleteUser", () => {
    it("deletes user with withBypassRls", async () => {
      mockPrismaSession.findMany.mockResolvedValue([]);
      mockPrismaUser.delete.mockResolvedValue({});
      const adapter = createCustomAdapter();
      await adapter.deleteUser!("u-1");
      expect(mockWithBypassRls).toHaveBeenCalled();
      expect(mockPrismaUser.delete).toHaveBeenCalledWith({ where: { id: "u-1" } });
    });

    it("invalidates cache for cascaded session tokens after user.delete commits", async () => {
      mockPrismaSession.findMany.mockResolvedValue([
        { sessionToken: "tok-x" },
        { sessionToken: "tok-y" },
      ]);
      mockPrismaUser.delete.mockResolvedValue({});

      const adapter = createCustomAdapter();
      await adapter.deleteUser!("u-1");

      expect(mockPrismaSession.findMany).toHaveBeenCalledWith({
        where: { userId: "u-1" },
        select: { sessionToken: true },
      });
      expectInvalidatedAfterCommit(mockInvalidateCachedSessions, [
        "tok-x",
        "tok-y",
      ]);
    });

    it("does not invalidate cache when user has no sessions", async () => {
      mockPrismaSession.findMany.mockResolvedValue([]);
      mockPrismaUser.delete.mockResolvedValue({});

      const adapter = createCustomAdapter();
      await adapter.deleteUser!("u-1");

      expectNotInvalidatedOnDbThrow(mockInvalidateCachedSessions);
    });

    it("does not invalidate cache when user.delete throws (sequencing invariant)", async () => {
      mockPrismaSession.findMany.mockResolvedValue([
        { sessionToken: "tok-x" },
      ]);
      mockPrismaUser.delete.mockRejectedValue(new Error("FK violation"));

      const adapter = createCustomAdapter();
      await expect(adapter.deleteUser!("u-1")).rejects.toThrow("FK violation");

      expectNotInvalidatedOnDbThrow(mockInvalidateCachedSessions);
    });
  });

  describe("unlinkAccount", () => {
    it("deletes account with withBypassRls", async () => {
      mockPrismaAccount.delete.mockResolvedValue({});
      const adapter = createCustomAdapter();
      await adapter.unlinkAccount!({ provider: "google", providerAccountId: "g-1" });
      expect(mockWithBypassRls).toHaveBeenCalled();
      expect(mockPrismaAccount.delete).toHaveBeenCalledWith({
        where: {
          provider_providerAccountId: { provider: "google", providerAccountId: "g-1" },
        },
      });
    });
  });

  describe("deleteSession", () => {
    it("deletes session with withBypassRls", async () => {
      mockPrismaSession.delete.mockResolvedValue({});
      const adapter = createCustomAdapter();
      await adapter.deleteSession!("tok-1");
      expect(mockWithBypassRls).toHaveBeenCalled();
      expect(mockPrismaSession.delete).toHaveBeenCalledWith({ where: { sessionToken: "tok-1" } });
    });

    it("invalidates cache for the deleted token after DB commits", async () => {
      mockPrismaSession.delete.mockResolvedValue({});
      const adapter = createCustomAdapter();
      await adapter.deleteSession!("tok-1");

      expectInvalidatedAfterCommit(mockInvalidateCachedSessions, ["tok-1"]);
    });

    it("does not invalidate cache when DB delete throws (sequencing invariant)", async () => {
      mockPrismaSession.delete.mockRejectedValue(new Error("not found"));
      const adapter = createCustomAdapter();
      await expect(adapter.deleteSession!("tok-1")).rejects.toThrow(
        "not found",
      );

      expectNotInvalidatedOnDbThrow(mockInvalidateCachedSessions);
    });
  });

  describe("getAccount", () => {
    it("returns account when found", async () => {
      mockPrismaAccount.findFirst.mockResolvedValue({
        userId: "u-1", type: "oidc", provider: "google", providerAccountId: "g-1",
        refresh_token: "rt", access_token: "at", expires_at: 1234, token_type: "bearer",
        scope: "openid", id_token: "idt", session_state: "ss",
      });
      const adapter = createCustomAdapter();
      const account = await adapter.getAccount!("g-1", "google");
      expect(mockWithBypassRls).toHaveBeenCalled();
      expect(account).toEqual({
        userId: "u-1", type: "oidc", provider: "google", providerAccountId: "g-1",
        refresh_token: "rt", access_token: "at", expires_at: 1234, token_type: "bearer",
        scope: "openid", id_token: "idt", session_state: "ss",
      });
    });

    it("converts null optional fields to undefined", async () => {
      mockPrismaAccount.findFirst.mockResolvedValue({
        userId: "u-1", type: "oidc", provider: "google", providerAccountId: "g-1",
        refresh_token: null, access_token: null, expires_at: null, token_type: null,
        scope: null, id_token: null, session_state: null,
      });
      const adapter = createCustomAdapter();
      const account = await adapter.getAccount!("g-1", "google");
      expect(account).toEqual({
        userId: "u-1", type: "oidc", provider: "google", providerAccountId: "g-1",
        refresh_token: undefined, access_token: undefined, expires_at: undefined,
        token_type: undefined, scope: undefined, id_token: undefined, session_state: undefined,
      });
    });

    it("returns null when account not found", async () => {
      mockPrismaAccount.findFirst.mockResolvedValue(null);
      const adapter = createCustomAdapter();
      expect(await adapter.getAccount!("missing", "google")).toBeNull();
    });

    it("decrypts encrypted tokens to plaintext (round-trip with linkAccount)", async () => {
      // Use linkAccount to produce the ciphertext, then mock findFirst to
      // return that ciphertext and verify getAccount decrypts it.
      mockPrismaUser.findUnique.mockResolvedValue({ tenantId: "tenant-1" });
      mockPrismaAccount.create.mockResolvedValue({ id: "acc-1" });
      const adapter = createCustomAdapter();
      await adapter.linkAccount!({
        userId: "u-1",
        type: "oidc",
        provider: "google",
        providerAccountId: "g-roundtrip",
        refresh_token: "rt-roundtrip",
        access_token: "at-roundtrip",
        id_token: "idt-roundtrip",
      });
      const writeData = mockPrismaAccount.create.mock.calls[0][0].data;

      mockPrismaAccount.findFirst.mockResolvedValue({
        userId: "u-1",
        type: "oidc",
        provider: "google",
        providerAccountId: "g-roundtrip",
        refresh_token: writeData.refresh_token,
        access_token: writeData.access_token,
        expires_at: 1234,
        token_type: "bearer",
        scope: "openid",
        id_token: writeData.id_token,
        session_state: "ss",
      });

      const account = await adapter.getAccount!("g-roundtrip", "google");
      expect(account?.refresh_token).toBe("rt-roundtrip");
      expect(account?.access_token).toBe("at-roundtrip");
      expect(account?.id_token).toBe("idt-roundtrip");
    });

    it("returns undefined for fields whose ciphertext is corrupted, without throwing", async () => {
      mockPrismaAccount.findFirst.mockResolvedValue({
        id: "acc-corrupt",
        userId: "u-1",
        tenantId: "tenant-1",
        type: "oidc",
        provider: "google",
        providerAccountId: "g-corrupt",
        // Sentinel-prefixed but garbage afterwards — decryption must throw and
        // the adapter must catch it per field.
        refresh_token: "psoenc1:0:zzzzzzzzzzzz",
        access_token: null,
        expires_at: null,
        token_type: null,
        scope: null,
        id_token: null,
        session_state: null,
      });
      const adapter = createCustomAdapter();
      const account = await adapter.getAccount!("g-corrupt", "google");
      expect(account).not.toBeNull();
      expect(account?.refresh_token).toBeUndefined();
      // CORRUPT classification — operationally benign, NO audit emission.
      expect(mockLogAudit).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: "OAUTH_ACCOUNT_TOKEN_DECRYPT_FAILURE" }),
      );
    });

    it("does NOT emit audit on successful decrypt", async () => {
      mockPrismaUser.findUnique.mockResolvedValue({ tenantId: "tenant-1" });
      mockPrismaAccount.create.mockResolvedValue({ id: "acc-ok" });
      const adapter = createCustomAdapter();
      await adapter.linkAccount!({
        userId: "u-1",
        type: "oidc",
        provider: "google",
        providerAccountId: "g-ok",
        refresh_token: "rt-ok",
        access_token: "at-ok",
        id_token: "idt-ok",
      });
      const writeData = mockPrismaAccount.create.mock.calls[0][0].data;

      mockPrismaAccount.findFirst.mockResolvedValue({
        id: "acc-ok",
        userId: "u-1",
        tenantId: "tenant-1",
        type: "oidc",
        provider: "google",
        providerAccountId: "g-ok",
        refresh_token: writeData.refresh_token,
        access_token: writeData.access_token,
        expires_at: 1234,
        token_type: "bearer",
        scope: "openid",
        id_token: writeData.id_token,
        session_state: "ss",
      });

      await adapter.getAccount!("g-ok", "google");
      expect(mockLogAudit).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: "OAUTH_ACCOUNT_TOKEN_DECRYPT_FAILURE" }),
      );
    });

    it("emits audit (TAMPERED) when stored ciphertext's AAD does not match the row's identity", async () => {
      // Forge a TAMPERED scenario by encrypting under one (provider, providerAccountId)
      // pair via linkAccount, then returning that ciphertext from findFirst
      // for a DIFFERENT pair so getAccount's AAD will not match.
      mockPrismaUser.findUnique.mockResolvedValue({ tenantId: "tenant-1" });
      mockPrismaAccount.create.mockResolvedValue({ id: "acc-source" });
      const adapter = createCustomAdapter();
      await adapter.linkAccount!({
        userId: "u-victim",
        type: "oidc",
        provider: "google",
        providerAccountId: "g-source",
        refresh_token: "rt-victim",
      });
      const sourceCipher = mockPrismaAccount.create.mock.calls[0][0].data
        .refresh_token as string;

      // Now serve that ciphertext from a DIFFERENT (providerAccountId) row.
      mockPrismaAccount.findFirst.mockResolvedValue({
        id: "acc-tampered",
        userId: "u-attacker",
        tenantId: "tenant-1",
        type: "oidc",
        provider: "google",
        providerAccountId: "g-tampered", // ← AAD will not match — GCM auth fails
        refresh_token: sourceCipher,
        access_token: null,
        expires_at: null,
        token_type: null,
        scope: null,
        id_token: null,
        session_state: null,
      });

      const account = await adapter.getAccount!("g-tampered", "google");
      // Decrypt fails → field returned as undefined (regression bar).
      expect(account?.refresh_token).toBeUndefined();
      // TAMPERED audit emitted with full metadata.
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: "PERSONAL",
          action: "OAUTH_ACCOUNT_TOKEN_DECRYPT_FAILURE",
          userId: "u-attacker",
          tenantId: "tenant-1",
          targetId: "acc-tampered",
          metadata: expect.objectContaining({
            provider: "google",
            providerAccountId: "g-tampered",
            field: "refresh_token",
            kind: "TAMPERED",
          }),
        }),
      );
      // err.message must NOT appear verbatim in logged metadata — only errClass.
      const auditCall = mockLogAudit.mock.calls.find(
        (c) => c[0].action === "OAUTH_ACCOUNT_TOKEN_DECRYPT_FAILURE",
      );
      expect(auditCall?.[0].metadata).not.toHaveProperty("err");
      expect(auditCall?.[0].metadata).toHaveProperty("errClass");
    });

    it("preserves successfully-decrypted siblings when one field is TAMPERED", async () => {
      // refresh_token encrypted under one (provider,id) pair; id_token freshly
      // encrypted for the new pair. getAccount should return id_token plaintext
      // and refresh_token undefined.
      mockPrismaUser.findUnique.mockResolvedValue({ tenantId: "tenant-1" });
      mockPrismaAccount.create.mockResolvedValue({ id: "acc-1" });
      const adapter = createCustomAdapter();

      await adapter.linkAccount!({
        userId: "u-victim",
        type: "oidc",
        provider: "google",
        providerAccountId: "g-source",
        refresh_token: "rt-source",
      });
      const sourceCipher = mockPrismaAccount.create.mock.calls[0][0].data
        .refresh_token as string;

      mockPrismaAccount.create.mockClear();
      await adapter.linkAccount!({
        userId: "u-victim",
        type: "oidc",
        provider: "google",
        providerAccountId: "g-target",
        id_token: "idt-target",
      });
      const targetIdToken = mockPrismaAccount.create.mock.calls[0][0].data
        .id_token as string;

      mockPrismaAccount.findFirst.mockResolvedValue({
        id: "acc-mixed",
        userId: "u-victim",
        tenantId: "tenant-1",
        type: "oidc",
        provider: "google",
        providerAccountId: "g-target",
        refresh_token: sourceCipher, // bound to (google, g-source) — TAMPERED
        access_token: null,
        expires_at: null,
        token_type: null,
        scope: null,
        id_token: targetIdToken, // bound to (google, g-target) — valid
        session_state: null,
      });

      const account = await adapter.getAccount!("g-target", "google");
      expect(account?.refresh_token).toBeUndefined();
      expect(account?.id_token).toBe("idt-target");
    });
  });
});
