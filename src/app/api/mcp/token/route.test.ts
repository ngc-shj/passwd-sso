import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseResponse } from "../../../../__tests__/helpers/request-builder";
import { assertRedisFailClosed, snapshotFactory } from "@/__tests__/helpers/fail-closed";
import {
  MCP_AUTHORIZATION_CODE_MAX_LENGTH,
  MCP_CLIENT_SECRET_MAX_LENGTH,
  MCP_PRESENTED_TOKEN_MAX_LENGTH,
} from "@/lib/constants/auth/mcp";

const {
  mockExchangeCodeForToken,
  mockCreateRefreshToken,
  mockExchangeRefreshToken,
  mockHashToken,
  mockTokenLimiterCheck,
  mockIpLimiterCheck,
  mockRateLimiterCheck,
  mockCreateRateLimiter,
  mockLogAudit,
  mockMcpRefreshTokenFindUnique,
  mockWithBypassRls,
  mockDerivePasskeyState,
  mockRecordPasskeyAuditEmit,
  mockResolveCodeTenantId,
  mockResolveRefreshTokenGate,
  mockEnforceAccessRestriction,
} = vi.hoisted(() => {
  // T4 carve-out (R3): the route constructs TWO independent limiters —
  // tokenRateLimiter (route.ts:33, created FIRST) and ipRateLimiter
  // (route.ts:38, created SECOND). A single shared check mock cannot
  // distinguish which limiter a test is driving, so the factory is a
  // RECORDING vi.fn with a mockReturnValueOnce chain in route-creation
  // order: first call -> token limiter, second call -> ip limiter.
  // mockRateLimiterCheck is kept as an alias to mockTokenLimiterCheck so
  // every PRE-EXISTING test in this file (which only ever exercises the
  // client-scoped token limiter — createRequest() sets no client IP, so
  // the `if (ip)` gate is never entered) continues to compile/pass
  // unchanged.
  const mockTokenLimiterCheck = vi.fn().mockResolvedValue({ allowed: true });
  const mockIpLimiterCheck = vi.fn().mockResolvedValue({ allowed: true });
  return {
    mockExchangeCodeForToken: vi.fn(),
    mockCreateRefreshToken: vi.fn().mockResolvedValue({ refreshToken: "mcp_rt_refreshtoken", expiresAt: new Date() }),
    mockExchangeRefreshToken: vi.fn(),
    // IP-access gate resolvers (read-only tenant lookup) + enforcement. Default:
    // resolve a tenant, live (not replayed), and ALLOW (enforce returns null).
    // Deny tests override; the refresh gate carries alreadyRotated so a replayed
    // token can skip the IP gate and fall through to family-revoking exchange.
    mockResolveCodeTenantId: vi.fn().mockResolvedValue("tenant-1"),
    mockResolveRefreshTokenGate: vi.fn().mockResolvedValue({ tenantId: "tenant-1", alreadyRotated: false }),
    mockEnforceAccessRestriction: vi.fn().mockResolvedValue(null),
    mockHashToken: vi.fn((token: string) => `hashed:${token}`),
    mockTokenLimiterCheck,
    mockIpLimiterCheck,
    mockRateLimiterCheck: mockTokenLimiterCheck,
    mockCreateRateLimiter: vi
      .fn()
      .mockReturnValueOnce({ check: mockTokenLimiterCheck, clear: vi.fn() })
      .mockReturnValueOnce({ check: mockIpLimiterCheck, clear: vi.fn() }),
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
  };
});

