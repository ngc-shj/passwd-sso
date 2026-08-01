import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "../../../../../__tests__/helpers/request-builder";

const {
  mockAuth,
  mockWithBypassRls,
  mockResolveUserTenantId,
  mockRateLimiterCheck,
  mockMcpAccessTokenFindFirst,
  mockMcpAccessTokenUpdate,
  mockMcpAccessTokenUpdateMany,
  mockMcpRefreshTokenFindMany,
  mockMcpRefreshTokenUpdateMany,
  mockDelegationSessionFindMany,
  mockDelegationSessionUpdateMany,
  mockAuditLogCreate,
  mockEvictDelegationRedisKeys,
  mockTransaction,
  mockCommitMarker,
  prismaMock,
} = vi.hoisted(() => {
  const mockMcpAccessTokenFindFirst = vi.fn();
  const mockMcpAccessTokenUpdate = vi.fn();
  const mockMcpAccessTokenUpdateMany = vi.fn();
  const mockMcpRefreshTokenFindMany = vi.fn();
  const mockMcpRefreshTokenUpdateMany = vi.fn();
  const mockDelegationSessionFindMany = vi.fn();
  const mockDelegationSessionUpdateMany = vi.fn();
  const mockAuditLogCreate = vi.fn();
  // The production `prisma` proxy forwards a nested $transaction to the active
  // RLS-context tx (src/lib/prisma.ts), so the callback receives the same
  // client. Mirror that rather than handing it a second, distinct object.
  const mockTransaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(prismaMock));
  const prismaMock = {
    mcpAccessToken: {
      findFirst: mockMcpAccessTokenFindFirst,
      update: mockMcpAccessTokenUpdate,
      updateMany: mockMcpAccessTokenUpdateMany,
    },
    mcpRefreshToken: {
      findMany: mockMcpRefreshTokenFindMany,
      updateMany: mockMcpRefreshTokenUpdateMany,
    },
    delegationSession: {
      findMany: mockDelegationSessionFindMany,
      updateMany: mockDelegationSessionUpdateMany,
    },
    auditLog: { create: mockAuditLogCreate },
    $transaction: mockTransaction,
  };
  // Stands in for the commit boundary: called once the withBypassRls callback
  // has resolved. Eviction launched from inside that callback records an
  // earlier invocation order than this marker, which is what separates
  // "evicts after the transaction" from "evicts while it is still open".
  const mockCommitMarker = vi.fn();
  return {
    mockCommitMarker,
    mockAuth: vi.fn(),
    mockWithBypassRls: vi.fn(async (prisma: unknown, fn: (tx: unknown) => unknown) => {
      const out = await fn(prisma);
      mockCommitMarker();
      return out;
    }),
    mockResolveUserTenantId: vi.fn(),
    mockRateLimiterCheck: vi.fn().mockResolvedValue({ allowed: true }),
    mockMcpAccessTokenFindFirst,
    mockMcpAccessTokenUpdate,
    mockMcpAccessTokenUpdateMany,
    mockMcpRefreshTokenFindMany,
    mockMcpRefreshTokenUpdateMany,
    mockDelegationSessionFindMany,
    mockDelegationSessionUpdateMany,
    mockAuditLogCreate,
    mockEvictDelegationRedisKeys: vi.fn().mockResolvedValue(undefined),
    mockTransaction,
    prismaMock,
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  withBypassRls: mockWithBypassRls,
}));
vi.mock("@/lib/tenant-context", () => ({ resolveUserTenantId: mockResolveUserTenantId }));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateLimiterCheck }),
}));
vi.mock("@/lib/auth/access/delegation", () => ({
  evictDelegationRedisKeys: mockEvictDelegationRedisKeys,
}));
vi.mock("@/lib/http/with-request-log", () => ({ withRequestLog: <T>(fn: T) => fn }));
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

import { DELETE } from "./route";

const TOKEN_ID = "token-1";
const USER_ID = "user-1";
const TENANT_ID = "tenant-1";

function makeRequest() {
  return createRequest("DELETE", `http://localhost/api/user/mcp-tokens/${TOKEN_ID}`);
}

