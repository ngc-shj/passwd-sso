import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockAuth,
  mockResolveUserTenantId,
  mockAssertOrigin,
  mockRateLimiterCheck,
  mockLogAudit,
  mockWithBypassRls,
  mockPrismaMcpAccessToken,
  mockPrismaTenant,
  mockPrismaPasswordEntry,
  mockPrismaDelegationSession,
  mockStoreDelegationEntries,
  mockEvictDelegationRedisKeys,
  mockRevokeAllDelegationSessions,
} = vi.hoisted(() => {
  const mockPrismaMcpAccessToken = { findFirst: vi.fn(), findMany: vi.fn() };
  const mockPrismaTenant = { findUnique: vi.fn() };
  const mockPrismaPasswordEntry = { findMany: vi.fn() };
  const mockPrismaDelegationSession = {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
  };

  return {
    mockAuth: vi.fn(),
    mockResolveUserTenantId: vi.fn(),
    mockAssertOrigin: vi.fn(() => null),
    mockRateLimiterCheck: vi.fn(),
    mockLogAudit: vi.fn(),
    mockWithBypassRls: vi.fn(async (_prisma: unknown, fn: () => unknown) => fn()),
    mockPrismaMcpAccessToken,
    mockPrismaTenant,
    mockPrismaPasswordEntry,
    mockPrismaDelegationSession,
    mockStoreDelegationEntries: vi.fn(),
    mockEvictDelegationRedisKeys: vi.fn().mockResolvedValue(undefined),
    mockRevokeAllDelegationSessions: vi.fn(),
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/tenant-context", () => ({ resolveUserTenantId: mockResolveUserTenantId }));
vi.mock("@/lib/csrf", () => ({ assertOrigin: mockAssertOrigin }));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateLimiterCheck }),
}));
vi.mock("@/lib/audit", () => ({ logAudit: mockLogAudit }));
vi.mock("@/lib/ip-access", () => ({ extractClientIp: vi.fn(() => "127.0.0.1") }));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>, withBypassRls: mockWithBypassRls }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    mcpAccessToken: mockPrismaMcpAccessToken,
    tenant: mockPrismaTenant,
    passwordEntry: mockPrismaPasswordEntry,
    delegationSession: mockPrismaDelegationSession,
  },
}));
vi.mock("@/lib/delegation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/delegation")>();
  return {
    ...actual,
    storeDelegationEntries: mockStoreDelegationEntries,
    evictDelegationRedisKeys: mockEvictDelegationRedisKeys,
    revokeAllDelegationSessions: mockRevokeAllDelegationSessions,
  };
});
vi.mock("@/lib/with-request-log", () => ({
  withRequestLog: (handler: unknown) => handler,
}));
vi.mock("@/lib/logger", () => ({
  default: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { POST, GET, DELETE } from "./route";
import { NextRequest } from "next/server";

// ─── Test Fixtures ───────────────────────────────────────────────

const USER_ID = "user-abc-123";
const TENANT_ID = "tenant-abc-456";
const MCP_TOKEN_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const ENTRY_ID_1 = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const ENTRY_ID_2 = "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e";
const SESSION_ID = "session-id-abc";
const MCP_CLIENT_ID = "mcpc_f47ac10b58cc4372a5670e02b2c3d479";
const EXPIRES_AT = new Date("2099-01-01T00:00:00Z");

const VALID_ENTRIES = [
  { id: ENTRY_ID_1, title: "Entry 1", username: "user1", urlHost: "example.com", tags: ["work"] },
  { id: ENTRY_ID_2, title: "Entry 2", username: null, urlHost: null, tags: null },
];

const VALID_POST_BODY = {
  mcpTokenId: MCP_TOKEN_ID,
  ttlSeconds: 900,
  note: "test session",
  entries: VALID_ENTRIES,
};

const VALID_MCP_TOKEN = {
  id: MCP_TOKEN_ID,
  scope: "credentials:list",
  clientId: MCP_CLIENT_ID,
};

const makePostRequest = (body: unknown) =>
  new NextRequest("http://localhost/api/vault/delegation", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost" },
    body: JSON.stringify(body),
  });

const makeGetRequest = () =>
  new NextRequest("http://localhost/api/vault/delegation", {
    method: "GET",
    headers: { Origin: "http://localhost" },
  });

const makeDeleteRequest = () =>
  new NextRequest("http://localhost/api/vault/delegation", {
    method: "DELETE",
    headers: { Origin: "http://localhost" },
  });

// ─── POST Tests ──────────────────────────────────────────────────

describe("POST /api/vault/delegation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertOrigin.mockReturnValue(null);
    mockAuth.mockResolvedValue({ user: { id: USER_ID } });
    mockResolveUserTenantId.mockResolvedValue(TENANT_ID);
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
    mockPrismaMcpAccessToken.findFirst.mockResolvedValue(VALID_MCP_TOKEN);
    mockPrismaTenant.findUnique.mockResolvedValue({
      delegationDefaultTtlSec: null,
      delegationMaxTtlSec: null,
    });
    mockPrismaPasswordEntry.findMany.mockResolvedValue(
      VALID_ENTRIES.map((e) => ({ id: e.id })),
    );
    mockPrismaDelegationSession.findFirst.mockResolvedValue(null);
    mockPrismaDelegationSession.create.mockResolvedValue({
      id: SESSION_ID,
      expiresAt: EXPIRES_AT,
    });
    mockStoreDelegationEntries.mockResolvedValue(undefined);
  });

  it("returns 401 when no session", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(makePostRequest(VALID_POST_BODY));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 403 when no tenant", async () => {
    mockResolveUserTenantId.mockResolvedValue(null);
    const res = await POST(makePostRequest(VALID_POST_BODY));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("NO_TENANT");
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimiterCheck.mockResolvedValue({ allowed: false, retryAfterMs: 30000 });
    const res = await POST(makePostRequest(VALID_POST_BODY));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
  });

  it("returns 400 for missing mcpTokenId", async () => {
    const { mcpTokenId: _omit, ...body } = VALID_POST_BODY;
    const res = await POST(makePostRequest(body));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 400 for non-UUID mcpTokenId", async () => {
    const res = await POST(makePostRequest({ ...VALID_POST_BODY, mcpTokenId: "not-a-uuid" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for empty entries array", async () => {
    const res = await POST(makePostRequest({ ...VALID_POST_BODY, entries: [] }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when entries entry is missing title", async () => {
    const res = await POST(
      makePostRequest({
        ...VALID_POST_BODY,
        entries: [{ id: ENTRY_ID_1, username: "u" }],
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when entry id is not a UUID", async () => {
    const res = await POST(
      makePostRequest({
        ...VALID_POST_BODY,
        entries: [{ id: "not-uuid", title: "Entry" }],
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when MCP token not found", async () => {
    mockPrismaMcpAccessToken.findFirst.mockResolvedValue(null);
    const res = await POST(makePostRequest(VALID_POST_BODY));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("MCP_TOKEN_NOT_FOUND");
  });

  it("returns 403 when MCP token lacks delegation scope", async () => {
    mockPrismaMcpAccessToken.findFirst.mockResolvedValue({
      ...VALID_MCP_TOKEN,
      scope: "vault:status",
    });
    const res = await POST(makePostRequest(VALID_POST_BODY));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("MCP_TOKEN_SCOPE_INSUFFICIENT");
  });

  it("accepts credentials:use scope", async () => {
    mockPrismaMcpAccessToken.findFirst.mockResolvedValue({
      ...VALID_MCP_TOKEN,
      scope: "credentials:use",
    });
    const res = await POST(makePostRequest(VALID_POST_BODY));
    expect(res.status).toBe(200);
  });

  it("returns 403 when entries not owned by user", async () => {
    // Only ENTRY_ID_1 owned, ENTRY_ID_2 is not
    mockPrismaPasswordEntry.findMany.mockResolvedValue([{ id: ENTRY_ID_1 }]);
    const res = await POST(makePostRequest(VALID_POST_BODY));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("DELEGATION_ENTRIES_NOT_FOUND");
  });

  it("auto-revokes existing delegation session for same token", async () => {
    mockPrismaDelegationSession.findFirst.mockResolvedValue({ id: "old-session-id" });
    mockPrismaDelegationSession.updateMany.mockResolvedValue({ count: 1 });

    const res = await POST(makePostRequest(VALID_POST_BODY));
    expect(res.status).toBe(200);
    expect(mockEvictDelegationRedisKeys).toHaveBeenCalledWith(USER_ID, "old-session-id");
    expect(mockPrismaDelegationSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "old-session-id" }),
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      }),
    );
  });

  it("success: returns delegationSessionId, expiresAt, entryCount", async () => {
    const before = Date.now();
    const res = await POST(makePostRequest(VALID_POST_BODY));
    const after = Date.now();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.delegationSessionId).toBe(SESSION_ID);
    // expiresAt is computed from Date.now() + ttlSeconds in the handler
    const expiresAtMs = new Date(json.expiresAt).getTime();
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + VALID_POST_BODY.ttlSeconds * 1000);
    expect(expiresAtMs).toBeLessThanOrEqual(after + VALID_POST_BODY.ttlSeconds * 1000 + 100);
    expect(json.entryCount).toBe(VALID_ENTRIES.length);
  });

  it("TTL is clamped to tenant max", async () => {
    mockPrismaTenant.findUnique.mockResolvedValue({
      delegationDefaultTtlSec: null,
      delegationMaxTtlSec: 600, // 10 minutes max
    });

    const res = await POST(
      makePostRequest({ ...VALID_POST_BODY, ttlSeconds: 3600 }), // request 1 hour
    );
    expect(res.status).toBe(200);

    // storeDelegationEntries should be called with ttlMs = 600 * 1000
    expect(mockStoreDelegationEntries).toHaveBeenCalledWith(
      USER_ID,
      SESSION_ID,
      expect.any(Array),
      600 * 1000,
    );
  });

  it("uses tenant default TTL when ttlSeconds not provided", async () => {
    mockPrismaTenant.findUnique.mockResolvedValue({
      delegationDefaultTtlSec: 450,
      delegationMaxTtlSec: 3600,
    });

    const { ttlSeconds: _omit, ...body } = VALID_POST_BODY;
    const res = await POST(makePostRequest(body));
    expect(res.status).toBe(200);
    expect(mockStoreDelegationEntries).toHaveBeenCalledWith(
      USER_ID,
      SESSION_ID,
      expect.any(Array),
      450 * 1000,
    );
  });

  it("returns 503 and rolls back DB when Redis storage fails", async () => {
    mockStoreDelegationEntries.mockRejectedValue(new Error("Redis unavailable"));
    mockPrismaDelegationSession.delete.mockResolvedValue({});

    const res = await POST(makePostRequest(VALID_POST_BODY));
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toBe("DELEGATION_STORE_FAILED");
    expect(mockPrismaDelegationSession.delete).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: SESSION_ID } }),
    );
  });

  it("creates audit logs on success", async () => {
    await POST(makePostRequest(VALID_POST_BODY));
    expect(mockLogAudit).toHaveBeenCalledTimes(2);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "DELEGATION_CREATE",
        scope: "PERSONAL",
        userId: USER_ID,
        tenantId: TENANT_ID,
        targetId: SESSION_ID,
        metadata: expect.objectContaining({
          entryCount: VALID_ENTRIES.length,
          mcpClientId: MCP_CLIENT_ID,
        }),
      }),
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "DELEGATION_CREATE",
        scope: "TENANT",
      }),
    );
  });

  it("does not create audit log when Redis storage fails", async () => {
    mockStoreDelegationEntries.mockRejectedValue(new Error("Redis unavailable"));
    mockPrismaDelegationSession.delete.mockResolvedValue({});

    await POST(makePostRequest(VALID_POST_BODY));
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});

