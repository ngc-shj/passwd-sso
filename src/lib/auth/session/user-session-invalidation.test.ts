import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockSession,
  mockExtensionToken,
  mockApiKey,
  mockMcpAccessToken,
  mockMcpRefreshToken,
  mockDelegationSession,
  mockWithBypassRls,
  mockInvalidateCachedSessions,
} = vi.hoisted(() => ({
  mockSession: { deleteMany: vi.fn(), findMany: vi.fn() },
  mockExtensionToken: { updateMany: vi.fn() },
  mockApiKey: { updateMany: vi.fn() },
  mockMcpAccessToken: { updateMany: vi.fn() },
  mockMcpRefreshToken: { updateMany: vi.fn() },
  mockDelegationSession: { updateMany: vi.fn() },
  mockWithBypassRls: vi.fn(async (_prisma: unknown, fn: () => unknown) => fn()),
  mockInvalidateCachedSessions: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    session: mockSession,
    extensionToken: mockExtensionToken,
    apiKey: mockApiKey,
    mcpAccessToken: mockMcpAccessToken,
    mcpRefreshToken: mockMcpRefreshToken,
    delegationSession: mockDelegationSession,
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));
vi.mock("@/lib/auth/session/session-cache-helpers", () => ({
  invalidateCachedSessions: mockInvalidateCachedSessions,
}));

import {
  invalidateUserSessions,
  type InvalidateUserSessionsOptions,
} from "./user-session-invalidation";
import {
  expectInvalidatedAfterCommit,
  expectNotInvalidatedOnDbThrow,
} from "@/__tests__/helpers/session-cache-assertions";

describe("invalidateUserSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession.deleteMany.mockResolvedValue({ count: 2 });
    mockSession.findMany.mockResolvedValue([
      { sessionToken: "tok-a" },
      { sessionToken: "tok-b" },
    ]);
    mockExtensionToken.updateMany.mockResolvedValue({ count: 1 });
    mockApiKey.updateMany.mockResolvedValue({ count: 3 });
    mockMcpAccessToken.updateMany.mockResolvedValue({ count: 4 });
    mockMcpRefreshToken.updateMany.mockResolvedValue({ count: 5 });
    mockDelegationSession.updateMany.mockResolvedValue({ count: 6 });
  });

  it("deletes sessions, revokes extension tokens, API keys, MCP access/refresh tokens, and delegation sessions", async () => {
    const result = await invalidateUserSessions("user-1", { tenantId: "tenant-1" });

    expect(mockSession.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", tenantId: "tenant-1" },
    });
    expect(mockExtensionToken.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", revokedAt: null, tenantId: "tenant-1" },
      data: { revokedAt: expect.any(Date) },
    });
    expect(mockApiKey.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", revokedAt: null, tenantId: "tenant-1" },
      data: { revokedAt: expect.any(Date) },
    });
    expect(mockMcpAccessToken.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", revokedAt: null, tenantId: "tenant-1" },
      data: { revokedAt: expect.any(Date) },
    });
    expect(mockMcpRefreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", revokedAt: null, tenantId: "tenant-1" },
      data: { revokedAt: expect.any(Date) },
    });
    expect(mockDelegationSession.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", revokedAt: null, tenantId: "tenant-1" },
      data: { revokedAt: expect.any(Date) },
    });
    expect(result).toEqual({
      sessions: 2,
      extensionTokens: 1,
      apiKeys: 3,
      mcpAccessTokens: 4,
      mcpRefreshTokens: 5,
      delegationSessions: 6,
    });
  });

  it("uses withBypassRls", async () => {
    await invalidateUserSessions("user-1", { tenantId: "tenant-1" });
    expect(mockWithBypassRls).toHaveBeenCalledTimes(1);
  });

  it("filters queries by both userId and tenantId", async () => {
    await invalidateUserSessions("user-1", { tenantId: "tenant-2" });

    expect(mockSession.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", tenantId: "tenant-2" },
    });
    for (const m of [
      mockExtensionToken,
      mockApiKey,
      mockMcpAccessToken,
      mockMcpRefreshToken,
      mockDelegationSession,
    ]) {
      expect(m.updateMany).toHaveBeenCalledWith({
        where: { userId: "user-1", revokedAt: null, tenantId: "tenant-2" },
        data: { revokedAt: expect.any(Date) },
      });
    }
  });

  it("propagates error when a database operation fails", async () => {
    mockSession.deleteMany.mockRejectedValue(new Error("db error"));
    await expect(
      invalidateUserSessions("user-1", { tenantId: "tenant-1" }),
    ).rejects.toThrow("db error");
  });

  it("invalidates cache for all selected session tokens after DB commits", async () => {
    mockSession.findMany.mockResolvedValue([
      { sessionToken: "tok-a" },
      { sessionToken: "tok-b" },
      { sessionToken: "tok-c" },
    ]);

    await invalidateUserSessions("user-1", { tenantId: "tenant-1" });

    expectInvalidatedAfterCommit(mockInvalidateCachedSessions, [
      "tok-a",
      "tok-b",
      "tok-c",
    ]);
  });

  it("does not invalidate cache when there are no sessions to delete", async () => {
    mockSession.findMany.mockResolvedValue([]);
    mockSession.deleteMany.mockResolvedValue({ count: 0 });

    await invalidateUserSessions("user-1", { tenantId: "tenant-1" });

    expectNotInvalidatedOnDbThrow(mockInvalidateCachedSessions);
  });

  it("does not invalidate cache when DB delete throws (sequencing invariant)", async () => {
    mockSession.findMany.mockResolvedValue([
      { sessionToken: "tok-a" },
    ]);
    mockSession.deleteMany.mockRejectedValue(new Error("db error"));

    await expect(
      invalidateUserSessions("user-1", { tenantId: "tenant-1" }),
    ).rejects.toThrow("db error");

    expectNotInvalidatedOnDbThrow(mockInvalidateCachedSessions);
  });

  it("invalidates across all tenants when allTenants: true", async () => {
    // Sessions belong to two different tenants for the same user.
    mockSession.findMany.mockResolvedValue([
      { sessionToken: "tok-tenant-a" },
      { sessionToken: "tok-tenant-b" },
    ]);
    mockSession.deleteMany.mockResolvedValue({ count: 2 });

    const result = await invalidateUserSessions("user-1", { allTenants: true });

    // No tenant filter on any sub-query.
    expect(mockSession.findMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      select: { sessionToken: true },
    });
    expect(mockSession.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
    });
    for (const m of [
      mockExtensionToken,
      mockApiKey,
      mockMcpAccessToken,
      mockMcpRefreshToken,
      mockDelegationSession,
    ]) {
      expect(m.updateMany).toHaveBeenCalledWith({
        where: { userId: "user-1", revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    }

    // All cross-tenant tokens are tombstoned.
    expectInvalidatedAfterCommit(mockInvalidateCachedSessions, [
      "tok-tenant-a",
      "tok-tenant-b",
    ]);

    expect(result).toEqual({
      sessions: 2,
      extensionTokens: 1,
      apiKeys: 3,
      mcpAccessTokens: 4,
      mcpRefreshTokens: 5,
      delegationSessions: 6,
    });
  });

  it("throws when both tenantId and allTenants are passed (defense-in-depth)", async () => {
    // Cast bypasses the discriminated union — simulates an `as any` leak.
    await expect(
      invalidateUserSessions("user-1", {
        tenantId: "tenant-1",
        allTenants: true,
      } as unknown as InvalidateUserSessionsOptions),
    ).rejects.toThrow(/mutually exclusive/);
  });

  it("rejects { tenantId, allTenants: true } at compile time", () => {
    // The @ts-expect-error directive itself is the assertion: if the type
    // system permits both options simultaneously, `tsc --noEmit` fails.
    // The function is defined but never invoked — the directive runs at
    // type-check time only, so runtime behavior is unaffected (F20 fix).
    const _typeCheckOnly = () =>
      // @ts-expect-error mutually exclusive: tenantId and allTenants cannot both be set
      invalidateUserSessions("user-1", { tenantId: "x", allTenants: true });
    expect(typeof _typeCheckOnly).toBe("function");
  });
});