vi.mock("@/lib/mcp/oauth-server", () => ({
  exchangeCodeForToken: mockExchangeCodeForToken,
  createRefreshToken: mockCreateRefreshToken,
  exchangeRefreshToken: mockExchangeRefreshToken,
  resolveCodeTenantId: mockResolveCodeTenantId,
  resolveRefreshTokenGate: mockResolveRefreshTokenGate,
}));
vi.mock("@/lib/auth/policy/access-restriction", () => ({
  enforceAccessRestriction: mockEnforceAccessRestriction,
}));
vi.mock("@/lib/crypto/crypto-server", () => ({
  hashToken: mockHashToken,
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: mockCreateRateLimiter,
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

// The module-level `tokenRateLimiter = createRateLimiter(...)` (route.ts:33,
// FIRST call) and `ipRateLimiter = createRateLimiter(...)` (route.ts:38,
// SECOND call) run once at import time, above. The global `beforeEach` in
// src/__tests__/setup.ts calls `vi.clearAllMocks()` before the FIRST test
// runs, wiping `mockCreateRateLimiter.mock.calls`/`.results` recorded during
// that import. Snapshot them here (module scope, before any test/beforeEach
// executes) so `assertRedisFailClosed`'s factory-attribution check still has
// the original calls/results to inspect after clearAllMocks runs.
const mcpTokenLimiterFactorySnapshot = snapshotFactory(mockCreateRateLimiter);
// results[0] = token limiter (first factory call), results[1] = ip limiter
// (second factory call) — per the plan's case-map identity mapping.
const mcpTokenRateLimiter = mockCreateRateLimiter.mock.results[0]!.value as {
  check: typeof mockTokenLimiterCheck;
};
const mcpIpRateLimiter = mockCreateRateLimiter.mock.results[1]!.value as {
  check: typeof mockIpLimiterCheck;
};

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
    mockIpLimiterCheck.mockResolvedValue({ allowed: true });
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
    // IP-access gate defaults: resolve a tenant, live (not replayed), and ALLOW.
    // Deny tests override.
    mockResolveCodeTenantId.mockResolvedValue(TENANT_ID);
    mockResolveRefreshTokenGate.mockResolvedValue({ tenantId: TENANT_ID, alreadyRotated: false });
    mockEnforceAccessRestriction.mockResolvedValue(null);
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

  it("authorization_code: rejects an oversized client_id before the rate-limit key or exchange", async () => {
    // Same rate-limit-key amplification guard as the refresh grant: client_id is
    // concatenated into `mcp:token:${client_id}`, so an oversized value is
    // rejected at the boundary rather than reaching the backend.
    const oversized = "mcpc_" + "A".repeat(20_000);
    const req = createRequest("POST", "http://localhost/api/mcp/token", {
      body: {
        grant_type: "authorization_code",
        code: "auth-code-123",
        redirect_uri: "https://client.example/cb",
        client_id: oversized,
        code_verifier: "a-code-verifier-value",
      },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("invalid_request");
    // Rejected at the boundary before either rate-limiter call. (The IP-scoped
    // check is skipped here because the test request carries no client IP, so
    // the limiter must not fire at all — the client-scoped
    // `mcp:token:<client_id>` key is never built from the oversized value.)
    expect(mockRateLimiterCheck).not.toHaveBeenCalled();
    expect(mockExchangeCodeForToken).not.toHaveBeenCalled();
  });

  it("authorization_code: rejects an oversized code before hashing or lookup", async () => {
    const req = createRequest("POST", "http://localhost/api/mcp/token", {
      body: {
        ...VALID_BODY,
        code: "A".repeat(MCP_AUTHORIZATION_CODE_MAX_LENGTH + 1),
      },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("invalid_request");
    expect(mockRateLimiterCheck).not.toHaveBeenCalled();
    expect(mockResolveCodeTenantId).not.toHaveBeenCalled();
    expect(mockHashToken).not.toHaveBeenCalled();
    expect(mockExchangeCodeForToken).not.toHaveBeenCalled();
  });

  it("authorization_code: rejects a non-string code (JSON body) before the rate-limit key or exchange", async () => {
    // The JSON body is only cast to Record<string,string>; a non-string `code`
    // must be rejected by the boundary type check, parallel to the client_id
    // non-string guard already covered for the refresh_token grant.
    const req = createRequest("POST", "http://localhost/api/mcp/token", {
      body: {
        grant_type: "authorization_code",
        code: { padding: "A".repeat(20_000) },
        redirect_uri: "https://example.com/callback",
        client_id: "mcpc_testclient",
        code_verifier: "my-code-verifier",
      },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("invalid_request");
    expect(mockRateLimiterCheck).not.toHaveBeenCalled();
    expect(mockExchangeCodeForToken).not.toHaveBeenCalled();
  });

  it("authorization_code: rejects a non-string redirect_uri before the rate-limit key or exchange", async () => {
    const req = createRequest("POST", "http://localhost/api/mcp/token", {
      body: {
        grant_type: "authorization_code",
        code: "auth-code-123",
        redirect_uri: { padding: "A".repeat(20_000) },
        client_id: "mcpc_testclient",
        code_verifier: "my-code-verifier",
      },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("invalid_request");
    expect(mockRateLimiterCheck).not.toHaveBeenCalled();
    expect(mockExchangeCodeForToken).not.toHaveBeenCalled();
  });

  it("authorization_code: rejects a non-string code_verifier before the rate-limit key or exchange", async () => {
    const req = createRequest("POST", "http://localhost/api/mcp/token", {
      body: {
        grant_type: "authorization_code",
        code: "auth-code-123",
        redirect_uri: "https://example.com/callback",
        client_id: "mcpc_testclient",
        code_verifier: { padding: "A".repeat(20_000) },
      },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("invalid_request");
    expect(mockRateLimiterCheck).not.toHaveBeenCalled();
    expect(mockExchangeCodeForToken).not.toHaveBeenCalled();
  });

  it("authorization_code: rejects a non-string client_secret before the rate-limit key or exchange", async () => {
    // client_secret is optional but must be a string when present.
    const req = createRequest("POST", "http://localhost/api/mcp/token", {
      body: {
        grant_type: "authorization_code",
        code: "auth-code-123",
        redirect_uri: "https://example.com/callback",
        client_id: "mcpc_testclient",
        client_secret: { padding: "A".repeat(20_000) },
        code_verifier: "my-code-verifier",
      },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("invalid_request");
    expect(mockRateLimiterCheck).not.toHaveBeenCalled();
    expect(mockExchangeCodeForToken).not.toHaveBeenCalled();
  });

  it("authorization_code: rejects an oversized client_secret before hashing", async () => {
    const req = createRequest("POST", "http://localhost/api/mcp/token", {
      body: {
        ...VALID_BODY,
        client_secret: "A".repeat(MCP_CLIENT_SECRET_MAX_LENGTH + 1),
      },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("invalid_request");
    expect(mockRateLimiterCheck).not.toHaveBeenCalled();
    expect(mockHashToken).not.toHaveBeenCalled();
    expect(mockExchangeCodeForToken).not.toHaveBeenCalled();
  });

  it("authorization_code: rejects an empty-string client_id before the rate-limit key or exchange", async () => {
    // length === 0 is a distinct boundary from the oversized (> MAX) case
    // already covered above.
    const req = createRequest("POST", "http://localhost/api/mcp/token", {
      body: {
        grant_type: "authorization_code",
        code: "auth-code-123",
        redirect_uri: "https://example.com/callback",
        client_id: "",
        code_verifier: "my-code-verifier",
      },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("invalid_request");
    expect(mockRateLimiterCheck).not.toHaveBeenCalled();
    expect(mockExchangeCodeForToken).not.toHaveBeenCalled();
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
    // RT8: the rate-limit reject must block the code exchange from running.
    expect(mockExchangeCodeForToken).not.toHaveBeenCalled();
  });

  it("fails closed (503, no mutation) when Redis is unavailable — ip", async () => {
    // Case A (plan case map): the IP-scoped limiter (route.ts:68, checked
    // BEFORE grant-type dispatch) errors. Requires a client IP on the
    // request so the `if (ip)` gate is entered — existing tests in this file
    // never set one, so this is the only case that exercises the ip limiter.
    // The oauth envelope check confirms the production checkRateLimitOrFail
    // mapping stayed in path.
    await assertRedisFailClosed({
      invoke: () =>
        POST(
          createRequest("POST", "http://localhost/api/mcp/token", {
            body: VALID_BODY,
            headers: { "x-forwarded-for": "203.0.113.7" },
          }),
        ),
      limiter: mcpIpRateLimiter,
      expectation: { envelope: "oauth" },
      assertNoMutation: [mockExchangeCodeForToken, mockExchangeRefreshToken],
      limiterFactory: mcpTokenLimiterFactorySnapshot.replay(),
      failure: { allowed: false, redisErrored: true },
    });
  });

  it("fails closed (503, no mutation) when Redis is unavailable — token (authorization_code)", async () => {
    // Case B (plan case map): ip limiter allows, token limiter (route.ts:122)
    // errors inside the authorization_code branch. No client IP on the
    // request, so the ip gate is skipped entirely (mcpIpRateLimiter.check
    // is not even reached) — arranging it to allow is defensive parity with
    // the plan's "arrange the sibling ip check {allowed:true}" instruction.
    mockIpLimiterCheck.mockResolvedValue({ allowed: true });
    await assertRedisFailClosed({
      invoke: () => POST(createRequest("POST", "http://localhost/api/mcp/token", { body: VALID_BODY })),
      limiter: mcpTokenRateLimiter,
      expectation: { envelope: "oauth" },
      assertNoMutation: [mockExchangeCodeForToken, mockExchangeRefreshToken],
      limiterFactory: mcpTokenLimiterFactorySnapshot.replay(),
      failure: { allowed: false, redisErrored: true },
    });
  });

  it("authorization_code: denies off-network IP BEFORE minting (no exchange, no code consumed)", async () => {
    // Tenant network restriction (allowedCidrs / Tailscale) must gate the token
    // endpoint like the MCP gateway — a stolen code redeemed from a blocked IP is
    // rejected before exchangeCodeForToken mints anything.
    mockResolveCodeTenantId.mockResolvedValue(TENANT_ID);
    mockEnforceAccessRestriction.mockResolvedValue(
      Response.json({ error: "ACCESS_DENIED" }, { status: 403 }),
    );

    const req = createRequest("POST", "http://localhost/api/mcp/token", {
      body: VALID_BODY,
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(403);
    expect(json.error).toBe("ACCESS_DENIED");
    // Enforced with the resolved tenant override + MCP_AGENT actor, BEFORE mint.
    expect(mockEnforceAccessRestriction).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      TENANT_ID,
      "MCP_AGENT",
    );
    expect(mockExchangeCodeForToken).not.toHaveBeenCalled();
  });

  it("authorization_code: an UNKNOWN code resolves to null tenant, skips enforcement, and falls through to invalid_grant", async () => {
    // A code that resolves to no row must not be IP-gated; the real exchange
    // produces the authoritative error rather than the gate masking it.
    mockResolveCodeTenantId.mockResolvedValue(null);
    mockExchangeCodeForToken.mockResolvedValue({ ok: false, error: "invalid_grant" });

    const req = createRequest("POST", "http://localhost/api/mcp/token", {
      body: VALID_BODY,
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(mockEnforceAccessRestriction).not.toHaveBeenCalled();
    expect(mockExchangeCodeForToken).toHaveBeenCalled();
    expect(status).toBe(400);
    expect(json.error).toBe("invalid_grant");
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

  it("refresh_token: denies off-network IP BEFORE rotation (no exchange, chain not advanced)", async () => {
    // Critical for refresh: enforcement must precede exchangeRefreshToken so a
    // stolen refresh token cannot be rotated from a blocked IP — a post-rotation
    // denial would strand the legitimate client whose chain was already advanced.
    // A LIVE (not-yet-rotated) token is the gated case.
    mockResolveRefreshTokenGate.mockResolvedValue({ tenantId: TENANT_ID, alreadyRotated: false });
    mockEnforceAccessRestriction.mockResolvedValue(
      Response.json({ error: "ACCESS_DENIED" }, { status: 403 }),
    );

    const req = createRequest("POST", "http://localhost/api/mcp/token", {
      body: VALID_REFRESH_BODY,
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(403);
    expect(json.error).toBe("ACCESS_DENIED");
    expect(mockExchangeRefreshToken).not.toHaveBeenCalled();
  });

  it("refresh_token: a REPLAYED (already-rotated) token SKIPS the IP gate and falls through to exchange (family revocation must not be suppressed)", async () => {
    // A replayed token is a theft signal; exchangeRefreshToken revokes the whole
    // family on replay. If the IP gate 403'd a replay before the exchange ran, an
    // off-network attacker's replay would silently evade family revocation. So a
    // replayed token must reach the exchange regardless of IP — the gate is skipped.
    mockResolveRefreshTokenGate.mockResolvedValue({ tenantId: TENANT_ID, alreadyRotated: true });
    // Even if the IP would deny, it must not be consulted for a replay.
    mockEnforceAccessRestriction.mockResolvedValue(
      Response.json({ error: "ACCESS_DENIED" }, { status: 403 }),
    );
    mockExchangeRefreshToken.mockResolvedValue({
      ok: false,
      error: "invalid_grant",
      reason: "replay",
      tenantId: TENANT_ID,
      familyId: "fam_replay",
    });

    const req = createRequest("POST", "http://localhost/api/mcp/token", {
      body: VALID_REFRESH_BODY,
    });
    const res = await POST(req);
    const { status } = await parseResponse(res);

    // Reaches the exchange (which handles replay: revokes family + audits), and
    // the IP gate is NOT consulted for the replayed token.
    expect(mockExchangeRefreshToken).toHaveBeenCalled();
    expect(mockEnforceAccessRestriction).not.toHaveBeenCalled();
    expect(status).toBe(400);
  });

  it("refresh_token: an UNKNOWN token resolves to null gate, skips enforcement, and falls through to invalid_grant", async () => {
    // A token that resolves to no row must not be IP-gated (there is no tenant to
    // resolve a policy for); the real exchange produces the authoritative error.
    mockResolveRefreshTokenGate.mockResolvedValue(null);
    mockExchangeRefreshToken.mockResolvedValue({ ok: false, error: "invalid_grant" });

    const req = createRequest("POST", "http://localhost/api/mcp/token", {
      body: VALID_REFRESH_BODY,
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(mockEnforceAccessRestriction).not.toHaveBeenCalled();
    expect(mockExchangeRefreshToken).toHaveBeenCalled();
    expect(status).toBe(400);
    expect(json.error).toBe("invalid_grant");
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
    // RT8: the rate-limit reject must block the exchange from running, not just
    // return 429 — a status-only assertion stays green if the gate is removed.
    expect(mockExchangeRefreshToken).not.toHaveBeenCalled();
  });

  it("fails closed (503, no mutation) when Redis is unavailable — token (refresh_token)", async () => {
    // Case C (plan case map): ip limiter allows, token limiter (route.ts:237)
    // errors inside the refresh_token branch. No client IP on the request,
    // so the ip gate is skipped — arranging it to allow is defensive parity
    // with the plan's "arrange the sibling ip check {allowed:true}" instruction.
    mockIpLimiterCheck.mockResolvedValue({ allowed: true });
    await assertRedisFailClosed({
      invoke: () =>
        POST(createRequest("POST", "http://localhost/api/mcp/token", { body: VALID_REFRESH_BODY })),
      limiter: mcpTokenRateLimiter,
      expectation: { envelope: "oauth" },
      assertNoMutation: [mockExchangeCodeForToken, mockExchangeRefreshToken],
      limiterFactory: mcpTokenLimiterFactorySnapshot.replay(),
      failure: { allowed: false, redisErrored: true },
    });
  });

  // T-13: replay detection audit log
  it("refresh_token: logs MCP_REFRESH_TOKEN_REPLAY audit on replay detection", async () => {
    // storedClientId deliberately differs from VALID_REFRESH_BODY.client_id
    // ("mcpc_abc") — the audit must attribute the replay to the token row's
    // client, keeping the caller-claimed value only as presentedClientId.
    mockExchangeRefreshToken.mockResolvedValue({
      ok: false,
      error: "invalid_grant",
      reason: "replay",
      tenantId: "tenant-replay",
      familyId: "family-001",
      storedClientId: "mcpc_stored_real",
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
          clientId: "mcpc_stored_real",
          presentedClientId: "mcpc_abc",
          familyId: "family-001",
          reason: "replay",
        }),
      }),
    );
    // The stored id is audit-only forensics — it must never leak into the
    // OAuth error response body.
    expect(JSON.stringify(json)).not.toContain("mcpc_stored_real");
  });

  it("refresh_token: rejects an oversized (but string) client_id before the rate-limit key or exchange", async () => {
    // A real McpClient.clientId is VarChar(64). An oversized string would (a)
    // be concatenated raw into the rate-limit key `mcp:token:${client_id}`,
    // letting an attacker create huge / numerous keys in the backend, and
    // (b) reach the replay audit metadata. The boundary length bound rejects
    // it up front rather than merely capping it downstream.
    const oversized = "mcpc_" + "A".repeat(20_000);
    const req = createRequest("POST", "http://localhost/api/mcp/token", {
      body: { ...VALID_REFRESH_BODY, client_id: oversized },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("invalid_request");
    // Rejected at the boundary before any rate-limiter call. (The IP-scoped
    // check is skipped here because the test request carries no client IP, so
    // the limiter must not fire at all — the client-scoped
    // `mcp:token:<client_id>` key is never built from the oversized value.)
    expect(mockRateLimiterCheck).not.toHaveBeenCalled();
    expect(mockExchangeRefreshToken).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("refresh_token: accepts a client_id at exactly the 64-char limit", async () => {
    // Boundary condition: length === MCP_CLIENT_ID_MAX_LENGTH must pass (the
    // reject is length > MAX, not >= MAX).
    const atLimit = "mcpc_" + "A".repeat(64 - "mcpc_".length); // exactly 64 chars
    expect(atLimit.length).toBe(64);
    mockExchangeRefreshToken.mockResolvedValue({
      ok: false,
      error: "invalid_grant",
      reason: "replay",
      tenantId: "tenant-replay",
      familyId: "family-001",
      storedClientId: "mcpc_stored_real",
    });
    const req = createRequest("POST", "http://localhost/api/mcp/token", {
      body: { ...VALID_REFRESH_BODY, client_id: atLimit },
    });
    await POST(req);

    const replayCall = mockLogAudit.mock.calls.find(
      ([entry]) => entry?.action === "MCP_REFRESH_TOKEN_REPLAY",
    );
    expect(replayCall).toBeDefined();
    const meta = replayCall![0].metadata;
    expect(meta.presentedClientId).toBe(atLimit);
    expect(meta.clientId).toBe("mcpc_stored_real");
  });

  it("refresh_token: rejects a non-string client_id (JSON body) before it reaches the exchange or audit", async () => {
    // The JSON body is only cast to Record<string,string>; an attacker can send
    // client_id as a huge object/array to bypass the audit length cap (slice is
    // string-only) and re-open the metadata-truncation vector. The boundary type
    // check must reject it as invalid_request before any sink sees it.
    const req = createRequest("POST", "http://localhost/api/mcp/token", {
      body: {
        grant_type: "refresh_token",
        refresh_token: "mcpr_test123",
        // A non-string client_id: a nested object that JSON.stringify would
        // serialize to well over METADATA_MAX_BYTES.
        client_id: { padding: "A".repeat(20_000) },
      },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("invalid_request");
    // Neither the exchange nor any audit ran — the request never got past the
    // boundary check.
    expect(mockExchangeRefreshToken).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("refresh_token: rejects a non-string refresh_token before the rate-limit key or exchange", async () => {
    const req = createRequest("POST", "http://localhost/api/mcp/token", {
      body: {
        grant_type: "refresh_token",
        refresh_token: { padding: "A".repeat(20_000) },
        client_id: "mcpc_abc",
      },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("invalid_request");
    expect(mockRateLimiterCheck).not.toHaveBeenCalled();
    expect(mockExchangeRefreshToken).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("refresh_token: rejects an oversized refresh_token before hashing or lookup", async () => {
    const req = createRequest("POST", "http://localhost/api/mcp/token", {
      body: {
        ...VALID_REFRESH_BODY,
        refresh_token: "A".repeat(MCP_PRESENTED_TOKEN_MAX_LENGTH + 1),
      },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("invalid_request");
    expect(mockRateLimiterCheck).not.toHaveBeenCalled();
    expect(mockResolveRefreshTokenGate).not.toHaveBeenCalled();
    expect(mockHashToken).not.toHaveBeenCalled();
    expect(mockExchangeRefreshToken).not.toHaveBeenCalled();
  });

  it("refresh_token: rejects a non-string client_secret before the rate-limit key or exchange", async () => {
    // client_secret is optional but must be a string when present.
    const req = createRequest("POST", "http://localhost/api/mcp/token", {
      body: {
        grant_type: "refresh_token",
        refresh_token: "mcpr_test123",
        client_id: "mcpc_abc",
        client_secret: { padding: "A".repeat(20_000) },
      },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("invalid_request");
    expect(mockRateLimiterCheck).not.toHaveBeenCalled();
    expect(mockExchangeRefreshToken).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("refresh_token: rejects an oversized client_secret before hashing", async () => {
    const req = createRequest("POST", "http://localhost/api/mcp/token", {
      body: {
        ...VALID_REFRESH_BODY,
        client_secret: "A".repeat(MCP_CLIENT_SECRET_MAX_LENGTH + 1),
      },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("invalid_request");
    expect(mockRateLimiterCheck).not.toHaveBeenCalled();
    expect(mockHashToken).not.toHaveBeenCalled();
    expect(mockExchangeRefreshToken).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("refresh_token: rejects an empty-string client_id before the rate-limit key or exchange", async () => {
    // length === 0 is a distinct boundary from the oversized (> MAX) case
    // already covered above.
    const req = createRequest("POST", "http://localhost/api/mcp/token", {
      body: {
        grant_type: "refresh_token",
        refresh_token: "mcpr_test123",
        client_id: "",
      },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("invalid_request");
    expect(mockRateLimiterCheck).not.toHaveBeenCalled();
    expect(mockExchangeRefreshToken).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("refresh_token (form-encoded): an oversized client_id is rejected on the form path too", async () => {
    // URL-encoded form input is always string-typed, so it would pass the type
    // check — the length bound is what rejects it. Regression coverage for the
    // form input path alongside the JSON path above.
    const oversized = "mcpc_" + "B".repeat(20_000);
    const form =
      "grant_type=refresh_token" +
      "&refresh_token=mcpr_test123" +
      "&client_id=" + encodeURIComponent(oversized);
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/mcp/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    } as ConstructorParameters<typeof NextRequest>[1]);
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("invalid_request");
    expect(mockExchangeRefreshToken).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  // Race-loss audit log (issue #435 — fail-closed family revocation)
  it("refresh_token: logs MCP_REFRESH_TOKEN_FAMILY_REVOKED audit on concurrent_rotation_revoked", async () => {
    mockExchangeRefreshToken.mockResolvedValue({
      ok: false,
      error: "invalid_grant",
      reason: "concurrent_rotation_revoked",
      tenantId: "tenant-race",
      familyId: "family-race-001",
      storedClientId: "mcpc_stored_real",
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
          clientId: "mcpc_stored_real",
          presentedClientId: "mcpc_abc",
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

    it("6c-off: lib returns ok (non-blocked) → route returns 200", async () => {
      // The passkey gate is inside the lib. Route just maps ok result → 200.
      // (lib's non-blocking behavior is tested in oauth-server.test.ts)
      const req = createRequest("POST", "http://localhost/api/mcp/token", { body: VALID_REFRESH_BODY });
      const res = await POST(req);
      const { status } = await parseResponse(res);

      expect(status).toBe(200);
      expect(mockExchangeRefreshToken).toHaveBeenCalledOnce();
    });

    it("6c-haspasskey: lib returns ok (has passkey) → route returns 200", async () => {
      const req = createRequest("POST", "http://localhost/api/mcp/token", { body: VALID_REFRESH_BODY });
      const res = await POST(req);
      const { status } = await parseResponse(res);

      expect(status).toBe(200);
      expect(mockExchangeRefreshToken).toHaveBeenCalledOnce();
    });

    it("6c-withingrace: lib returns ok (within grace) → route returns 200", async () => {
      const req = createRequest("POST", "http://localhost/api/mcp/token", { body: VALID_REFRESH_BODY });
      const res = await POST(req);
      const { status } = await parseResponse(res);

      expect(status).toBe(200);
      expect(mockExchangeRefreshToken).toHaveBeenCalledOnce();
    });

    it("6c-graceexpired: lib returns access_denied (passkey blocked) → route returns 403 + audit", async () => {
      // The passkey gate now lives inside exchangeRefreshToken (lib-level).
      // Route must map the lib's access_denied result to 403 + audit.
      mockExchangeRefreshToken.mockResolvedValue({
        ok: false,
        error: "access_denied",
        reason: "passkey_required",
        tenantId: TENANT_ID,
        userId: USER_ID,
      });

      const req = createRequest("POST", "http://localhost/api/mcp/token", { body: VALID_REFRESH_BODY });
      const res = await POST(req);
      const { status, json } = await parseResponse(res);

      // Refused with access_denied (403) — OAuth error shape
      expect(status).toBe(403);
      expect(json.error).toBe("access_denied");
      // RT8: exchangeRefreshToken WAS called (gate is inside the lib now)
      expect(mockExchangeRefreshToken).toHaveBeenCalledOnce();
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

    it("6c-sa-bound: SA-bound token (userId===null) — lib skips gate, returns ok (route returns 200)", async () => {
      // SA-bound: lib skips the passkey gate internally; route just maps the ok result.
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
      expect(mockExchangeRefreshToken).toHaveBeenCalledOnce();
    });

    it("6c-row-not-found: token not found in lib ⇒ exchangeRefreshToken returns invalid_grant → 400", async () => {
      // Route does no pre-read; lib handles not-found internally.
      mockExchangeRefreshToken.mockResolvedValue({ ok: false, error: "invalid_grant" });

      const req = createRequest("POST", "http://localhost/api/mcp/token", { body: VALID_REFRESH_BODY });
      const res = await POST(req);
      const { status, json } = await parseResponse(res);

      expect(status).toBe(400);
      expect(json.error).toBe("invalid_grant");
      expect(mockExchangeRefreshToken).toHaveBeenCalledOnce();
    });

    it("6c-lib-throws: lib (exchangeRefreshToken) throws (DB error in passkey gate) → route propagates throw", async () => {
      // The passkey gate is inside the lib now. If derivePasskeyState throws,
      // exchangeRefreshToken propagates it. The route lets it bubble — fail closed.
      mockExchangeRefreshToken.mockRejectedValue(new Error("DB error"));

      const req = createRequest("POST", "http://localhost/api/mcp/token", { body: VALID_REFRESH_BODY });
      await expect(POST(req)).rejects.toThrow("DB error");
      // exchangeRefreshToken was called (the throw comes from inside it)
      expect(mockExchangeRefreshToken).toHaveBeenCalledOnce();
    });

    it("authorization_code: lib returns access_denied (passkey blocked) → route returns 403 + audit", async () => {
      // The passkey gate is inside exchangeCodeForToken now.
      // Route must map access_denied with userId → 403 + audit.
      mockExchangeCodeForToken.mockResolvedValue({
        ok: false,
        error: "access_denied",
        userId: USER_ID,
        tenantId: TENANT_ID,
      });

      const req = createRequest("POST", "http://localhost/api/mcp/token", { body: VALID_BODY });
      const res = await POST(req);
      const { status, json } = await parseResponse(res);

      expect(status).toBe(403);
      expect(json.error).toBe("access_denied");
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
  });
});
