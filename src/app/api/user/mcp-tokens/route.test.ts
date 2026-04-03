import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseResponse } from "../../../../__tests__/helpers/request-builder";

const {
  mockAuth,
  mockWithBypassRls,
  mockResolveUserTenantId,
  mockRateLimiterCheck,
  mockMcpClientFindMany,
  mockMcpAccessTokenFindMany,
  mockMcpAccessTokenUpdateMany,
  mockMcpRefreshTokenFindMany,
  mockMcpRefreshTokenUpdateMany,
  mockDelegationSessionFindMany,
  mockDelegationSessionUpdateMany,
  mockAuditLogCreate,
  mockEvictDelegationRedisKeys,
  mockTransaction,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockWithBypassRls: vi.fn(async (_prisma: unknown, fn: () => unknown) => fn()),
  mockResolveUserTenantId: vi.fn(),
  mockRateLimiterCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockMcpClientFindMany: vi.fn(),
  mockMcpAccessTokenFindMany: vi.fn(),
  mockMcpAccessTokenUpdateMany: vi.fn(),
  mockMcpRefreshTokenFindMany: vi.fn(),
  mockMcpRefreshTokenUpdateMany: vi.fn(),
  mockDelegationSessionFindMany: vi.fn(),
  mockDelegationSessionUpdateMany: vi.fn(),
  mockAuditLogCreate: vi.fn(),
  mockEvictDelegationRedisKeys: vi.fn().mockResolvedValue(undefined),
  mockTransaction: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>, withBypassRls: mockWithBypassRls }));
vi.mock("@/lib/tenant-context", () => ({ resolveUserTenantId: mockResolveUserTenantId }));
vi.mock("@/lib/rate-limit", () => ({ createRateLimiter: () => ({ check: mockRateLimiterCheck }) }));
vi.mock("@/lib/delegation", () => ({ evictDelegationRedisKeys: mockEvictDelegationRedisKeys }));
vi.mock("@/lib/with-request-log", () => ({ withRequestLog: <T>(fn: T) => fn }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    mcpClient: { findMany: mockMcpClientFindMany },
    mcpAccessToken: { findMany: mockMcpAccessTokenFindMany, updateMany: mockMcpAccessTokenUpdateMany },
    mcpRefreshToken: { findMany: mockMcpRefreshTokenFindMany, updateMany: mockMcpRefreshTokenUpdateMany },
    delegationSession: { findMany: mockDelegationSessionFindMany, updateMany: mockDelegationSessionUpdateMany },
    auditLog: { create: mockAuditLogCreate },
    $transaction: mockTransaction,
  },
}));

import { GET, DELETE } from "./route";

const now = new Date("2025-01-01T00:00:00Z");

describe("GET /api/user/mcp-tokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockResolveUserTenantId.mockResolvedValue("tenant-1");
  });

  it("returns clients with new fields", async () => {
    const lastUsedAt = new Date("2025-01-01T12:00:00Z");
    const createdAt = new Date("2024-12-01T00:00:00Z");
    const expiresAt = new Date("2026-01-01T00:00:00Z");
    const tokenCreatedAt = new Date("2024-12-15T00:00:00Z");

    mockMcpClientFindMany.mockResolvedValue([
      {
        id: "client-1",
        clientId: "mcpc_abc123",
        name: "My MCP Client",
        isDcr: false,
        allowedScopes: "credentials:list credentials:use",
        createdAt,
        accessTokens: [
          {
            id: "token-1",
            scope: "credentials:list",
            createdAt: tokenCreatedAt,
            expiresAt,
            lastUsedAt,
          },
        ],
      },
    ]);

    const req = createRequest("GET", "http://localhost/api/user/mcp-tokens");
    const res = await GET(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.clients).toHaveLength(1);
    expect(json.clients[0].allowedScopes).toBe("credentials:list credentials:use");
    expect(json.clients[0].clientCreatedAt).toBe(createdAt.toISOString());
    expect(json.clients[0].connection).not.toBeNull();
    expect(json.clients[0].connection.lastUsedAt).toBe(lastUsedAt.toISOString());
    expect(json.clients[0].connection.tokenId).toBe("token-1");
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("GET", "http://localhost/api/user/mcp-tokens");
    const res = await GET(req);

    expect(res.status).toBe(401);
  });

  it("returns connection as null when no active tokens", async () => {
    mockMcpClientFindMany.mockResolvedValue([
      {
        id: "client-1",
        clientId: "mcpc_abc123",
        name: "My MCP Client",
        isDcr: false,
        allowedScopes: "credentials:list",
        createdAt: now,
        accessTokens: [],
      },
    ]);

    const req = createRequest("GET", "http://localhost/api/user/mcp-tokens");
    const res = await GET(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.clients).toHaveLength(1);
    expect(json.clients[0].connection).toBeNull();
  });
});

