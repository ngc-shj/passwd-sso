/**
 * Integration-style scenario tests for the MCP OAuth 2.1 + PKCE flow.
 *
 * These tests wire together multiple layers (route handlers, oauth-server lib,
 * mcp server core) using fine-grained mocks of Prisma and Redis dependencies,
 * so they exercise the full parameter-passing chain without touching the DB.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseResponse } from "../helpers/request-builder";
import { DEFAULT_SESSION } from "../helpers/mock-auth";

// ─── Hoisted mocks ────────────────────────────────────────────

const {
  // auth / tenant
  mockAuth,
  mockRequireTenantPermission,
  mockWithBypassRls,
  mockLogAudit,
  // Prisma method stubs (filled per test)
  mockMcpClientFindMany,
  mockMcpClientCount,
  mockMcpClientFindFirst,
  mockMcpClientCreate,
  mockMcpAuthCodeCreate,
  mockMcpAuthCodeFindUnique,
  mockMcpAuthCodeUpdate,
  mockMcpAccessTokenCreate,
  mockMcpAccessTokenFindUnique,
  // delegation
  mockFindActiveDelegationSession,
  mockFetchDelegationEntry,
  mockGetDelegatedEntryIdsForSession,
  // crypto / rate-limit
  mockHashToken,
  mockRateLimiterCheck,
  mockPrismaTransaction,
} = vi.hoisted(() => {
  const mockPrismaTransaction = vi.fn(async (fn: (tx: unknown) => unknown) =>
    fn({
      mcpAuthorizationCode: {
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      mcpAccessToken: {
        create: vi.fn(),
      },
    }),
  );

  return {
    mockAuth: vi.fn(),
    mockRequireTenantPermission: vi.fn(),
    mockWithBypassRls: vi.fn(async (_p: unknown, fn: () => unknown) => fn()),
    mockLogAudit: vi.fn(),
    mockMcpClientFindMany: vi.fn(),
    mockMcpClientCount: vi.fn(),
    mockMcpClientFindFirst: vi.fn(),
    mockMcpClientCreate: vi.fn(),
    mockMcpAuthCodeCreate: vi.fn(),
    mockMcpAuthCodeFindUnique: vi.fn(),
    mockMcpAuthCodeUpdate: vi.fn(),
    mockMcpAccessTokenCreate: vi.fn(),
    mockMcpAccessTokenFindUnique: vi.fn(),
    mockFindActiveDelegationSession: vi.fn().mockResolvedValue(null),
    mockFetchDelegationEntry: vi.fn().mockResolvedValue(null),
    mockGetDelegatedEntryIdsForSession: vi.fn().mockResolvedValue(new Set()),
    mockHashToken: vi.fn((token: string) => `hashed:${token}`),
    mockRateLimiterCheck: vi.fn().mockResolvedValue({ allowed: true }),
    mockPrismaTransaction,
  };
});

// ─── Module mocks ─────────────────────────────────────────────

vi.mock("@/auth", () => ({ auth: mockAuth }));

vi.mock("@/lib/tenant-auth", () => {
  class TenantAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "TenantAuthError";
      this.status = status;
    }
  }
  return { requireTenantPermission: mockRequireTenantPermission, TenantAuthError };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mockPrismaTransaction,
    mcpClient: {
      findMany: mockMcpClientFindMany,
      count: mockMcpClientCount,
      findFirst: mockMcpClientFindFirst,
      create: mockMcpClientCreate,
    },
    mcpAuthorizationCode: {
      create: mockMcpAuthCodeCreate,
      findUnique: mockMcpAuthCodeFindUnique,
      update: mockMcpAuthCodeUpdate,
    },
    mcpAccessToken: {
      create: mockMcpAccessTokenCreate,
      findUnique: mockMcpAccessTokenFindUnique,
    },
    mcpRefreshToken: {
      create: vi.fn().mockResolvedValue({}),
    },
    delegationSession: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
  withTenantRls: vi.fn(async (_prisma: unknown, _tenantId: unknown, fn: () => unknown) => fn()),
}));

vi.mock("@/lib/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "test", acceptLanguage: null }),
}));

vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateLimiterCheck }),
}));

vi.mock("@/lib/crypto-server", () => ({
  hashToken: mockHashToken,
}));

vi.mock("@/lib/delegation", () => ({
  findActiveDelegationSession: mockFindActiveDelegationSession,
  fetchDelegationEntry: mockFetchDelegationEntry,
  getDelegatedEntryIdsForSession: mockGetDelegatedEntryIdsForSession,
}));

// ─── Imports (after mocks) ────────────────────────────────────

import { computeS256Challenge } from "@/lib/mcp/oauth-server";
import { GET as getClients, POST as postClients } from "@/app/api/tenant/mcp-clients/route";
import { POST as postToken } from "@/app/api/mcp/token/route";

import { GET as getDiscovery } from "@/app/api/mcp/.well-known/oauth-authorization-server/route";
import { handleMcpRequest } from "@/lib/mcp/server";
import { MCP_SCOPE, type McpScope } from "@/lib/constants/mcp";

// ─── Shared fixtures ──────────────────────────────────────────

const ACTOR = { tenantId: "tenant-1", role: "ADMIN" };

const makeClient = (overrides: Record<string, unknown> = {}) => ({
  id: "client-uuid-1",
  clientId: "mcpc_abc123def456",
  name: "test-mcp-client",
  redirectUris: ["https://example.com/callback"],
  allowedScopes: "credentials:list,credentials:use",
  isActive: true,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  accessTokens: [],
  ...overrides,
});

const makeTokenData = (overrides: Partial<{
  tokenId: string;
  tenantId: string;
  clientId: string;
  mcpClientId: string;
  userId: string | null;
  serviceAccountId: string | null;
  scopes: McpScope[];
}> = {}) => ({
  tokenId: "token-id",
  tenantId: "tenant-1",
  clientId: "client-uuid-1",
  mcpClientId: "mcpc_testclient1",
  userId: "user-uuid-1",
  serviceAccountId: null,
  scopes: [MCP_SCOPE.CREDENTIALS_LIST, MCP_SCOPE.CREDENTIALS_USE] as McpScope[],
  ...overrides,
});

// ─── Scenario 1: MCP Client Registration ─────────────────────

describe("Scenario 1: MCP Client Registration", () => {
  beforeEach(() => vi.clearAllMocks());

  it("POST /api/tenant/mcp-clients returns clientId and clientSecret on creation", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockMcpClientCount.mockResolvedValue(0);
    mockMcpClientFindFirst.mockResolvedValue(null);
    mockMcpClientCreate.mockResolvedValue(makeClient());

    const req = createRequest("POST", "http://localhost/api/tenant/mcp-clients", {
      body: {
        name: "test-mcp-client",
        redirectUris: ["https://example.com/callback"],
        allowedScopes: ["credentials:list", "credentials:use"],
      },
    });
    const res = await postClients(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(201);
    expect(json.client.id).toBe("client-uuid-1");
    expect(json.client.clientId).toMatch(/^mcpc_/);
    // clientSecret present only at creation time
    expect(typeof json.client.clientSecret).toBe("string");
    expect(json.client.clientSecret.length).toBeGreaterThan(0);
  });

  it("GET /api/tenant/mcp-clients lists clients without clientSecret", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockMcpClientFindMany.mockResolvedValue([makeClient()]);

    const req = createRequest("GET", "http://localhost/api/tenant/mcp-clients");
    const res = await getClients(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(Array.isArray(json.clients)).toBe(true);
    expect(json.clients).toHaveLength(1);
    expect(json.clients[0].clientId).toBe("mcpc_abc123def456");
    // clientSecret must not be present in list response
    expect("clientSecret" in json.clients[0]).toBe(false);
    expect(json.clients[0].clientSecretHash).toBeUndefined();
  });
});

// ─── Scenario 2: PKCE Challenge Computation ───────────────────

describe("Scenario 2: OAuth Authorization Code + PKCE - challenge computation", () => {
  it("computeS256Challenge matches the RFC 7636 test vector", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = computeS256Challenge(verifier);
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("challenge is base64url (no + / = characters)", () => {
    const verifier = "random-verifier-string-at-least-43-chars-long-xyz";
    const challenge = computeS256Challenge(verifier);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("different verifiers produce different challenges", () => {
    const c1 = computeS256Challenge("verifier-one");
    const c2 = computeS256Challenge("verifier-two");
    expect(c1).not.toBe(c2);
  });

  it("same verifier always produces the same challenge (deterministic)", () => {
    const v = "stable-verifier-string";
    expect(computeS256Challenge(v)).toBe(computeS256Challenge(v));
  });
});

// ─── Scenario 3: PKCE Token Exchange Success (route-level) ───

describe("Scenario 3: PKCE Token Exchange Success via /api/mcp/token", () => {
  beforeEach(() => vi.clearAllMocks());

  it("full params are forwarded to exchangeCodeForToken and access_token is returned", async () => {
    const verifier = "correct-verifier-for-scenario-3-test-case";
    const challenge = computeS256Challenge(verifier);

    // Wire up the $transaction mock to run through the real PKCE path
    mockPrismaTransaction.mockImplementation(async (fn) => {
      const tx = {
        mcpAuthorizationCode: {
          findUnique: vi.fn().mockResolvedValue({
            id: "auth-code-id",
            usedAt: null,
            expiresAt: new Date(Date.now() + 60_000),
            mcpClient: {
              clientId: "mcpc_testclient",
              clientSecretHash: "hashed:secret-value",
              isActive: true,
              tenantId: "tenant-1",
            },
            clientId: "client-uuid-1",
            tenantId: "tenant-1",
            userId: "user-uuid-1",
            serviceAccountId: null,
            redirectUri: "https://example.com/callback",
            codeChallenge: challenge,
            codeChallengeMethod: "S256",
            scope: "credentials:list,credentials:use",
          }),
          update: vi.fn().mockResolvedValue({}),
        },
        mcpAccessToken: {
          create: vi.fn().mockResolvedValue({ id: "new-token-id" }),
        },
      };
      return fn(tx);
    });

    const req = createRequest("POST", "http://localhost/api/mcp/token", {
      body: {
        grant_type: "authorization_code",
        code: "test-auth-code",
        redirect_uri: "https://example.com/callback",
        client_id: "mcpc_testclient",
        client_secret: "secret-value",
        code_verifier: verifier,
      },
    });
    const res = await postToken(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.access_token).toMatch(/^mcp_/);
    expect(json.token_type).toBe("Bearer");
    expect(json.expires_in).toBeGreaterThan(0);
    expect(json.scope).toBe("credentials:list credentials:use");
  });
});

// ─── Scenario 4: PKCE Failure Paths (route-level) ────────────

describe("Scenario 4: PKCE Failure Paths via POST /api/mcp/token", () => {
  beforeEach(() => vi.clearAllMocks());

  const VALID_BODY = {
    grant_type: "authorization_code",
    code: "some-code",
    redirect_uri: "https://example.com/callback",
    client_id: "mcpc_testclient",
    client_secret: "secret-value",
    code_verifier: "some-verifier",
  };

  it("wrong code_verifier → 400 invalid_grant", async () => {
    const correctVerifier = "correct-verifier-abc123";
    const challenge = computeS256Challenge(correctVerifier);

    mockPrismaTransaction.mockImplementation(async (fn) => {
      const tx = {
        mcpAuthorizationCode: {
          findUnique: vi.fn().mockResolvedValue({
            id: "code-id",
            usedAt: null,
            expiresAt: new Date(Date.now() + 60_000),
            mcpClient: {
              clientId: "mcpc_testclient",
              clientSecretHash: "hashed:secret-value",
              isActive: true,
              tenantId: "tenant-1",
            },
            clientId: "client-uuid-1",
            tenantId: "tenant-1",
            userId: "user-uuid-1",
            serviceAccountId: null,
            redirectUri: "https://example.com/callback",
            codeChallenge: challenge,
            codeChallengeMethod: "S256",
            scope: "credentials:list,credentials:use",
          }),
          update: vi.fn(),
        },
        mcpAccessToken: { create: vi.fn() },
      };
      return fn(tx);
    });

    const req = createRequest("POST", "http://localhost/api/mcp/token", {
      body: { ...VALID_BODY, code_verifier: "wrong-verifier" },
    });
    const res = await postToken(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("invalid_grant");
  });

  it("code already used (usedAt non-null) → 400 invalid_grant", async () => {
    mockPrismaTransaction.mockImplementation(async (fn) => {
      const tx = {
        mcpAuthorizationCode: {
          findUnique: vi.fn().mockResolvedValue({
            id: "code-id",
            usedAt: new Date(),
            expiresAt: new Date(Date.now() + 60_000),
            mcpClient: {
              clientId: "mcpc_testclient",
              clientSecretHash: "hashed:secret-value",
              isActive: true,
              tenantId: "tenant-1",
            },
            clientId: "client-uuid-1",
            tenantId: "tenant-1",
            userId: "user-uuid-1",
            serviceAccountId: null,
            redirectUri: "https://example.com/callback",
            codeChallenge: "any-challenge",
            codeChallengeMethod: "S256",
            scope: "credentials:list,credentials:use",
          }),
          update: vi.fn(),
        },
        mcpAccessToken: { create: vi.fn() },
      };
      return fn(tx);
    });

    const req = createRequest("POST", "http://localhost/api/mcp/token", {
      body: VALID_BODY,
    });
    const res = await postToken(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("invalid_grant");
  });

  it("code expired → 400 invalid_grant", async () => {
    mockPrismaTransaction.mockImplementation(async (fn) => {
      const tx = {
        mcpAuthorizationCode: {
          findUnique: vi.fn().mockResolvedValue({
            id: "code-id",
            usedAt: null,
            expiresAt: new Date(Date.now() - 1_000), // past
            mcpClient: {
              clientId: "mcpc_testclient",
              clientSecretHash: "hashed:secret-value",
              isActive: true,
              tenantId: "tenant-1",
            },
            clientId: "client-uuid-1",
            tenantId: "tenant-1",
            userId: "user-uuid-1",
            serviceAccountId: null,
            redirectUri: "https://example.com/callback",
            codeChallenge: "any-challenge",
            codeChallengeMethod: "S256",
            scope: "credentials:list,credentials:use",
          }),
          update: vi.fn(),
        },
        mcpAccessToken: { create: vi.fn() },
      };
      return fn(tx);
    });

    const req = createRequest("POST", "http://localhost/api/mcp/token", {
      body: VALID_BODY,
    });
    const res = await postToken(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("invalid_grant");
  });

  it("wrong client_secret → 400 invalid_client", async () => {
    const correctVerifier = "correct-verifier-for-secret-test";
    const challenge = computeS256Challenge(correctVerifier);

    mockPrismaTransaction.mockImplementation(async (fn) => {
      const tx = {
        mcpAuthorizationCode: {
          findUnique: vi.fn().mockResolvedValue({
            id: "code-id",
            usedAt: null,
            expiresAt: new Date(Date.now() + 60_000),
            mcpClient: {
              clientId: "mcpc_testclient",
              clientSecretHash: "hashed:correct-secret",
              isActive: true,
              tenantId: "tenant-1",
            },
            clientId: "client-uuid-1",
            tenantId: "tenant-1",
            userId: "user-uuid-1",
            serviceAccountId: null,
            redirectUri: "https://example.com/callback",
            codeChallenge: challenge,
            codeChallengeMethod: "S256",
            scope: "credentials:list,credentials:use",
          }),
          update: vi.fn(),
        },
        mcpAccessToken: { create: vi.fn() },
      };
      return fn(tx);
    });

    const req = createRequest("POST", "http://localhost/api/mcp/token", {
      body: {
        ...VALID_BODY,
        client_secret: "wrong-secret",
        code_verifier: correctVerifier,
      },
    });
    const res = await postToken(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("invalid_client");
  });

  it("wrong redirect_uri → 400 invalid_grant", async () => {
    const verifier = "correct-verifier-for-redirect-test-scenario";
    const challenge = computeS256Challenge(verifier);

    mockPrismaTransaction.mockImplementation(async (fn) => {
      const tx = {
        mcpAuthorizationCode: {
          findUnique: vi.fn().mockResolvedValue({
            id: "code-id",
            usedAt: null,
            expiresAt: new Date(Date.now() + 60_000),
            mcpClient: {
              clientId: "mcpc_testclient",
              clientSecretHash: "hashed:secret-value",
              isActive: true,
              tenantId: "tenant-1",
            },
            clientId: "client-uuid-1",
            tenantId: "tenant-1",
            userId: "user-uuid-1",
            serviceAccountId: null,
            redirectUri: "https://example.com/callback", // stored URI
            codeChallenge: challenge,
            codeChallengeMethod: "S256",
            scope: "credentials:list,credentials:use",
          }),
          update: vi.fn(),
        },
        mcpAccessToken: { create: vi.fn() },
      };
      return fn(tx);
    });

    const req = createRequest("POST", "http://localhost/api/mcp/token", {
      body: {
        ...VALID_BODY,
        redirect_uri: "https://attacker.example.com/callback", // different URI
        code_verifier: verifier,
      },
    });
    const res = await postToken(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("invalid_grant");
  });

  it("missing required params → 400 invalid_request", async () => {
    const req = createRequest("POST", "http://localhost/api/mcp/token", {
      body: { grant_type: "authorization_code" },
    });
    const res = await postToken(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("invalid_request");
  });
});

// ─── Scenario 5: MCP Tool Call with Scope Check ───────────────

describe("Scenario 5: MCP Tool Call with Scope Check via handleMcpRequest", () => {
  beforeEach(() => vi.clearAllMocks());

  it("list_credentials with credentials:list scope → -32603 when no active delegation session", async () => {
    // delegationSession.findFirst is mocked to return null (no active session)
    // so list_credentials errors with "No active delegation session"
    const token = makeTokenData({ scopes: [MCP_SCOPE.CREDENTIALS_LIST] });

    const response = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_credentials", arguments: {} },
      },
      token,
    );

    expect("error" in response).toBe(true);
    if ("error" in response) {
      expect(response.error.code).toBe(-32603);
      expect(response.error.message).toContain("delegation");
    }
  });

  it("unknown tool → -32601", async () => {
    const token = makeTokenData({ scopes: [MCP_SCOPE.CREDENTIALS_LIST] });

    const response = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get_credential", arguments: {} },
      },
      token,
    );

    expect("error" in response).toBe(true);
    if ("error" in response) {
      expect(response.error.code).toBe(-32601);
    }
  });

  it("list_credentials without credentials:list scope → -32003 insufficient scope", async () => {
    const token = makeTokenData({ scopes: [MCP_SCOPE.VAULT_STATUS] });

    const response = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "list_credentials", arguments: {} },
      },
      token,
    );

    expect("error" in response).toBe(true);
    if ("error" in response) {
      expect(response.error.code).toBe(-32003);
      expect(response.error.message).toContain("Insufficient scope");
      expect(response.error.message).toContain("credentials:list");
    }
  });

  it("list_credentials returns metadata-only entries when delegation session is active", async () => {
    const entryId = "d4e5f6a7-b8c9-4d0e-1f2a-3b4c5d6e7f80";
    // Metadata-only fixture — no password/notes/url
    const mockEntry = {
      id: entryId,
      title: "AWS",
      username: "admin",
      urlHost: "aws.amazon.com",
      tags: null,
    };

    mockFindActiveDelegationSession.mockResolvedValueOnce({
      id: "deleg-session-2",
      expiresAt: new Date(Date.now() + 60_000),
    });
    mockGetDelegatedEntryIdsForSession.mockResolvedValueOnce(new Set([entryId]));
    mockFetchDelegationEntry.mockResolvedValueOnce(mockEntry);

    const token = makeTokenData({ scopes: [MCP_SCOPE.CREDENTIALS_LIST] });

    const response = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "list_credentials",
          arguments: {},
        },
      },
      token,
    );

    expect("result" in response).toBe(true);
    if ("result" in response) {
      const content = response.result as { content: { type: string; text: string }[] };
      const parsed = JSON.parse(content.content[0].text);
      expect(parsed.entries).toHaveLength(1);
      expect(parsed.total).toBe(1);
      // Verify metadata-only: no secret fields
      expect(parsed.entries[0]).not.toHaveProperty("password");
      expect(parsed.entries[0]).not.toHaveProperty("notes");
      expect(parsed.entries[0]).not.toHaveProperty("url");
    }
  });
});

// ─── Scenario 6: MCP Rate Limiting ───────────────────────────

describe("Scenario 6: MCP Rate Limiting via POST /api/mcp route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns -32029 when MCP rate limit is exceeded", async () => {
    // Simulate valid token validation but rate limit hit inside handleMcpRequest
    const tokenData = makeTokenData();

    // Rate limiter returns not-allowed for the MCP dispatcher
    mockRateLimiterCheck.mockResolvedValue({ allowed: false, retryAfterMs: 60_000 });

    const response = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      },
      tokenData,
    );

    expect("error" in response).toBe(true);
    if ("error" in response) {
      expect(response.error.code).toBe(-32029);
      expect(response.error.message).toBe("Rate limit exceeded");
    }
  });
});

// ─── Scenario 7: OAuth Discovery ─────────────────────────────

describe("Scenario 7: OAuth Discovery endpoint", () => {
  it("GET /api/mcp/.well-known/oauth-authorization-server returns correct metadata", async () => {
    const res = await getDiscovery();
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.authorization_endpoint).toMatch(/\/api\/mcp\/authorize$/);
    expect(json.token_endpoint).toMatch(/\/api\/mcp\/token$/);
    expect(Array.isArray(json.code_challenge_methods_supported)).toBe(true);
    expect(json.code_challenge_methods_supported).toContain("S256");
  });

  it("discovery issuer matches APP_URL", async () => {
    const prev = process.env.APP_URL;
    process.env.APP_URL = "https://sso.example.com";
    try {
      const res = await getDiscovery();
      const { status, json } = await parseResponse(res);

      expect(status).toBe(200);
      expect(json.issuer).toBe("https://sso.example.com");
      expect(json.authorization_endpoint).toBe("https://sso.example.com/api/mcp/authorize");
      expect(json.token_endpoint).toBe("https://sso.example.com/api/mcp/token");
      expect(json.registration_endpoint).toBe("https://sso.example.com/api/mcp/register");
    } finally {
      if (prev === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = prev;
    }
  });

  it("response_types_supported includes 'code' only", async () => {
    const res = await getDiscovery();
    const { json } = await parseResponse(res);

    expect(json.response_types_supported).toEqual(["code"]);
    expect(json.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
  });
});
