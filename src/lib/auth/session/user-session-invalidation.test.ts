import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockSession,
  mockExtensionToken,
  mockApiKey,
  mockMcpAccessToken,
  mockMcpRefreshToken,
  mockDelegationSession,
  mockOperatorToken,
  mockExtensionBridgeCode,
  mockMobileBridgeCode,
  mockMcpAuthorizationCode,
  mockWithBypassRls,
  mockInvalidateCachedSessions,
  mockInvalidateCachedSessionsBulkByDigest,
  mockExecuteRaw,
  mockLoggerError,
  mockSentryCaptureMessage,
} = vi.hoisted(() => ({
  mockExecuteRaw: vi.fn(async (..._args: unknown[]) => 0),
  mockLoggerError: vi.fn(),
  mockSentryCaptureMessage: vi.fn(),
  mockSession: { deleteMany: vi.fn(), findMany: vi.fn() },
  mockExtensionToken: { updateMany: vi.fn() },
  mockApiKey: { updateMany: vi.fn() },
  mockMcpAccessToken: { updateMany: vi.fn() },
  mockMcpRefreshToken: { updateMany: vi.fn() },
  mockDelegationSession: { updateMany: vi.fn() },
  mockOperatorToken: { updateMany: vi.fn() },
  mockExtensionBridgeCode: { updateMany: vi.fn() },
  mockMobileBridgeCode: { updateMany: vi.fn() },
  mockMcpAuthorizationCode: { updateMany: vi.fn() },
  mockWithBypassRls: vi.fn(async (prisma: unknown, fn: (tx: unknown) => unknown) => fn(prisma)),
  mockInvalidateCachedSessions: vi
    .fn<(tokens: ReadonlyArray<string>) => Promise<{ total: number; failed: number }>>()
    .mockResolvedValue({ total: 0, failed: 0 }),
  mockInvalidateCachedSessionsBulkByDigest: vi
    .fn<(tokens: ReadonlyArray<string>) => Promise<{ total: number; failed: number }>>()
    .mockResolvedValue({ total: 0, failed: 0 }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    session: mockSession,
    extensionToken: mockExtensionToken,
    apiKey: mockApiKey,
    mcpAccessToken: mockMcpAccessToken,
    mcpRefreshToken: mockMcpRefreshToken,
    delegationSession: mockDelegationSession,
    operatorToken: mockOperatorToken,
    extensionBridgeCode: mockExtensionBridgeCode,
    mobileBridgeCode: mockMobileBridgeCode,
    mcpAuthorizationCode: mockMcpAuthorizationCode,
    // The user's credential lock (user-auth-serialization.ts).
    $executeRaw: mockExecuteRaw,
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));
vi.mock("@/lib/auth/session/session-cache-helpers", () => ({
  invalidateCachedSessions: mockInvalidateCachedSessions,
}));
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: mockLoggerError }),
}));
vi.mock("@sentry/nextjs", () => ({ captureMessage: mockSentryCaptureMessage }));
vi.mock("@/lib/auth/session/session-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/session/session-cache")>()),
  invalidateCachedSessionsBulkByDigest: mockInvalidateCachedSessionsBulkByDigest,
}));

