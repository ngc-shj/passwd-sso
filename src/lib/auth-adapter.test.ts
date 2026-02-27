import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPrismaSession, mockPrismaUser, mockPrismaTenant, mockPrismaTenantMember, mockPrismaAccount, mockPrismaTransaction, mockSessionMetaGetStore, mockWithBypassRls } = vi.hoisted(() => ({
  mockPrismaSession: {
    create: vi.fn(),
    update: vi.fn(),
  },
  mockPrismaUser: {
    findUnique: vi.fn(),
    create: vi.fn(),
  },
  mockPrismaTenant: {
    create: vi.fn(),
  },
  mockPrismaTenantMember: {
    create: vi.fn(),
  },
  mockPrismaAccount: {
    create: vi.fn(),
  },
  mockPrismaTransaction: vi.fn(),
  mockSessionMetaGetStore: vi.fn(),
  mockWithBypassRls: vi.fn(async (_prisma: unknown, fn: () => unknown) => fn()),
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
vi.mock("@/lib/session-meta", () => ({
  sessionMetaStorage: { getStore: mockSessionMetaGetStore },
}));
vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: mockWithBypassRls,
}));
vi.mock("@auth/prisma-adapter", () => ({
  PrismaAdapter: () => ({
    // Base adapter methods (not used in tests but spread into custom adapter)
  }),
}));

import { createCustomAdapter } from "./auth-adapter";

describe("createCustomAdapter", () => {
  const expires = new Date("2025-06-01T00:00:00Z");

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrismaTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        tenant: mockPrismaTenant,
        user: mockPrismaUser,
        tenantMember: mockPrismaTenantMember,
      }),
    );
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
        name: "Test User",
        email: "test@example.com",
        image: "https://example.com/avatar.png",
        emailVerified: null,
      });

      expect(mockPrismaTenant.create).toHaveBeenCalledTimes(1);
      expect(mockPrismaUser.create).toHaveBeenCalledWith({
        data: {
          name: "Test User",
          email: "test@example.com",
          image: "https://example.com/avatar.png",
          emailVerified: null,
          tenantId: "tenant-1",
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
  });

  describe("createSession", () => {
    it("captures IP and userAgent from sessionMetaStorage", async () => {
      mockSessionMetaGetStore.mockReturnValue({
        ip: "192.168.1.1",
        userAgent: "Mozilla/5.0",
      });
      mockPrismaUser.findUnique.mockResolvedValue({ tenantId: "tenant-1" });
      mockPrismaSession.create.mockResolvedValue({
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

      expect(mockPrismaSession.create).toHaveBeenCalledWith({
        data: {
          sessionToken: "tok-1",
          userId: "u-1",
          tenantId: "tenant-1",
          expires,
          ipAddress: "192.168.1.1",
          userAgent: "Mozilla/5.0",
        },
      });
      expect(result).toEqual({
        sessionToken: "tok-1",
        userId: "u-1",
        expires,
      });
    });

    it("sets null when sessionMetaStorage has no store (undefined)", async () => {
      mockSessionMetaGetStore.mockReturnValue(undefined);
      mockPrismaUser.findUnique.mockResolvedValue({ tenantId: "tenant-2" });
      mockPrismaSession.create.mockResolvedValue({
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

      expect(mockPrismaSession.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          ipAddress: null,
          userAgent: null,
        }),
      });
    });

    it("truncates userAgent to 512 characters", async () => {
      const longUA = "X".repeat(1000);
      mockSessionMetaGetStore.mockReturnValue({
        ip: "10.0.0.1",
        userAgent: longUA,
      });
      mockPrismaUser.findUnique.mockResolvedValue({ tenantId: "tenant-3" });
      mockPrismaSession.create.mockResolvedValue({
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

      expect(mockPrismaSession.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userAgent: "X".repeat(512),
        }),
      });
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
  });

  describe("updateSession", () => {
    it("updates lastActiveAt and passes expires when provided", async () => {
      const now = new Date("2025-03-15T12:00:00Z");
      vi.setSystemTime(now);

      mockPrismaSession.update.mockResolvedValue({
        sessionToken: "tok-1",
        userId: "u-1",
        expires,
      });

      const adapter = createCustomAdapter();
      const result = await adapter.updateSession!({
        sessionToken: "tok-1",
        expires,
      });

      expect(mockPrismaSession.update).toHaveBeenCalledWith({
        where: { sessionToken: "tok-1" },
        data: { expires, lastActiveAt: now },
      });
      expect(result).toEqual({
        sessionToken: "tok-1",
        userId: "u-1",
        expires,
      });

      vi.useRealTimers();
    });

    it("omits expires from data when not provided", async () => {
      mockPrismaSession.update.mockResolvedValue({
        sessionToken: "tok-1",
        userId: "u-1",
        expires,
      });

      const adapter = createCustomAdapter();
      await adapter.updateSession!({ sessionToken: "tok-1" });

      const callData = mockPrismaSession.update.mock.calls[0][0].data;
      expect(callData).not.toHaveProperty("expires");
      expect(callData).toHaveProperty("lastActiveAt");
    });

    it("returns null when session not found (P2025)", async () => {
      const { Prisma } = await import("@prisma/client");
      const p2025 = new Prisma.PrismaClientKnownRequestError(
        "Record not found",
        { code: "P2025", clientVersion: "7.0.0" },
      );
      mockPrismaSession.update.mockRejectedValue(p2025);

      const adapter = createCustomAdapter();
      const result = await adapter.updateSession!({ sessionToken: "deleted-tok" });

      expect(result).toBeNull();
    });

    it("re-throws non-P2025 Prisma errors", async () => {
      const otherErr = new Error("connection lost");
      mockPrismaSession.update.mockRejectedValue(otherErr);

      const adapter = createCustomAdapter();
      await expect(
        adapter.updateSession!({ sessionToken: "tok-1" }),
      ).rejects.toThrow("connection lost");
    });
  });
});