// ─── GET Tests ───────────────────────────────────────────────────

describe("GET /api/vault/delegation", () => {
  const SESSION_RECORD = {
    id: SESSION_ID,
    mcpTokenId: MCP_TOKEN_ID,
    entryIds: [ENTRY_ID_1, ENTRY_ID_2],
    note: "test",
    expiresAt: EXPIRES_AT,
    createdAt: new Date("2099-01-01T00:00:00Z"),
    mcpAccessToken: {
      mcpClient: { name: "Test Client", clientId: MCP_CLIENT_ID },
    },
  };

  const TOKEN_RECORD = {
    id: MCP_TOKEN_ID,
    scope: "credentials:list",
    expiresAt: EXPIRES_AT,
    mcpClient: { name: "Test Client", clientId: MCP_CLIENT_ID },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: USER_ID } });
    mockResolveUserTenantId.mockResolvedValue(TENANT_ID);
    mockPrismaDelegationSession.findMany.mockResolvedValue([SESSION_RECORD]);
    mockPrismaMcpAccessToken.findMany.mockResolvedValue([TOKEN_RECORD]);
  });

  it("returns 401 when no session", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(401);
  });

  it("returns 403 when no tenant", async () => {
    mockResolveUserTenantId.mockResolvedValue(null);
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(403);
  });

  it("returns active sessions with client info", async () => {
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.sessions).toHaveLength(1);
    const s = json.sessions[0];
    expect(s.id).toBe(SESSION_ID);
    expect(s.mcpTokenId).toBe(MCP_TOKEN_ID);
    expect(s.mcpClientName).toBe("Test Client");
    expect(s.mcpClientId).toBe(MCP_CLIENT_ID);
    expect(s.entryCount).toBe(2);
    expect(s.note).toBe("test");
    expect(s.expiresAt).toBe(EXPIRES_AT.toISOString());
  });

  it("returns available tokens with hasDelegationScope flag true for credentials:list", async () => {
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.availableTokens).toHaveLength(1);
    const t = json.availableTokens[0];
    expect(t.id).toBe(MCP_TOKEN_ID);
    expect(t.hasDelegationScope).toBe(true);
    expect(t.mcpClientName).toBe("Test Client");
  });

  it("hasDelegationScope is false when token has only vault:status scope", async () => {
    mockPrismaMcpAccessToken.findMany.mockResolvedValue([
      { ...TOKEN_RECORD, scope: "vault:status" },
    ]);
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.availableTokens[0].hasDelegationScope).toBe(false);
  });

  it("hasDelegationScope is true for credentials:use scope", async () => {
    mockPrismaMcpAccessToken.findMany.mockResolvedValue([
      { ...TOKEN_RECORD, scope: "credentials:use" },
    ]);
    const res = await GET(makeGetRequest());
    const json = await res.json();
    expect(json.availableTokens[0].hasDelegationScope).toBe(true);
  });

  it("returns empty lists when no active sessions or tokens", async () => {
    mockPrismaDelegationSession.findMany.mockResolvedValue([]);
    mockPrismaMcpAccessToken.findMany.mockResolvedValue([]);
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.sessions).toHaveLength(0);
    expect(json.availableTokens).toHaveLength(0);
  });

  it("queries DB with correct userId, tenantId, and filters expired/revoked sessions", async () => {
    await GET(makeGetRequest());
    expect(mockPrismaDelegationSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: USER_ID,
          tenantId: TENANT_ID,
          revokedAt: null,
          expiresAt: expect.objectContaining({ gt: expect.any(Date) }),
        }),
      }),
    );
  });
});

