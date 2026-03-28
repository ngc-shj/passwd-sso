import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseResponse } from "../../../../__tests__/helpers/request-builder";

const {
  mockExchangeCodeForToken,
  mockHashToken,
  mockRateLimiterCheck,
} = vi.hoisted(() => ({
  mockExchangeCodeForToken: vi.fn(),
  mockHashToken: vi.fn((token: string) => `hashed:${token}`),
  mockRateLimiterCheck: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("@/lib/mcp/oauth-server", () => ({
  exchangeCodeForToken: mockExchangeCodeForToken,
}));
vi.mock("@/lib/crypto-server", () => ({
  hashToken: mockHashToken,
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateLimiterCheck }),
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

describe("POST /api/mcp/token", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns access_token on successful exchange", async () => {
    mockExchangeCodeForToken.mockResolvedValue({
      ok: true,
      data: {
        accessToken: "mcp_access_token_abc",
        tokenType: "Bearer",
        expiresIn: 3600,
        scope: "credentials:read",
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
    expect(json.scope).toBe("credentials:read");
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
});
