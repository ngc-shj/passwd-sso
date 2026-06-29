import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseResponse } from "../../../../__tests__/helpers/request-builder";

const {
  mockExchangeCodeForToken,
  mockCreateRefreshToken,
  mockExchangeRefreshToken,
  mockHashToken,
  mockRateLimiterCheck,
  mockLogAudit,
  mockMcpRefreshTokenFindUnique,
  mockWithBypassRls,
  mockDerivePasskeyState,
  mockRecordPasskeyAuditEmit,
} = vi.hoisted(() => ({
  mockExchangeCodeForToken: vi.fn(),
  mockCreateRefreshToken: vi.fn().mockResolvedValue({ refreshToken: "mcp_rt_refreshtoken", expiresAt: new Date() }),
  mockExchangeRefreshToken: vi.fn(),
  mockHashToken: vi.fn((token: string) => `hashed:${token}`),
  mockRateLimiterCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockLogAudit: vi.fn(),
  // C8: McpRefreshToken pre-read mock
  mockMcpRefreshTokenFindUnique: vi.fn(),
  // C8: withBypassRls — passes tx (first arg = prisma) through to fn
  mockWithBypassRls: vi.fn(async (p: unknown, fn: (tx: unknown) => unknown) => fn(p)),
  // C8: passkey enforcement mocks
  mockDerivePasskeyState: vi.fn().mockResolvedValue({
    requirePasskey: false,
    hasPasskey: false,
    requirePasskeyEnabledAt: null,
    passkeyGracePeriodDays: null,
  }),
  mockRecordPasskeyAuditEmit: vi.fn().mockReturnValue(true),
}));

vi.mock("@/lib/mcp/oauth-server", () => ({
  exchangeCodeForToken: mockExchangeCodeForToken,
  createRefreshToken: mockCreateRefreshToken,
  exchangeRefreshToken: mockExchangeRefreshToken,
}));
vi.mock("@/lib/crypto/crypto-server", () => ({
  hashToken: mockHashToken,
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateLimiterCheck }),
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: vi.fn().mockReturnValue({ ip: "127.0.0.1", userAgent: "test-agent" }),
  personalAuditBase: vi.fn((_, userId) => ({ scope: "PERSONAL", userId, ip: "127.0.0.1", userAgent: "test-agent" })),
  tenantAuditBase: vi.fn((_, userId, tenantId) => ({ scope: "TENANT", userId, tenantId, ip: "127.0.0.1", userAgent: "test-agent" })),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    mcpRefreshToken: { findUnique: mockMcpRefreshTokenFindUnique },
  },
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  withBypassRls: mockWithBypassRls,
}));

vi.mock("@/lib/auth/policy/passkey-enforcement", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  derivePasskeyState: mockDerivePasskeyState,
  recordPasskeyAuditEmit: mockRecordPasskeyAuditEmit,
}));

import { POST } from "@/app/api/mcp/token/route";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";

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

const USER_ID = "33333333-3333-3333-3333-333333333333";
const TENANT_ID = "44444444-4444-4444-4444-444444444444";