// ─── DELETE Tests ────────────────────────────────────────────────

describe("DELETE /api/vault/delegation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertOrigin.mockReturnValue(null);
    mockAuth.mockResolvedValue({ user: { id: USER_ID } });
    mockResolveUserTenantId.mockResolvedValue(TENANT_ID);
    mockRevokeAllDelegationSessions.mockResolvedValue(3);
  });

  it("returns 401 when no session", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await DELETE(makeDeleteRequest());
    expect(res.status).toBe(401);
  });

  it("returns 403 when no tenant", async () => {
    mockResolveUserTenantId.mockResolvedValue(null);
    const res = await DELETE(makeDeleteRequest());
    expect(res.status).toBe(403);
  });

  it("returns revokedCount on success", async () => {
    const res = await DELETE(makeDeleteRequest());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.revokedCount).toBe(3);
  });

  it("calls revokeAllDelegationSessions with correct args", async () => {
    await DELETE(makeDeleteRequest());
    expect(mockRevokeAllDelegationSessions).toHaveBeenCalledWith(
      USER_ID,
      TENANT_ID,
      "vault_lock",
    );
  });

  it("returns revokedCount of 0 when no active sessions", async () => {
    mockRevokeAllDelegationSessions.mockResolvedValue(0);
    const res = await DELETE(makeDeleteRequest());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.revokedCount).toBe(0);
  });
});