function invoke() {
  return DELETE(makeRequest(), { params: Promise.resolve({ id: TOKEN_ID }) });
}

/** Every write this handler can perform. */
function mutations() {
  return [
    mockMcpAccessTokenUpdate,
    mockMcpAccessTokenUpdateMany,
    mockMcpRefreshTokenUpdateMany,
    mockDelegationSessionUpdateMany,
    mockAuditLogCreate,
  ];
}

function expectNoMutations() {
  for (const m of mutations()) {
    expect(m).not.toHaveBeenCalled();
  }
}

describe("DELETE /api/user/mcp-tokens/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: USER_ID } });
    mockResolveUserTenantId.mockResolvedValue(TENANT_ID);
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
    mockMcpAccessTokenFindFirst.mockResolvedValue({ id: TOKEN_ID });
    mockMcpRefreshTokenFindMany.mockResolvedValue([]);
    mockDelegationSessionFindMany.mockResolvedValue([]);
  });

  // ─── Auth / preconditions ─────────────────────────────────

  it("returns 401 without a session, touching nothing", async () => {
    mockAuth.mockResolvedValue(null);

    const res = await invoke();

    expect(res.status).toBe(401);
    expectNoMutations();
    expect(mockMcpAccessTokenFindFirst).not.toHaveBeenCalled();
  });

  it("returns NO_TENANT when the user has no active tenant, touching nothing", async () => {
    mockResolveUserTenantId.mockResolvedValue(null);

    const res = await invoke();

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("NO_TENANT");
    expectNoMutations();
  });

  it("returns 429 when rate limited, before any lookup", async () => {
    mockRateLimiterCheck.mockResolvedValue({ allowed: false, retryAfterMs: 30_000 });

    const res = await invoke();

    expect(res.status).toBe(429);
    expect(mockRateLimiterCheck).toHaveBeenCalledWith(`rl:mcp_revoke:${USER_ID}`);
    expectNoMutations();
    expect(mockMcpAccessTokenFindFirst).not.toHaveBeenCalled();
  });

  it("returns 404 without revoking anything when the token is not the caller's", async () => {
    // The lookup is already owner-scoped, so a token belonging to another user
    // simply misses. Asserting the absence of writes is the point: a 404 that
    // still ran the cascade would be a silent cross-user revoke.
    mockMcpAccessTokenFindFirst.mockResolvedValue(null);

    const res = await invoke();

    expect(res.status).toBe(404);
    expectNoMutations();
  });

  it("scopes the token lookup to the caller and to unrevoked rows", async () => {
    await invoke();

    expect(mockMcpAccessTokenFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: TOKEN_ID, userId: USER_ID, tenantId: TENANT_ID, revokedAt: null },
      }),
    );
  });

  // ─── Revocation cascade ───────────────────────────────────

  it("revokes the token itself scoped by owner", async () => {
    const res = await invoke();

    expect(res.status).toBe(204);
    expect(mockMcpAccessTokenUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: TOKEN_ID, userId: USER_ID, tenantId: TENANT_ID },
        data: { revokedAt: expect.any(Date) },
      }),
    );
  });

  it("skips family work when the token has no refresh tokens", async () => {
    mockMcpRefreshTokenFindMany.mockResolvedValue([]);

    await invoke();

    expect(mockMcpRefreshTokenUpdateMany).not.toHaveBeenCalled();
    expect(mockMcpAccessTokenUpdateMany).not.toHaveBeenCalled();
  });

  it("revokes the whole refresh family and its sibling access tokens, scoped by owner", async () => {
    mockMcpRefreshTokenFindMany
      .mockResolvedValueOnce([{ familyId: "fam-1" }, { familyId: "fam-1" }, { familyId: "fam-2" }])
      .mockResolvedValueOnce([
        { accessTokenId: TOKEN_ID },
        { accessTokenId: "token-2" },
        { accessTokenId: "token-2" },
      ]);

    await invoke();

    // Families deduplicated
    expect(mockMcpRefreshTokenUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          familyId: { in: ["fam-1", "fam-2"] },
          userId: USER_ID,
          tenantId: TENANT_ID,
          revokedAt: null,
        },
      }),
    );
    // The sibling sweep is the one write whose reach is decided by data rather
    // than by the caller, and it runs with RLS bypassed — so it must carry the
    // owner predicate, exactly as the collection route's equivalent does.
    expect(mockMcpAccessTokenUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: { in: [TOKEN_ID, "token-2"] },
          userId: USER_ID,
          tenantId: TENANT_ID,
          revokedAt: null,
        },
      }),
    );
  });

  it("revokes delegation sessions bound to rotated-away siblings, not just the named token", async () => {
    // A session created before a refresh rotation carries the OLD access-token
    // id. Revoking only `mcpTokenId: id` leaves it live and its Redis metadata
    // un-evicted until TTL.
    mockMcpRefreshTokenFindMany
      .mockResolvedValueOnce([{ familyId: "fam-1" }])
      .mockResolvedValueOnce([{ accessTokenId: TOKEN_ID }, { accessTokenId: "token-old" }]);
    mockDelegationSessionFindMany.mockResolvedValue([{ id: "ds-1" }, { id: "ds-2" }]);

    await invoke();

    const expectedScope = {
      mcpTokenId: { in: [TOKEN_ID, "token-old"] },
      userId: USER_ID,
      tenantId: TENANT_ID,
      revokedAt: null,
    };
    expect(mockDelegationSessionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expectedScope }),
    );
    expect(mockDelegationSessionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expectedScope }),
    );
  });

  it("does not issue a delegation update when no session matches", async () => {
    mockDelegationSessionFindMany.mockResolvedValue([]);

    await invoke();

    expect(mockDelegationSessionUpdateMany).not.toHaveBeenCalled();
    expect(mockEvictDelegationRedisKeys).not.toHaveBeenCalled();
  });

  // ─── Audit ────────────────────────────────────────────────

  it("writes the connection-revoke audit row inside the transaction", async () => {
    await invoke();

    expect(mockAuditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: USER_ID,
          tenantId: TENANT_ID,
          action: "MCP_CONNECTION_REVOKE",
          targetType: "McpAccessToken",
          targetId: TOKEN_ID,
        }),
      }),
    );
    // Same client instance as the outer callback — the audit row commits with
    // the revocation or not at all.
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it("writes one audit row per revoked delegation session", async () => {
    mockDelegationSessionFindMany.mockResolvedValue([{ id: "ds-1" }, { id: "ds-2" }]);

    await invoke();

    const delegationAudits = mockAuditLogCreate.mock.calls.filter(
      (call) => call[0].data.action === "DELEGATION_REVOKE",
    );
    expect(delegationAudits).toHaveLength(2);
    expect(delegationAudits.map((call) => call[0].data.targetId)).toEqual(["ds-1", "ds-2"]);
  });

  // ─── Redis eviction ───────────────────────────────────────

  it("evicts Redis keys for every revoked session after the transaction returns", async () => {
    mockDelegationSessionFindMany.mockResolvedValue([{ id: "ds-1" }, { id: "ds-2" }]);

    await invoke();

    expect(mockEvictDelegationRedisKeys).toHaveBeenCalledTimes(2);
    expect(mockEvictDelegationRedisKeys).toHaveBeenCalledWith(USER_ID, "ds-1");
    expect(mockEvictDelegationRedisKeys).toHaveBeenCalledWith(USER_ID, "ds-2");
    // Eviction must not start before the transaction has committed — launching
    // it from inside the callback (as this route once did, contradicting its
    // own comment) can drop keys for a revocation that then rolls back.
    const evictOrder = mockEvictDelegationRedisKeys.mock.invocationCallOrder[0];
    const commitOrder = mockCommitMarker.mock.invocationCallOrder[0];
    expect(evictOrder).toBeGreaterThan(commitOrder);
  });

  it("still returns 204 when Redis eviction rejects", async () => {
    mockDelegationSessionFindMany.mockResolvedValue([{ id: "ds-1" }]);
    mockEvictDelegationRedisKeys.mockRejectedValue(new Error("redis down"));

    const res = await invoke();

    expect(res.status).toBe(204);
  });
});