describe("DELETE /api/user/mcp-tokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockResolveUserTenantId.mockResolvedValue("tenant-1");
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const { prisma } = await import("@/lib/prisma");
      return fn(prisma);
    });
  });

  it("revokes all active tokens and returns count", async () => {
    mockMcpAccessTokenFindMany.mockResolvedValue([{ id: "token-1" }, { id: "token-2" }]);
    mockMcpRefreshTokenFindMany
      .mockResolvedValueOnce([
        { familyId: "family-1" },
        { familyId: "family-2" },
      ])
      .mockResolvedValueOnce([
        { accessTokenId: "token-1" },
        { accessTokenId: "token-2" },
      ]);
    mockMcpAccessTokenUpdateMany.mockResolvedValue({ count: 2 });
    mockMcpRefreshTokenUpdateMany.mockResolvedValue({ count: 2 });
    mockDelegationSessionFindMany.mockResolvedValue([
      { id: "session-1" },
      { id: "session-2" },
    ]);
    mockDelegationSessionUpdateMany.mockResolvedValue({ count: 2 });
    mockAuditLogCreate.mockResolvedValue({});

    const req = createRequest("DELETE", "http://localhost/api/user/mcp-tokens");
    const res = await DELETE(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.revokedCount).toBe(2);

    expect(mockMcpAccessTokenUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ["token-1", "token-2"] } }),
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      }),
    );

    expect(mockMcpRefreshTokenUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          familyId: { in: expect.arrayContaining(["family-1", "family-2"]) },
        }),
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      }),
    );

    expect(mockDelegationSessionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          mcpTokenId: { in: ["token-1", "token-2"] },
          userId: "user-1",
          revokedAt: null,
        }),
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      }),
    );

    // Sibling access token revocation includes userId+tenantId guard
    expect(mockMcpAccessTokenUpdateMany).toHaveBeenCalledTimes(2);

    expect(mockAuditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "MCP_CONNECTION_REVOKE_ALL",
          metadata: { revokedCount: 2 },
        }),
      }),
    );

    expect(mockEvictDelegationRedisKeys).toHaveBeenCalledTimes(2);
    expect(mockEvictDelegationRedisKeys).toHaveBeenCalledWith("user-1", "session-1");
    expect(mockEvictDelegationRedisKeys).toHaveBeenCalledWith("user-1", "session-2");
  });

  it("returns revokedCount 0 when no active tokens", async () => {
    mockMcpAccessTokenFindMany.mockResolvedValue([]);

    const req = createRequest("DELETE", "http://localhost/api/user/mcp-tokens");
    const res = await DELETE(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.revokedCount).toBe(0);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockMcpAccessTokenUpdateMany).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("DELETE", "http://localhost/api/user/mcp-tokens");
    const res = await DELETE(req);

    expect(res.status).toBe(401);
    expect(mockMcpAccessTokenFindMany).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimiterCheck.mockResolvedValue({ allowed: false, retryAfterMs: 30000 });

    const req = createRequest("DELETE", "http://localhost/api/user/mcp-tokens");
    const res = await DELETE(req);

    expect(res.status).toBe(429);
  });

  it("returns 403 when no tenant", async () => {
    mockResolveUserTenantId.mockResolvedValue(null);

    const req = createRequest("DELETE", "http://localhost/api/user/mcp-tokens");
    const res = await DELETE(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(403);
    expect(json.error).toBe("No tenant");
  });
});
