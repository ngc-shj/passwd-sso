import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseResponse } from "../../../../__tests__/helpers/request-builder";

const {
  mockExchangeCodeForToken,
  mockCreateRefreshToken,
  mockExchangeRefreshToken,
  mockHashToken,
  mockRateLimiterCheck,
  mockLogAudit,
} = vi.hoisted(() => ({
  mockExchangeCodeForToken: vi.fn(),
  mockCreateRefreshToken: vi.fn().mockResolvedValue({ refreshToken: "mcp_rt_refreshtoken", expiresAt: new Date() }),
  mockExchangeRefreshToken: vi.fn(),
  mockHashToken: vi.fn((token: string) => `hashed:${token}`),
  mockRateLimiterCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockLogAudit: vi.fn(),
}));

vi.mock("@/lib/mcp/oauth-server", () => ({
  exchangeCodeForToken: mockExchangeCodeForToken,
  createRefreshToken: mockCreateRefreshToken,
  exchangeRefreshToken: mockExchangeRefreshToken,
}));
vi.mock("@/lib/crypto-server", () => ({
  hashToken: mockHashToken,
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateLimiterCheck }),
}));
vi.mock("@/lib/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: vi.fn().mockReturnValue({ ip: "127.0.0.1", userAgent: "test-agent" }),
}));

import { POST } from "@/app/api/mcp/token/route";

const VALID_BODY = {
  grant_type: "authorization_code",
  code: "test-code-abc",
  redirect_uri: "https://example.com/callback",
  client_id: "mcpc_testclient",
  client_secret: "secret-value",
  code_verifier: "my-code-verifier",
};

const VALID_REFRESH_BODY = {
  grant_type: "refresh_token",
  refresh_token: "mcpr_test123",
  client_id: "mcpc_abc",
  client_secret: "secret123",
};

