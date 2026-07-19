import { describe, it, expect, vi, beforeEach } from "vitest";
import { assertRedisFailClosed, snapshotFactory } from "@/__tests__/helpers/fail-closed";

const {
  mockAuthOrToken,
  mockPrismaDelegationSession,
  mockWithBypassRls,
  mockRateLimiterCheck,
  mockCreateRateLimiter,
  mockLogAudit,
  mockEnforceAccessRestriction,
} = vi.hoisted(() => {
  const mockRateLimiterCheck = vi.fn();
  return {
    mockAuthOrToken: vi.fn(),
    mockPrismaDelegationSession: {
      findFirst: vi.fn(),
    },
    mockWithBypassRls: vi.fn(async (prisma: unknown, fn: (tx: unknown) => unknown) => fn(prisma)),
    mockRateLimiterCheck,
    // F: recording factory — assertRedisFailClosed's factory-attribution step
    // reads mockCreateRateLimiter.mock.{calls,results}.
    mockCreateRateLimiter: vi.fn((_opts: unknown) => ({ check: mockRateLimiterCheck, clear: vi.fn() })),
    mockLogAudit: vi.fn(),
    mockEnforceAccessRestriction: vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(null),
  };
});

vi.mock("@/lib/auth/session/auth-or-token", () => ({
  authOrToken: mockAuthOrToken,
  hasUserId: (auth: { type: string }) => "userId" in auth,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    delegationSession: mockPrismaDelegationSession,
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: mockCreateRateLimiter,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  personalAuditBase: (_req: unknown, userId: string) => ({ scope: "PERSONAL", userId, ip: "127.0.0.1", userAgent: null, acceptLanguage: null }),
  teamAuditBase: (_req: unknown, userId: string, teamId: string) => ({ scope: "TEAM", userId, teamId, ip: "127.0.0.1", userAgent: null, acceptLanguage: null }),
  tenantAuditBase: (_req: unknown, userId: string, tenantId: string) => ({ scope: "TENANT", userId, tenantId, ip: "127.0.0.1", userAgent: null, acceptLanguage: null }),
}));
vi.mock("@/lib/auth/policy/ip-access", () => ({
  extractClientIp: vi.fn(() => "127.0.0.1"),
}));
vi.mock("@/lib/auth/policy/access-restriction", () => ({
  enforceAccessRestriction: mockEnforceAccessRestriction,
}));
vi.mock("@/lib/logger", () => ({
  default: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { GET } from "./route";
import { NextRequest } from "next/server";

// Module-level `checkRateLimiter = createRateLimiter(...)` runs at import
// time, above. Snapshot the recorded factory call now (module scope, before
// any test/beforeEach executes) — the global beforeEach's vi.clearAllMocks()
// would otherwise wipe mockCreateRateLimiter.mock.calls/.results before the
// first test runs.
const checkRateLimiterFactorySnapshot = snapshotFactory(mockCreateRateLimiter);
const checkRateLimiter = mockCreateRateLimiter.mock.results[0]!.value as {
  check: typeof mockRateLimiterCheck;
};

const VALID_CLIENT_ID = "mcpc_f47ac10b58cc4372a5670e02b2c3d479";
const VALID_ENTRY_ID = "entry-abc-123";
const SESSION_ID = "session-id-abc";
const EXPIRES_AT = new Date("2099-01-01T00:00:00Z");

const makeRequest = (params: Record<string, string>) => {
  const url = new URL("http://localhost/api/vault/delegation/check");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return new NextRequest(url.toString(), { method: "GET" });
};

describe("GET /api/vault/delegation/check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthOrToken.mockResolvedValue({ type: "session", userId: "user-1" });
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
    mockPrismaDelegationSession.findFirst.mockResolvedValue(null);
  });

  it("returns 401 when not authenticated", async () => {
    mockAuthOrToken.mockResolvedValue(null);
    const res = await GET(makeRequest({ clientId: VALID_CLIENT_ID, entryId: VALID_ENTRY_ID }));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.authorized).toBe(false);
    expect(json.reason).toBe("unauthorized");
  });

  it("returns 403 when scope is insufficient", async () => {
    mockAuthOrToken.mockResolvedValue({ type: "scope_insufficient" });
    const res = await GET(makeRequest({ clientId: VALID_CLIENT_ID, entryId: VALID_ENTRY_ID }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.authorized).toBe(false);
  });

  it("returns 403 scope_insufficient when mcp_token lacks delegation:check", async () => {
    mockAuthOrToken.mockResolvedValue({ type: "scope_insufficient" });
    const res = await GET(makeRequest({ clientId: VALID_CLIENT_ID, entryId: VALID_ENTRY_ID }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.authorized).toBe(false);
  });

  it("returns 403 when extension_token is used", async () => {
    // extension tokens do not carry delegation:check scope; authOrToken returns scope_insufficient
    mockAuthOrToken.mockResolvedValue({ type: "scope_insufficient" });
    const res = await GET(makeRequest({ clientId: VALID_CLIENT_ID, entryId: VALID_ENTRY_ID }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.authorized).toBe(false);
  });

  it("returns 403 when api_key is used", async () => {
    // api_keys do not carry delegation:check scope; authOrToken returns scope_insufficient
    mockAuthOrToken.mockResolvedValue({ type: "scope_insufficient" });
    const res = await GET(makeRequest({ clientId: VALID_CLIENT_ID, entryId: VALID_ENTRY_ID }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.authorized).toBe(false);
  });

  it("returns 403 when sa_token is used (intentionally unsupported)", async () => {
    // SA tokens lack userId and are MCP-client-agnostic; delegation check is intentionally
    // unsupported for SA tokens (follow-up PR required for parallel serviceAccountId lookup)
    mockAuthOrToken.mockResolvedValue({ type: "scope_insufficient" });
    const res = await GET(makeRequest({ clientId: VALID_CLIENT_ID, entryId: VALID_ENTRY_ID }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.authorized).toBe(false);
  });

  it("returns 403 when Bearer token is from outside tenant IP range", async () => {
    mockAuthOrToken.mockResolvedValue({
      type: "mcp_token",
      userId: "user-1",
      tenantId: "tenant-1",
      tokenId: "tok-1",
      // Token must own the queried clientId — intra-user IDOR guard runs
      // AFTER enforceAccessRestriction, so we still need IP-range denial first.
      mcpClientId: VALID_CLIENT_ID,
      scopes: ["delegation:check"],
    });
    const denied = new Response(
      JSON.stringify({ error: "ACCESS_DENIED" }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
    mockEnforceAccessRestriction.mockResolvedValueOnce(denied);

    const res = await GET(makeRequest({ clientId: VALID_CLIENT_ID, entryId: VALID_ENTRY_ID }));

    expect(res.status).toBe(403);
    // Must not look up delegation or log audit when IP is denied
    expect(mockPrismaDelegationSession.findFirst).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("returns 403 when MCP token's mcpClientId does not match query clientId (intra-user IDOR guard)", async () => {
    // Token issued for one MCP client cannot query delegation state of another
    // MCP client owned by the same user.
    const OTHER_CLIENT_ID = "mcpc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    mockAuthOrToken.mockResolvedValue({
      type: "mcp_token",
      userId: "user-1",
      tenantId: "tenant-1",
      tokenId: "tok-1",
      mcpClientId: OTHER_CLIENT_ID,
      scopes: ["delegation:check"],
    });

    const res = await GET(makeRequest({ clientId: VALID_CLIENT_ID, entryId: VALID_ENTRY_ID }));

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.authorized).toBe(false);
    // Lookup MUST NOT run — guard fires before the DB query
    expect(mockPrismaDelegationSession.findFirst).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimiterCheck.mockResolvedValue({ allowed: false, retryAfterMs: 30000 });
    const res = await GET(makeRequest({ clientId: VALID_CLIENT_ID, entryId: VALID_ENTRY_ID }));
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.authorized).toBe(false);
    expect(json.reason).toBe("rate_limit");
    expect(res.headers.get("Retry-After")).toBe("30");
  });

  it("fails closed (503, no mutation) when Redis is unavailable", async () => {
    await assertRedisFailClosed({
      invoke: () =>
        GET(makeRequest({ clientId: VALID_CLIENT_ID, entryId: VALID_ENTRY_ID })),
      limiter: checkRateLimiter,
      expectation: {
        envelope: "custom",
        status: 503,
        body: { authorized: false, reason: "service_unavailable" },
        retryAfter: "required",
      },
      // M9: logAuditAsync is NOT included — the production 503 path itself
      // fires emitRateLimitFailClosed -> logAuditAsync for authed users
      // (rate-limit-audit.ts:240,:155); spying it as "no mutation" would
      // race the intended emission.
      assertNoMutation: [mockPrismaDelegationSession.findFirst],
      limiterFactory: checkRateLimiterFactorySnapshot.replay(),
      failure: { allowed: false, redisErrored: true },
    });
  });

  it("returns 400 when clientId is missing", async () => {
    const res = await GET(makeRequest({ entryId: VALID_ENTRY_ID }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when clientId does not start with mcpc_", async () => {
    const res = await GET(makeRequest({ clientId: "not-valid", entryId: VALID_ENTRY_ID }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when entryId is missing", async () => {
    const res = await GET(makeRequest({ clientId: VALID_CLIENT_ID }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when entryId contains invalid characters", async () => {
    const res = await GET(makeRequest({ clientId: VALID_CLIENT_ID, entryId: "entry id!" }));
    expect(res.status).toBe(400);
  });

  it("returns 403 with reason no_session when no active delegation exists", async () => {
    mockPrismaDelegationSession.findFirst.mockResolvedValue(null);
    const res = await GET(makeRequest({ clientId: VALID_CLIENT_ID, entryId: VALID_ENTRY_ID }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.reason).toBe("no_session");
  });

  it("returns 403 with reason entry_not_delegated when entryId is not in session", async () => {
    mockPrismaDelegationSession.findFirst.mockResolvedValue({
      id: SESSION_ID,
      expiresAt: EXPIRES_AT,
      entryIds: ["other-entry-1", "other-entry-2"],
    });

    const res = await GET(makeRequest({ clientId: VALID_CLIENT_ID, entryId: VALID_ENTRY_ID }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.reason).toBe("entry_not_delegated");
  });

  it("returns 403 when session has empty entryIds", async () => {
    mockPrismaDelegationSession.findFirst.mockResolvedValue({
      id: SESSION_ID,
      expiresAt: EXPIRES_AT,
      entryIds: [],
    });

    const res = await GET(makeRequest({ clientId: VALID_CLIENT_ID, entryId: VALID_ENTRY_ID }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.reason).toBe("entry_not_delegated");
  });

  it("returns 200 with authorized:true when entry is delegated", async () => {
    mockPrismaDelegationSession.findFirst.mockResolvedValue({
      id: SESSION_ID,
      expiresAt: EXPIRES_AT,
      entryIds: [VALID_ENTRY_ID, "other-entry"],
    });

    const res = await GET(makeRequest({ clientId: VALID_CLIENT_ID, entryId: VALID_ENTRY_ID }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.authorized).toBe(true);
    expect(json.sessionId).toBe(SESSION_ID);
    expect(json.expiresAt).toBe(EXPIRES_AT.toISOString());
  });

  it("fires audit log with correct action on success", async () => {
    mockPrismaDelegationSession.findFirst.mockResolvedValue({
      id: SESSION_ID,
      expiresAt: EXPIRES_AT,
      entryIds: [VALID_ENTRY_ID],
    });

    await GET(makeRequest({ clientId: VALID_CLIENT_ID, entryId: VALID_ENTRY_ID }));

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "DELEGATION_CHECK",
        scope: "PERSONAL",
        userId: "user-1",
        targetId: VALID_ENTRY_ID,
        metadata: expect.objectContaining({
          clientId: VALID_CLIENT_ID,
          sessionId: SESSION_ID,
        }),
      }),
    );
  });

  it("does not fire audit log on failure", async () => {
    mockPrismaDelegationSession.findFirst.mockResolvedValue(null);
    await GET(makeRequest({ clientId: VALID_CLIENT_ID, entryId: VALID_ENTRY_ID }));
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("queries DB with correct userId and clientId via join", async () => {
    mockPrismaDelegationSession.findFirst.mockResolvedValue({
      id: SESSION_ID,
      expiresAt: EXPIRES_AT,
      entryIds: [VALID_ENTRY_ID],
    });

    await GET(makeRequest({ clientId: VALID_CLIENT_ID, entryId: VALID_ENTRY_ID }));

    expect(mockPrismaDelegationSession.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user-1",
          mcpAccessToken: expect.objectContaining({
            mcpClient: expect.objectContaining({ clientId: VALID_CLIENT_ID }),
          }),
          revokedAt: null,
        }),
      }),
    );
  });
});
