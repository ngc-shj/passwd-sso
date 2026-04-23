import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../../../__tests__/helpers/mock-auth";
import { createRequest, parseResponse } from "../../../../__tests__/helpers/request-builder";

const {
  mockAuth,
  mockRequireTenantPermission,
  mockWithTenantRls,
  mockLogAudit,
  mockRateLimiterCheck,
  mockMcpClientFindMany,
  mockMcpClientCount,
  mockMcpClientFindFirst,
  mockMcpClientCreate,
  mockHashToken,
  mockUserFindMany,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTenantPermission: vi.fn(),
  mockWithTenantRls: vi.fn(async (_prisma: unknown, _tenantId: unknown, fn: () => unknown) => fn()),
  mockLogAudit: vi.fn(),
  mockRateLimiterCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockMcpClientFindMany: vi.fn(),
  mockMcpClientCount: vi.fn(),
  mockMcpClientFindFirst: vi.fn(),
  mockMcpClientCreate: vi.fn(),
  mockHashToken: vi.fn((token: string) => `hashed:${token}`),
  mockUserFindMany: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/auth/tenant-auth", () => {
  class TenantAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "TenantAuthError";
      this.status = status;
    }
  }
  return {
    requireTenantPermission: mockRequireTenantPermission,
    TenantAuthError,
  };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    mcpClient: {
      findMany: mockMcpClientFindMany,
      count: mockMcpClientCount,
      findFirst: mockMcpClientFindFirst,
      create: mockMcpClientCreate,
    },
    user: {
      findMany: mockUserFindMany,
    },
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: mockWithTenantRls,
}));
vi.mock("@/lib/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "test", acceptLanguage: null }),
  tenantAuditBase: (_req: unknown, userId: string, tenantId: string) => ({
    scope: "TENANT",
    userId,
    tenantId,
    ip: "127.0.0.1",
    userAgent: "test",
    acceptLanguage: null,
  }),
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateLimiterCheck }),
}));
vi.mock("@/lib/crypto/crypto-server", () => ({
  hashToken: mockHashToken,
}));

import { GET, POST } from "@/app/api/tenant/mcp-clients/route";
import { TenantAuthError } from "@/lib/auth/tenant-auth";
import { MAX_MCP_CLIENTS_PER_TENANT } from "@/lib/constants/mcp";

const ACTOR = { tenantId: "tenant-1", role: "ADMIN" };

const makeClient = (overrides: Record<string, unknown> = {}) => ({
  id: "client-1",
  clientId: "mcpc_abc123",
  name: "my-mcp-client",
  redirectUris: ["https://example.com/callback"],
  allowedScopes: "credentials:list,credentials:use",
  isActive: true,
  isDcr: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  accessTokens: [],
  ...overrides,
});

describe("GET /api/tenant/mcp-clients", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns list of MCP clients for tenant", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockMcpClientFindMany.mockResolvedValue([
      makeClient({
        accessTokens: [{ userId: "user-1", lastUsedAt: new Date("2025-03-15T00:00:00Z") }],
      }),
    ]);
    mockUserFindMany.mockResolvedValue([
      { id: "user-1", name: "Test User", email: "test@example.com" },
    ]);

    const req = createRequest("GET", "http://localhost/api/tenant/mcp-clients");
    const res = await GET(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(Array.isArray(json.clients)).toBe(true);
    expect(json.clients).toHaveLength(1);
    expect(json.clients[0].id).toBe("client-1");
    expect(json.clients[0].clientId).toBe("mcpc_abc123");
    expect(Array.isArray(json.clients[0].connectedUsers)).toBe(true);
    expect(json.clients[0].lastUsedAt).toBe("2025-03-15T00:00:00.000Z");
  });

  it("returns lastUsedAt as null when all access tokens have null lastUsedAt", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockMcpClientFindMany.mockResolvedValue([
      makeClient({
        accessTokens: [{ userId: "user-1", lastUsedAt: null }],
      }),
    ]);

    const req = createRequest("GET", "http://localhost/api/tenant/mcp-clients");
    const res = await GET(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.clients[0].lastUsedAt).toBeNull();
  });

  it("returns 401 for unauthenticated users", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("GET", "http://localhost/api/tenant/mcp-clients");
    const res = await GET(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(401);
  });

  it("returns 403 for insufficient permission", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockRejectedValue(new TenantAuthError("FORBIDDEN", 403));

    const req = createRequest("GET", "http://localhost/api/tenant/mcp-clients");
    const res = await GET(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(403);
  });
});

describe("POST /api/tenant/mcp-clients", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a MCP client and returns clientSecret once", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockMcpClientCount.mockResolvedValue(0);
    mockMcpClientFindFirst.mockResolvedValue(null);
    const created = makeClient({ id: "client-new" });
    mockMcpClientCreate.mockResolvedValue(created);

    const req = createRequest("POST", "http://localhost/api/tenant/mcp-clients", {
      body: {
        name: "my-mcp-client",
        redirectUris: ["https://example.com/callback"],
        allowedScopes: ["credentials:list", "credentials:use"],
      },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(201);
    expect(json.client.id).toBe("client-new");
    // clientSecret is returned only on creation
    expect(typeof json.client.clientSecret).toBe("string");
    expect(json.client.clientSecret.length).toBeGreaterThan(0);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "MCP_CLIENT_CREATE",
        tenantId: "tenant-1",
      }),
    );
  });

  it("returns 409 for name conflict", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockMcpClientCount.mockResolvedValue(0);
    mockMcpClientFindFirst.mockResolvedValue(makeClient());

    const req = createRequest("POST", "http://localhost/api/tenant/mcp-clients", {
      body: {
        name: "my-mcp-client",
        redirectUris: ["https://example.com/callback"],
        allowedScopes: ["credentials:list", "credentials:use"],
      },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(409);
    expect(json.error).toBe("MCP_CLIENT_NAME_CONFLICT");
  });

  it("returns 422 when limit exceeded", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockMcpClientCount.mockResolvedValue(MAX_MCP_CLIENTS_PER_TENANT);

    const req = createRequest("POST", "http://localhost/api/tenant/mcp-clients", {
      body: {
        name: "my-mcp-client",
        redirectUris: ["https://example.com/callback"],
        allowedScopes: ["credentials:list", "credentials:use"],
      },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(422);
    expect(json.error).toBe("MCP_CLIENT_LIMIT_EXCEEDED");
  });

  it("returns 401 for unauthenticated users", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("POST", "http://localhost/api/tenant/mcp-clients", {
      body: {
        name: "my-mcp-client",
        redirectUris: ["https://example.com/callback"],
        allowedScopes: ["credentials:list", "credentials:use"],
      },
    });
    const res = await POST(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(401);
  });

  it("returns 403 for insufficient permission", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockRejectedValue(new TenantAuthError("FORBIDDEN", 403));

    const req = createRequest("POST", "http://localhost/api/tenant/mcp-clients", {
      body: {
        name: "my-mcp-client",
        redirectUris: ["https://example.com/callback"],
        allowedScopes: ["credentials:list", "credentials:use"],
      },
    });
    const res = await POST(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(403);
  });
});