describe("POST /api/mcp/token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
  });

  it("returns access_token on successful exchange", async () => {
    mockExchangeCodeForToken.mockResolvedValue({
      ok: true,
      data: {
        accessToken: "mcp_access_token_abc",
        tokenType: "Bearer",
        expiresIn: 3600,
        scope: "credentials:list,credentials:use,vault:status",
        tokenId: "token-id-123",
        clientDbId: "client-uuid-123",
        tenantId: "tenant-uuid-123",
        userId: "user-uuid-123",
        serviceAccountId: null,
      },
    });

    const req = createRequest("POST", "http://localhost/api/mcp/token", {
      body: VALID_BODY,
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.access_token).toBe("mcp_access_token_abc");
    expect(json.token_type).toBe("Bearer");
    expect(json.expires_in).toBe(3600);
    expect(json.scope).toBe("credentials:list credentials:use vault:status");
    expect(json.refresh_token).toBe("mcp_rt_refreshtoken");
    expect(mockHashToken).toHaveBeenCalledWith("secret-value");
    expect(mockExchangeCodeForToken).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "test-code-abc",
        clientId: "mcpc_testclient",
        clientSecretHash: "hashed:secret-value",
        redirectUri: "https://example.com/callback",
        codeVerifier: "my-code-verifier",
      }),
    );
    expect(mockCreateRefreshToken).toHaveBeenCalledWith(
      expect.objectContaining({
        accessTokenId: "token-id-123",
        clientId: "client-uuid-123",
        tenantId: "tenant-uuid-123",
      }),
    );
  });

  it("returns 400 for invalid grant_type", async () => {
    const req = createRequest("POST", "http://localhost/api/mcp/token", {
      body: { ...VALID_BODY, grant_type: "client_credentials" },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("unsupported_grant_type");
  });

  it("returns 400 when required params are missing", async () => {
    const req = createRequest("POST", "http://localhost/api/mcp/token", {
      body: { grant_type: "authorization_code" },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("invalid_request");
  });

  it("returns 400 when exchange fails with invalid_grant", async () => {
    mockExchangeCodeForToken.mockResolvedValue({
      ok: false,
      error: "invalid_grant",
    });

    const req = createRequest("POST", "http://localhost/api/mcp/token", {
      body: VALID_BODY,
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("invalid_grant");
  });

  it("returns 400 when exchange fails with invalid_client", async () => {
    mockExchangeCodeForToken.mockResolvedValue({
      ok: false,
      error: "invalid_client",
    });

    const req = createRequest("POST", "http://localhost/api/mcp/token", {
      body: VALID_BODY,
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("invalid_client");
  });

  it("returns 429 when rate limit is exceeded", async () => {
    mockRateLimiterCheck.mockResolvedValue({ allowed: false, retryAfterMs: 30000 });

    const req = createRequest("POST", "http://localhost/api/mcp/token", {
      body: VALID_BODY,
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(429);
    expect(json.error).toBe("slow_down");
  });

  // ─── refresh_token grant tests ────────────────────────────────

  it("refresh_token: returns new access_token and refresh_token on success", async () => {
    mockExchangeRefreshToken.mockResolvedValue({
      ok: true,
      accessToken: "mcp_new",
      refreshToken: "mcpr_new",
      expiresIn: 3600,
      scope: "credentials:list,credentials:use",
      tenantId: "t1",
      userId: "u1",
    });

    const req = createRequest("POST", "http://localhost/api/mcp/token", {
      body: VALID_REFRESH_BODY,
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.access_token).toBe("mcp_new");
    expect(json.refresh_token).toBe("mcpr_new");
    expect(json.token_type).toBe("Bearer");
    expect(json.expires_in).toBe(3600);
    expect(json.scope).toBe("credentials:list credentials:use");
  });

  it("refresh_token: returns 400 when exchangeRefreshToken returns invalid_grant", async () => {
    mockExchangeRefreshToken.mockResolvedValue({ ok: false, error: "invalid_grant" });

    const req = createRequest("POST", "http://localhost/api/mcp/token", {
      body: VALID_REFRESH_BODY,
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("invalid_grant");
  });

  it("refresh_token: returns 401 when exchangeRefreshToken returns invalid_client", async () => {
    mockExchangeRefreshToken.mockResolvedValue({ ok: false, error: "invalid_client" });

    const req = createRequest("POST", "http://localhost/api/mcp/token", {
      body: VALID_REFRESH_BODY,
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(401);
    expect(json.error).toBe("invalid_client");
  });

  it("refresh_token: returns 400 when refresh_token field is missing", async () => {
    const { refresh_token: _removed, ...body } = VALID_REFRESH_BODY;

    const req = createRequest("POST", "http://localhost/api/mcp/token", {
      body,
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("invalid_request");
  });

  it("refresh_token: returns 429 when IP rate limit is exceeded", async () => {
    mockRateLimiterCheck.mockResolvedValue({ allowed: false, retryAfterMs: 30000 });

    const req = createRequest("POST", "http://localhost/api/mcp/token", {
      body: VALID_REFRESH_BODY,
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(429);
    expect(json.error).toBe("slow_down");
  });

  // T-13: replay detection audit log
  it("refresh_token: logs MCP_REFRESH_TOKEN_REPLAY audit on replay detection", async () => {
    mockExchangeRefreshToken.mockResolvedValue({
      ok: false,
      error: "invalid_grant",
      reason: "replay",
      tenantId: "tenant-replay",
      familyId: "family-001",
    });
    const req = createRequest("POST", "http://localhost/api/mcp/token", {
      body: VALID_REFRESH_BODY,
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("invalid_grant");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "MCP_REFRESH_TOKEN_REPLAY",
        tenantId: "tenant-replay",
        metadata: expect.objectContaining({ familyId: "family-001" }),
      }),
    );
  });

  // T-15: public client token exchange without client_secret
  it("authorization_code: succeeds without client_secret for public clients", async () => {
    mockExchangeCodeForToken.mockResolvedValue({
      ok: true,
      data: {
        accessToken: "mcp_public_access_token",
        tokenType: "Bearer",
        expiresIn: 3600,
        scope: "vault:status",
        tokenId: "token-id-public",
        clientDbId: "client-uuid-public",
        tenantId: "tenant-uuid-public",
        userId: "user-uuid-public",
        serviceAccountId: null,
      },
    });

    // Public client: no client_secret in request
    const { client_secret: _removed, ...publicBody } = VALID_BODY;

    const req = createRequest("POST", "http://localhost/api/mcp/token", {
      body: publicBody,
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.access_token).toBeDefined();
    expect(json.refresh_token).toBeDefined();
  });
});