import {
  invalidateUserSessions,
  invalidateUserSessionsCache,
  revokeUsersAuthArtifactsInTx,
  tombstoneRevokedSessions,
  type InvalidateUserSessionsOptions,
} from "./user-session-invalidation";
import { UserAuthLockTimeoutError, userAuthLockKey } from "@/lib/auth/session/user-auth-serialization";
import { hashSessionToken } from "@/lib/auth/session/session-cache";
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
    mockOperatorToken.updateMany.mockResolvedValue({ count: 7 });
    mockExtensionBridgeCode.updateMany.mockResolvedValue({ count: 8 });
    mockMobileBridgeCode.updateMany.mockResolvedValue({ count: 9 });
    mockMcpAuthorizationCode.updateMany.mockResolvedValue({ count: 10 });
  });

  it("deletes sessions, revokes extension tokens, API keys, MCP access/refresh tokens, delegation sessions, and operator tokens", async () => {
    const result = await invalidateUserSessions("user-1", { tenantId: "tenant-1" });

    expect(mockSession.deleteMany).toHaveBeenCalledWith({
      where: { userId: { in: ["user-1"] }, tenantId: "tenant-1" },
    });
    expect(mockExtensionToken.updateMany).toHaveBeenCalledWith({
      where: { userId: { in: ["user-1"] }, revokedAt: null, tenantId: "tenant-1" },
      data: { revokedAt: expect.any(Date) },
    });
    expect(mockApiKey.updateMany).toHaveBeenCalledWith({
      where: { userId: { in: ["user-1"] }, revokedAt: null, tenantId: "tenant-1" },
      data: { revokedAt: expect.any(Date) },
    });
    expect(mockMcpAccessToken.updateMany).toHaveBeenCalledWith({
      where: { userId: { in: ["user-1"] }, revokedAt: null, tenantId: "tenant-1" },
      data: { revokedAt: expect.any(Date) },
    });
    expect(mockMcpRefreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: { in: ["user-1"] }, revokedAt: null, tenantId: "tenant-1" },
      data: { revokedAt: expect.any(Date) },
    });
    expect(mockDelegationSession.updateMany).toHaveBeenCalledWith({
      where: { userId: { in: ["user-1"] }, revokedAt: null, tenantId: "tenant-1" },
      data: { revokedAt: expect.any(Date) },
    });
    // H4: OperatorToken uses subjectUserId (NOT userId) as the bound column.
    // Without this revoke, a compromised admin's op_* tokens survive the
    // session-invalidation that was supposed to lock them out, and they can
    // still call rotate-master-key / purge-audit-logs / purge-history.
    expect(mockOperatorToken.updateMany).toHaveBeenCalledWith({
      where: { subjectUserId: { in: ["user-1"] }, revokedAt: null, tenantId: "tenant-1" },
      data: { revokedAt: expect.any(Date) },
    });
    expect(result).toEqual({
      sessions: 2,
      extensionTokens: 1,
      apiKeys: 3,
      mcpAccessTokens: 4,
      mcpRefreshTokens: 5,
      delegationSessions: 6,
      operatorTokens: 7,
      extensionBridgeCodes: 8,
      mobileBridgeCodes: 9,
      mcpAuthorizationCodes: 10,
      cacheTombstoneFailures: 0,
    });
  });

  it("consumes the user's unused single-use codes in scope (each exchanges for a token with no session)", async () => {
    await invalidateUserSessions("user-1", { tenantId: "tenant-1" });

    for (const m of [mockExtensionBridgeCode, mockMobileBridgeCode, mockMcpAuthorizationCode]) {
      expect(m.updateMany).toHaveBeenCalledWith({
        where: { userId: { in: ["user-1"] }, usedAt: null, tenantId: "tenant-1" },
        data: { usedAt: expect.any(Date) },
      });
    }
  });

  it("keeps the caller's own session: excluded by digest from both the tombstone list and the delete", async () => {
    await invalidateUserSessions("user-1", { tenantId: "tenant-1", excludeSessionToken: "raw-current" });

    const exclusion = { sessionToken: { not: hashSessionToken("raw-current") } };
    expect(mockSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: { in: ["user-1"] }, tenantId: "tenant-1", ...exclusion } }),
    );
    expect(mockSession.deleteMany).toHaveBeenCalledWith({ where: { userId: { in: ["user-1"] }, tenantId: "tenant-1", ...exclusion } });
  });

  it("takes the user's credential lock before revoking anything", async () => {
    const order: string[] = [];
    mockExecuteRaw.mockImplementationOnce(async () => {
      order.push("lock");
      return 0;
    });
    mockSession.findMany.mockImplementationOnce(async () => {
      order.push("read");
      return [];
    });
    await invalidateUserSessions("user-1", { tenantId: "tenant-1" });
    expect(order).toEqual(["lock", "read"]);
  });

  it("uses withBypassRls", async () => {
    await invalidateUserSessions("user-1", { tenantId: "tenant-1" });
    expect(mockWithBypassRls).toHaveBeenCalledTimes(1);
  });

  it("filters queries by both userId and tenantId", async () => {
    await invalidateUserSessions("user-1", { tenantId: "tenant-2" });

    expect(mockSession.deleteMany).toHaveBeenCalledWith({
      where: { userId: { in: ["user-1"] }, tenantId: "tenant-2" },
    });
    for (const m of [
      mockExtensionToken,
      mockApiKey,
      mockMcpAccessToken,
      mockMcpRefreshToken,
      mockDelegationSession,
    ]) {
      expect(m.updateMany).toHaveBeenCalledWith({
        where: { userId: { in: ["user-1"] }, revokedAt: null, tenantId: "tenant-2" },
        data: { revokedAt: expect.any(Date) },
      });
    }
    // OperatorToken keys on subjectUserId instead of userId.
    expect(mockOperatorToken.updateMany).toHaveBeenCalledWith({
      where: { subjectUserId: { in: ["user-1"] }, revokedAt: null, tenantId: "tenant-2" },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it("propagates error when a database operation fails", async () => {
    // The vault routes that call this answer the failure (admin reset before
    // the token is spent; passphrase change and recovery with
    // SESSION_INVALIDATE_FAILED). Departures revoke in their own transaction.
    mockSession.deleteMany.mockRejectedValue(new Error("db error"));
    await expect(
      invalidateUserSessions("user-1", { tenantId: "tenant-1" }),
    ).rejects.toThrow("db error");
  });

  // L2 — residual lockout surface (documentation test). A SCIM deactivation
  // or team removal no longer commits without its revocation (the revocation
  // runs in the departure's transaction, docs/archive/review/
  // session-revocation-failure-surfaces-plan.md). Should a deactivation commit
  // through some other path with the revokedAt writes missing, token classes
  // whose validators INDEPENDENTLY re-check tenantMember.deactivatedAt fail
  // closed on the next request regardless of revokedAt:
  //   - api_key            (api-key.ts C13)
  //   - extension_token    (extension-token.ts C13)
  //   - mcp_access_token + refresh rotation (oauth-server.ts checkTenantMembership)
  //
  // DelegationSession and OperatorToken have NO membership re-check INSIDE their
  // own validators, but they are NOT solely dependent on the revokedAt write:
  //   - DelegationSession: /api/vault/delegation/check authenticates via
  //     authOrToken → validateMcpToken (auth-or-token.ts), which DOES re-check
  //     deactivatedAt — so the MCP-token path is backstopped. The session-auth
  //     path relies on session invalidation succeeding OR route-level tenant
  //     membership checks; this PR does not pin that path.
  //   - OperatorToken: validateOperatorToken now re-checks active tenantMember
  //     membership itself (S4, operator-token.ts), and the maintenance/admin
  //     routes additionally call requireMaintenanceOperator(), which re-checks
  //     active OWNER/ADMIN membership with deactivatedAt:null (maintenance-auth.ts;
  //     tested in maintenance-auth.test.ts "filters out deactivated members").
  //     Do NOT rely on token expiry as the backstop: operator tokens live
  //     30–90 days (operator-token.ts constants).
  //
  // This test pins the producer half — invalidateUserSessions attempts to revoke
  // both artifacts; if that DB write fails, the residual exposure is covered by
  // the route-level membership checks above plus audit/alerting.
  it("revokes DelegationSession and OperatorToken (revokedAt write; route-level membership is the fail-open backstop)", async () => {
    await invalidateUserSessions("user-1", { tenantId: "tenant-1" });
    expect(mockDelegationSession.updateMany).toHaveBeenCalledWith({
      where: { userId: { in: ["user-1"] }, revokedAt: null, tenantId: "tenant-1" },
      data: { revokedAt: expect.any(Date) },
    });
    expect(mockOperatorToken.updateMany).toHaveBeenCalledWith({
      where: { subjectUserId: { in: ["user-1"] }, revokedAt: null, tenantId: "tenant-1" },
      data: { revokedAt: expect.any(Date) },
    });
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
      where: { userId: { in: ["user-1"] } },
      select: { sessionToken: true },
    });
    expect(mockSession.deleteMany).toHaveBeenCalledWith({
      where: { userId: { in: ["user-1"] } },
    });
    for (const m of [
      mockExtensionToken,
      mockApiKey,
      mockMcpAccessToken,
      mockMcpRefreshToken,
      mockDelegationSession,
    ]) {
      expect(m.updateMany).toHaveBeenCalledWith({
        where: { userId: { in: ["user-1"] }, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    }
    expect(mockOperatorToken.updateMany).toHaveBeenCalledWith({
      where: { subjectUserId: { in: ["user-1"] }, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });

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
      operatorTokens: 7,
      extensionBridgeCodes: 8,
      mobileBridgeCodes: 9,
      mcpAuthorizationCodes: 10,
      cacheTombstoneFailures: 0,
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

  it(
    "surfaces Redis tombstone failures into cacheTombstoneFailures so callers " +
      "can audit a silent cache outage during vault reset / member removal",
    async () => {
      mockSession.findMany.mockResolvedValue([
        { sessionToken: "tok-a" },
        { sessionToken: "tok-b" },
        { sessionToken: "tok-c" },
      ]);
      mockSession.deleteMany.mockResolvedValue({ count: 3 });
      // Simulate a partial Redis outage: 2 of 3 tombstones failed to land.
      mockInvalidateCachedSessions.mockResolvedValueOnce({ total: 3, failed: 2 });

      const result = await invalidateUserSessions("user-1", { tenantId: "tenant-1" });

      expect(result.cacheTombstoneFailures).toBe(2);
      // DB-side counts unchanged — reset was durable.
      expect(result.sessions).toBe(3);
    },
  );

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

describe("revokeUsersAuthArtifactsInTx", () => {
  const MODELS = [
    mockExtensionToken,
    mockApiKey,
    mockMcpAccessToken,
    mockMcpRefreshToken,
    mockDelegationSession,
    mockOperatorToken,
    mockExtensionBridgeCode,
    mockMobileBridgeCode,
    mockMcpAuthorizationCode,
  ];
  const tx = () =>
    ({
      session: mockSession,
      extensionToken: mockExtensionToken,
      apiKey: mockApiKey,
      mcpAccessToken: mockMcpAccessToken,
      mcpRefreshToken: mockMcpRefreshToken,
      delegationSession: mockDelegationSession,
      operatorToken: mockOperatorToken,
      extensionBridgeCode: mockExtensionBridgeCode,
      mobileBridgeCode: mockMobileBridgeCode,
      mcpAuthorizationCode: mockMcpAuthorizationCode,
      $executeRaw: mockExecuteRaw,
      $queryRaw: vi.fn(async () => [{ lock_timeout: "0", statement_timeout: "0" }]),
    }) as never;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteRaw.mockImplementation(async () => 0);
    mockSession.findMany.mockResolvedValue([{ sessionToken: "tok-a" }, { sessionToken: "tok-b" }]);
    mockSession.deleteMany.mockResolvedValue({ count: 2 });
    for (const m of MODELS) m.updateMany.mockResolvedValue({ count: 1 });
  });

  it("makes no call and returns zero counts for an empty list", async () => {
    const result = await revokeUsersAuthArtifactsInTx(tx(), [], { tenantFilter: { tenantId: "tenant-1" } });

    expect(mockExecuteRaw).not.toHaveBeenCalled();
    expect(mockSession.findMany).not.toHaveBeenCalled();
    expect(mockSession.deleteMany).not.toHaveBeenCalled();
    for (const m of MODELS) expect(m.updateMany).not.toHaveBeenCalled();
    expect(result.sessionTokens).toEqual([]);
    expect(Object.values(result.counts).every((count) => count === 0)).toBe(true);
    expect(Object.keys(result.counts)).toHaveLength(10);
  });

  it("locks every user in one statement, keyed byte for byte as a mint keys it, ordered by key in byte order", async () => {
    await revokeUsersAuthArtifactsInTx(tx(), ["user-b", "user-a"], { tenantFilter: { tenantId: "tenant-1" } });

    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    const sql = String(mockExecuteRaw.mock.calls[0]![0]);
    expect(sql).toContain("pg_advisory_xact_lock(hashtext(k))");
    expect(sql).toContain('ORDER BY k COLLATE "C"');
    expect(mockExecuteRaw.mock.calls[0]![1]).toEqual([userAuthLockKey("user-b"), userAuthLockKey("user-a")]);
  });

  it("filters every model by the users with `in` and carries the tenant filter", async () => {
    await revokeUsersAuthArtifactsInTx(tx(), ["user-a", "user-b"], { tenantFilter: { tenantId: "tenant-1" } });

    const users = { in: ["user-a", "user-b"] };
    expect(mockSession.deleteMany).toHaveBeenCalledWith({ where: { userId: users, tenantId: "tenant-1" } });
    for (const m of [mockExtensionToken, mockApiKey, mockMcpAccessToken, mockMcpRefreshToken, mockDelegationSession]) {
      expect(m.updateMany).toHaveBeenCalledWith({
        where: { userId: users, revokedAt: null, tenantId: "tenant-1" },
        data: { revokedAt: expect.any(Date) },
      });
    }
    expect(mockOperatorToken.updateMany).toHaveBeenCalledWith({
      where: { subjectUserId: users, revokedAt: null, tenantId: "tenant-1" },
      data: { revokedAt: expect.any(Date) },
    });
    for (const m of [mockExtensionBridgeCode, mockMobileBridgeCode, mockMcpAuthorizationCode]) {
      expect(m.updateMany).toHaveBeenCalledWith({
        where: { userId: users, usedAt: null, tenantId: "tenant-1" },
        data: { usedAt: expect.any(Date) },
      });
    }
  });

  it("returns the summed counts and the deleted sessions' digests", async () => {
    const result = await revokeUsersAuthArtifactsInTx(tx(), ["user-a", "user-b"], { tenantFilter: { tenantId: "tenant-1" } });

    expect(result.sessionTokens).toEqual(["tok-a", "tok-b"]);
    expect(result.counts).toMatchObject({ sessions: 2, extensionTokens: 1, operatorTokens: 1, mcpAuthorizationCodes: 1 });
  });

  it("bounds the lock wait when asked, raising UserAuthLockTimeoutError past it and revoking nothing", async () => {
    const lockTimeout = Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
    mockExecuteRaw.mockImplementation(async (...args: unknown[]) => {
      if (String(args[0]).includes("pg_advisory_xact_lock")) throw lockTimeout;
      return 0;
    });

    await expect(
      revokeUsersAuthArtifactsInTx(tx(), ["user-a"], { tenantFilter: { tenantId: "tenant-1" }, boundedLockWait: true }),
    ).rejects.toBeInstanceOf(UserAuthLockTimeoutError);
    expect(mockSession.deleteMany).not.toHaveBeenCalled();
  });

  it("without boundedLockWait, waits as a mint does: no lock_timeout is set around the lock", async () => {
    await revokeUsersAuthArtifactsInTx(tx(), ["user-a"], { tenantFilter: { tenantId: "tenant-1" } });

    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    expect(String(mockExecuteRaw.mock.calls[0]![0])).toContain("pg_advisory_xact_lock");
  });

  it("with boundedLockWait, sets lock_timeout around the one lock statement", async () => {
    await revokeUsersAuthArtifactsInTx(tx(), ["user-a"], { tenantFilter: { tenantId: "tenant-1" }, boundedLockWait: true });

    const statements = mockExecuteRaw.mock.calls.map((call) => String(call[0]));
    const lockAt = statements.findIndex((sql) => sql.includes("pg_advisory_xact_lock"));
    expect(statements.filter((sql) => sql.includes("pg_advisory_xact_lock"))).toHaveLength(1);
    expect(statements[lockAt - 1]).toContain("lock_timeout");
    expect(statements[lockAt + 1]).toContain("lock_timeout");
  });
});

describe("tombstoneRevokedSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvalidateCachedSessions.mockResolvedValue({ total: 0, failed: 0 });
  });

  it("does nothing for no tokens", async () => {
    expect(await tombstoneRevokedSessions([], { reason: "r", operation: "op" })).toBe(0);
    expect(mockInvalidateCachedSessions).not.toHaveBeenCalled();
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it("raises no signal when every tombstone lands", async () => {
    mockInvalidateCachedSessions.mockResolvedValueOnce({ total: 2, failed: 0 });

    expect(await tombstoneRevokedSessions(["a", "b"], { reason: "r", operation: "op", userId: "u" })).toBe(0);
    expect(mockInvalidateCachedSessions).toHaveBeenCalledWith(["a", "b"]);
    expect(mockLoggerError).not.toHaveBeenCalled();
    expect(mockSentryCaptureMessage).not.toHaveBeenCalled();
  });

  it("reports partial failures as the one on-call signal", async () => {
    mockInvalidateCachedSessions.mockResolvedValueOnce({ total: 3, failed: 2 });

    const failures = await tombstoneRevokedSessions(["a", "b", "c"], {
      reason: "scim_deprovision",
      operation: "SCIM user deprovisioning",
      userId: "u",
      extra: { tenantScope: "t" },
    });

    expect(failures).toBe(2);
    expect(mockLoggerError).toHaveBeenCalledWith(
      { userId: "u", failures: 2, reason: "scim_deprovision", _logType: "session.cache_tombstone_failures" },
      "session.cache_tombstone_failures",
    );
    expect(mockSentryCaptureMessage).toHaveBeenCalledWith("session cache tombstone failures during SCIM user deprovisioning", {
      level: "error",
      tags: { reason: "scim_deprovision" },
      extra: { userId: "u", failures: 2, tenantScope: "t" },
    });
  });

  it("never throws: a Redis throw counts every token as failed and logs the error", async () => {
    mockInvalidateCachedSessions.mockRejectedValueOnce(new Error("redis down"));

    const failures = await tombstoneRevokedSessions(["a", "b"], {
      reason: "tenant_member_passkey_revoke",
      operation: "tenant member passkey revoke",
      extra: { targetUserId: "target" },
    });

    expect(failures).toBe(2);
    const [fields, message] = mockLoggerError.mock.calls[0]!;
    expect(message).toBe("session.cache_tombstone_failures");
    expect(fields).toMatchObject({ failures: 2, _logType: "session.cache_tombstone_failures", error: expect.anything() });
    // No userId when none is given.
    expect(fields).not.toHaveProperty("userId");
    expect(mockSentryCaptureMessage).toHaveBeenCalledWith(
      "session cache tombstone failures during tenant member passkey revoke",
      expect.objectContaining({ extra: { failures: 2, targetUserId: "target" } }),
    );
  });

  it("tags a missing reason as unspecified and logs it as null", async () => {
    mockInvalidateCachedSessions.mockResolvedValueOnce({ total: 1, failed: 1 });

    await tombstoneRevokedSessions(["a"], { reason: null, operation: "invalidateUserSessions", userId: "u" });

    expect(mockLoggerError).toHaveBeenCalledWith(expect.objectContaining({ reason: null }), "session.cache_tombstone_failures");
    expect(mockSentryCaptureMessage).toHaveBeenCalledWith(
      "session cache tombstone failures during invalidateUserSessions",
      expect.objectContaining({ tags: { reason: "unspecified" } }),
    );
  });

  // The adopters' signal (plan C5 table): invalidateUserSessions keeps the
  // exact log fields, message and Sentry payload it raised before the helper.
  it("raises invalidateUserSessions' signal unchanged", async () => {
    mockSession.findMany.mockResolvedValue([{ sessionToken: "tok-a" }]);
    mockSession.deleteMany.mockResolvedValue({ count: 1 });
    for (const m of [
      mockExtensionToken,
      mockApiKey,
      mockMcpAccessToken,
      mockMcpRefreshToken,
      mockDelegationSession,
      mockOperatorToken,
      mockExtensionBridgeCode,
      mockMobileBridgeCode,
      mockMcpAuthorizationCode,
    ]) m.updateMany.mockResolvedValue({ count: 0 });
    mockInvalidateCachedSessions.mockResolvedValueOnce({ total: 1, failed: 1 });

    await invalidateUserSessions("user-1", { allTenants: true, reason: "admin_vault_reset" });

    expect(mockLoggerError).toHaveBeenCalledWith(
      { userId: "user-1", failures: 1, reason: "admin_vault_reset", _logType: "session.cache_tombstone_failures" },
      "session.cache_tombstone_failures",
    );
    expect(mockSentryCaptureMessage).toHaveBeenCalledWith("session cache tombstone failures during invalidateUserSessions", {
      level: "error",
      tags: { reason: "admin_vault_reset" },
      extra: { userId: "user-1", failures: 1, tenantScope: "all" },
    });
  });
});

// #959 F5/F19: sibling of invalidateTenantSessionsCache, scoped by userId
// instead of tenantId — called by every writer of `hasPasskey`.
describe("invalidateUserSessionsCache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is deliberately cross-tenant: queries by userId with no tenant filter", async () => {
    mockSession.findMany.mockResolvedValue([
      { sessionToken: "tok-a" },
      { sessionToken: "tok-b" },
    ]);
    mockInvalidateCachedSessionsBulkByDigest.mockResolvedValue({ total: 2, failed: 0 });

    const result = await invalidateUserSessionsCache("user-1");

    expect(mockSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", expires: { gt: expect.any(Date) } },
      }),
    );
    expect(mockInvalidateCachedSessionsBulkByDigest).toHaveBeenCalledWith(["tok-a", "tok-b"]);
    expect(result).toEqual({ totalSessions: 2, cacheTombstoneFailures: 0 });
  });

  it("returns zero counts without calling the bulk tombstone when the user has no live sessions", async () => {
    mockSession.findMany.mockResolvedValue([]);

    const result = await invalidateUserSessionsCache("user-1");

    expect(result).toEqual({ totalSessions: 0, cacheTombstoneFailures: 0 });
    expect(mockInvalidateCachedSessionsBulkByDigest).not.toHaveBeenCalled();
  });

  it("surfaces tombstone failures so the caller can log a Redis outage", async () => {
    mockSession.findMany.mockResolvedValue([{ sessionToken: "tok-a" }]);
    mockInvalidateCachedSessionsBulkByDigest.mockResolvedValue({ total: 1, failed: 1 });

    const result = await invalidateUserSessionsCache("user-1");

    expect(result).toEqual({ totalSessions: 1, cacheTombstoneFailures: 1 });
  });

  it("propagates a DB failure (fail-closed — the caller decides how to handle it)", async () => {
    mockSession.findMany.mockRejectedValue(new Error("db down"));

    await expect(invalidateUserSessionsCache("user-1")).rejects.toThrow("db down");
    expect(mockInvalidateCachedSessionsBulkByDigest).not.toHaveBeenCalled();
  });
});