describe("POST /api/mcp/token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
    // Default: withBypassRls passes the prisma object with mcpRefreshToken mock
    mockWithBypassRls.mockImplementation(async (p: unknown, fn: (tx: unknown) => unknown) => {
      // Provide a tx that has mcpRefreshToken.findUnique + webAuthnCredential.count + tenant.findUnique
      const tx = {
        ...(p as object),
        mcpRefreshToken: { findUnique: mockMcpRefreshTokenFindUnique },
        webAuthnCredential: { count: vi.fn().mockResolvedValue(0) },
        tenant: {
          findUnique: vi.fn().mockResolvedValue({
            requirePasskey: false,
            requirePasskeyEnabledAt: null,
            passkeyGracePeriodDays: null,
          }),
        },
      };
      return fn(tx);
    });
    // Default McpRefreshToken row (user-bound, enforcement off)
    mockMcpRefreshTokenFindUnique.mockResolvedValue({
      userId: USER_ID,
      tenantId: TENANT_ID,
    });
    // Default passkey state: enforcement off → rotate normally
    mockDerivePasskeyState.mockResolvedValue({
      requirePasskey: false,
      hasPasskey: false,
      requirePasskeyEnabledAt: null,
      passkeyGracePeriodDays: null,
    });
    mockRecordPasskeyAuditEmit.mockReturnValue(true);
    mockLogAudit.mockResolvedValue(undefined);
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
    expect(res.headers.get("Cache-Control")).toBe("no-store");
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

  it("rejects an oversized urlencoded form body with no Content-Length (chunked-TE bypass guard)", async () => {
    // If the streaming cap did NOT fire, this body parses into a complete,
    // valid authorization_code grant and would reach exchangeCodeForToken —
    // so `not.toHaveBeenCalled()` can only hold when the cap aborts the read.
    // (Guards against a vacuous pass via the missing-required-fields branch.)
    mockExchangeCodeForToken.mockResolvedValue({
      ok: true,
      data: {
        accessToken: "mcp_access_token_should_not_be_issued",
        tokenType: "Bearer",
        expiresIn: 3600,
        scope: "credentials:list",
        tokenId: "token-id",
        clientDbId: "client-uuid",
        tenantId: "tenant-uuid",
        userId: "user-uuid",
        serviceAccountId: null,
      },
    });
    const { NextRequest } = await import("next/server");
    // 2 MB urlencoded body, streamed with NO Content-Length header — the
    // streaming cap must abort the read and reject before parsing. The grant
    // params come FIRST so the body is structurally complete up front; only the
    // trailing padding pushes it over the cap.
    const oversized =
      "grant_type=authorization_code" +
      "&code=test-code-abc" +
      "&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback" +
      "&client_id=mcpc_testclient" +
      "&client_secret=secret-value" +
      "&code_verifier=my-code-verifier" +
      "&padding=" + "x".repeat(2_000_000);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(oversized));
        controller.close();
      },
    });
    const req = new NextRequest("http://localhost/api/mcp/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: stream,
      duplex: "half",
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("invalid_request");
    // The cap must have aborted the read before the grant was exchanged.
    expect(mockExchangeCodeForToken).not.toHaveBeenCalled();
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
      accessTokenId: "at_1",
      refreshToken: "mcpr_new",
      refreshTokenId: "rt_1",
      familyId: "fam_1",
      expiresIn: 3600,
      scope: "credentials:list,credentials:use",
      tenantId: "t1",
      userId: "u1",
      serviceAccountId: null,
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
    expect(res.headers.get("Cache-Control")).toBe("no-store");
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
        userId: SYSTEM_ACTOR_ID,
        actorType: "SYSTEM",
        tenantId: "tenant-replay",
        ip: "127.0.0.1",
        userAgent: "test-agent",
        metadata: expect.objectContaining({
          familyId: "family-001",
          reason: "replay",
        }),
      }),
    );
  });

  // Race-loss audit log (issue #435 — fail-closed family revocation)
  it("refresh_token: logs MCP_REFRESH_TOKEN_FAMILY_REVOKED audit on concurrent_rotation_revoked", async () => {
    mockExchangeRefreshToken.mockResolvedValue({
      ok: false,
      error: "invalid_grant",
      reason: "concurrent_rotation_revoked",
      tenantId: "tenant-race",
      familyId: "family-race-001",
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
        action: "MCP_REFRESH_TOKEN_FAMILY_REVOKED",
        userId: SYSTEM_ACTOR_ID,
        actorType: "SYSTEM",
        tenantId: "tenant-race",
        ip: "127.0.0.1",
        userAgent: "test-agent",
        metadata: expect.objectContaining({
          familyId: "family-race-001",
          reason: "concurrent_rotation",
        }),
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

  // T3.1: null userId path uses SYSTEM_ACTOR_ID + SYSTEM actorType in logAuditAsync
  it("refresh_token: logs MCP_REFRESH_TOKEN_ROTATE with SYSTEM_ACTOR_ID and SYSTEM actorType when userId is null", async () => {
    mockExchangeRefreshToken.mockResolvedValue({
      ok: true,
      accessToken: "mcp_machine_token",
      refreshToken: "mcpr_machine",
      expiresIn: 3600,
      scope: "credentials:list",
      tenantId: "tenant-machine",
      userId: null, // machine-only token (no user context)
    });

    const req = createRequest("POST", "http://localhost/api/mcp/token", {
      body: VALID_REFRESH_BODY,
    });
    await POST(req);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "MCP_REFRESH_TOKEN_ROTATE",
        userId: SYSTEM_ACTOR_ID,
        actorType: "SYSTEM",
        tenantId: "tenant-machine",
        ip: "127.0.0.1",
        userAgent: "test-agent",
      }),
    );
  });

  // ─── C8: Passkey enforcement matrix for MCP refresh ──────────

  describe("C8: passkey enforcement on MCP token refresh", () => {
    beforeEach(() => {
      mockExchangeRefreshToken.mockResolvedValue({
        ok: true,
        accessToken: "mcp_access",
        refreshToken: "mcpr_new",
        expiresIn: 3600,
        scope: "credentials:list",
        tenantId: TENANT_ID,
        userId: USER_ID,
        serviceAccountId: null,
      });
    });

    it("6c-off: requirePasskey=false → rotates (exchangeRefreshToken called)", async () => {
      mockMcpRefreshTokenFindUnique.mockResolvedValue({ userId: USER_ID, tenantId: TENANT_ID });
      mockDerivePasskeyState.mockResolvedValue({
        requirePasskey: false,
        hasPasskey: false,
        requirePasskeyEnabledAt: null,
        passkeyGracePeriodDays: null,
      });

      const req = createRequest("POST", "http://localhost/api/mcp/token", { body: VALID_REFRESH_BODY });
      const res = await POST(req);
      const { status } = await parseResponse(res);

      expect(status).toBe(200);
      expect(mockExchangeRefreshToken).toHaveBeenCalledOnce();
    });

    it("6c-haspasskey: requirePasskey=true + hasPasskey=true → rotates", async () => {
      mockMcpRefreshTokenFindUnique.mockResolvedValue({ userId: USER_ID, tenantId: TENANT_ID });
      mockDerivePasskeyState.mockResolvedValue({
        requirePasskey: true,
        hasPasskey: true,
        requirePasskeyEnabledAt: "2024-01-01T00:00:00.000Z",
        passkeyGracePeriodDays: 7,
      });

      const req = createRequest("POST", "http://localhost/api/mcp/token", { body: VALID_REFRESH_BODY });
      const res = await POST(req);
      const { status } = await parseResponse(res);

      expect(status).toBe(200);
      expect(mockExchangeRefreshToken).toHaveBeenCalledOnce();
    });

    it("6c-withingrace: requirePasskey=true + no passkey + within grace → rotates", async () => {
      mockMcpRefreshTokenFindUnique.mockResolvedValue({ userId: USER_ID, tenantId: TENANT_ID });
      // enabledAt = 3 days ago, grace = 7 days → 4 more days remain (genuinely within grace)
      const past3Days = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      mockDerivePasskeyState.mockResolvedValue({
        requirePasskey: true,
        hasPasskey: false,
        requirePasskeyEnabledAt: past3Days,
        passkeyGracePeriodDays: 7,
      });

      const req = createRequest("POST", "http://localhost/api/mcp/token", { body: VALID_REFRESH_BODY });
      const res = await POST(req);
      const { status } = await parseResponse(res);

      expect(status).toBe(200);
      expect(mockExchangeRefreshToken).toHaveBeenCalledOnce();
    });

    it("6c-graceexpired: requirePasskey=true + no passkey + grace expired → REFUSED (RT8) + audit", async () => {
      mockMcpRefreshTokenFindUnique.mockResolvedValue({ userId: USER_ID, tenantId: TENANT_ID });
      mockDerivePasskeyState.mockResolvedValue({
        requirePasskey: true,
        hasPasskey: false,
        requirePasskeyEnabledAt: "2020-01-01T00:00:00.000Z",
        passkeyGracePeriodDays: 7,
      });

      const req = createRequest("POST", "http://localhost/api/mcp/token", { body: VALID_REFRESH_BODY });
      const res = await POST(req);
      const { status, json } = await parseResponse(res);

      // Refused with access_denied (403) — OAuth error shape
      expect(status).toBe(403);
      expect(json.error).toBe("access_denied");
      // RT8: exchangeRefreshToken must NOT be called
      expect(mockExchangeRefreshToken).not.toHaveBeenCalled();
      // Audit must be emitted
      expect(mockRecordPasskeyAuditEmit).toHaveBeenCalledWith(
        USER_ID,
        "/api/mcp/token",
        expect.any(Number),
      );
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "PASSKEY_ENFORCEMENT_BLOCKED",
          metadata: { blockedPath: "/api/mcp/token" },
        }),
      );
    });

    it("6c-sa-bound: userId===null (SA-bound token) → skips gate, rotates normally", async () => {
      // SA-bound: userId is null — passkey gate must be skipped entirely
      mockMcpRefreshTokenFindUnique.mockResolvedValue({ userId: null, tenantId: TENANT_ID });
      // exchangeRefreshToken returns a valid SA token response
      mockExchangeRefreshToken.mockResolvedValue({
        ok: true,
        accessToken: "mcp_sa_access",
        refreshToken: "mcpr_sa_new",
        expiresIn: 3600,
        scope: "credentials:list",
        tenantId: TENANT_ID,
        userId: null,
        serviceAccountId: "sa-1",
      });

      const req = createRequest("POST", "http://localhost/api/mcp/token", { body: VALID_REFRESH_BODY });
      const res = await POST(req);
      const { status } = await parseResponse(res);

      expect(status).toBe(200);
      // Must rotate normally
      expect(mockExchangeRefreshToken).toHaveBeenCalledOnce();
      // derivePasskeyState must NOT have been called for SA-bound token
      expect(mockDerivePasskeyState).not.toHaveBeenCalled();
    });

    it("6c-row-not-found: refresh token row not found → skip gate, let exchangeRefreshToken return invalid_grant", async () => {
      // Row not found: gate skips, exchangeRefreshToken handles the error
      mockMcpRefreshTokenFindUnique.mockResolvedValue(null);
      mockExchangeRefreshToken.mockResolvedValue({ ok: false, error: "invalid_grant" });

      const req = createRequest("POST", "http://localhost/api/mcp/token", { body: VALID_REFRESH_BODY });
      const res = await POST(req);
      const { status, json } = await parseResponse(res);

      expect(status).toBe(400);
      expect(json.error).toBe("invalid_grant");
      expect(mockExchangeRefreshToken).toHaveBeenCalledOnce();
    });

    it("6c-throws: derivePasskeyState throws → fail closed (no rotation)", async () => {
      mockMcpRefreshTokenFindUnique.mockResolvedValue({ userId: USER_ID, tenantId: TENANT_ID });
      mockDerivePasskeyState.mockRejectedValue(new Error("DB error"));

      const req = createRequest("POST", "http://localhost/api/mcp/token", { body: VALID_REFRESH_BODY });
      await expect(POST(req)).rejects.toThrow("DB error");
      expect(mockExchangeRefreshToken).not.toHaveBeenCalled();
    });
  });
});
