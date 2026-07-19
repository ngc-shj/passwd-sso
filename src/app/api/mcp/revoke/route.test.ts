import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "../../../../__tests__/helpers/request-builder";
import { assertRedisFailClosed, snapshotFactory } from "@/__tests__/helpers/fail-closed";

const {
  mockRevokeToken,
  mockRateLimiterCheck,
  mockCreateRateLimiter,
} = vi.hoisted(() => {
  const mockRateLimiterCheck = vi.fn().mockResolvedValue({ allowed: true });
  return {
    mockRevokeToken: vi.fn().mockResolvedValue(undefined),
    mockRateLimiterCheck,
    // Recording factory — assertRedisFailClosed's factory-attribution step
    // reads mockCreateRateLimiter.mock.{calls,results}.
    mockCreateRateLimiter: vi.fn((_opts: unknown) => ({ check: mockRateLimiterCheck, clear: vi.fn() })),
  };
});

vi.mock("@/lib/mcp/oauth-server", () => ({
  revokeToken: mockRevokeToken,
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: mockCreateRateLimiter,
}));
vi.mock("@/lib/auth/policy/ip-access", () => ({
  extractClientIp: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimitKeyFromIp: vi.fn((ip: string) => ip),
}));

import { POST } from "@/app/api/mcp/revoke/route";
import {
  MCP_CLIENT_ID_MAX_LENGTH,
  MCP_CLIENT_SECRET_MAX_LENGTH,
  MCP_PRESENTED_TOKEN_MAX_LENGTH,
  MCP_TOKEN_TYPE_HINT_MAX_LENGTH,
} from "@/lib/constants/auth/mcp";

// Module-scope snapshot (route.ts:19 `const revokeLimiter = createRateLimiter(...)`
// runs at import time, above). See fail-closed.ts module doc.
const revokeLimiterFactorySnapshot = snapshotFactory(mockCreateRateLimiter);
const revokeLimiter = mockCreateRateLimiter.mock.results[0]!.value as {
  check: typeof mockRateLimiterCheck;
};

const VALID_JSON_BODY = {
  token: "mcp_access_token_abc",
  client_id: "mcpc_testclient",
};

const VALID_FORM_BODY = "token=mcp_access_token_abc&client_id=mcpc_testclient";

describe("POST /api/mcp/revoke", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
    mockRevokeToken.mockResolvedValue(undefined);
  });

  // ─── Happy paths ────────────────────────────────────────────────────────────

  it("returns 200 for valid token + client_id (JSON)", async () => {
    const req = createRequest("POST", "http://localhost/api/mcp/revoke", {
      body: VALID_JSON_BODY,
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockRevokeToken).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "mcp_access_token_abc",
        clientId: "mcpc_testclient",
      }),
    );
  });

  it("returns 200 with token_type_hint=refresh_token", async () => {
    const req = createRequest("POST", "http://localhost/api/mcp/revoke", {
      body: { ...VALID_JSON_BODY, token_type_hint: "refresh_token" },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockRevokeToken).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "mcp_access_token_abc",
        tokenTypeHint: "refresh_token",
        clientId: "mcpc_testclient",
      }),
    );
  });

  it("maps an unsupported token_type_hint to undefined (RFC 7009 §2.1 — try both)", async () => {
    const req = createRequest("POST", "http://localhost/api/mcp/revoke", {
      body: { ...VALID_JSON_BODY, token_type_hint: "urn:ietf:params:oauth:token-type:jwt" },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockRevokeToken).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "mcp_access_token_abc",
        tokenTypeHint: undefined,
        clientId: "mcpc_testclient",
      }),
    );
  });

  it("returns 200 even when revokeToken would handle an unknown token (RFC 7009 §2.2)", async () => {
    // revokeToken itself handles unknown tokens gracefully; route always returns 200
    mockRevokeToken.mockResolvedValue(undefined);

    const req = createRequest("POST", "http://localhost/api/mcp/revoke", {
      body: { token: "unknown_token_xyz", client_id: "mcpc_testclient" },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
  });

  // ─── application/x-www-form-urlencoded ──────────────────────────────────────

  it("parses application/x-www-form-urlencoded body correctly", async () => {
    const req = new (await import("next/server")).NextRequest(
      "http://localhost/api/mcp/revoke",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: VALID_FORM_BODY,
      },
    );
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockRevokeToken).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "mcp_access_token_abc",
        clientId: "mcpc_testclient",
      }),
    );
  });

  it("parses urlencoded body with token_type_hint", async () => {
    const req = new (await import("next/server")).NextRequest(
      "http://localhost/api/mcp/revoke",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "token=mcp_rt_abc&client_id=mcpc_testclient&token_type_hint=access_token",
      },
    );
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockRevokeToken).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "mcp_rt_abc",
        tokenTypeHint: "access_token",
        clientId: "mcpc_testclient",
      }),
    );
  });

  // ─── application/json ───────────────────────────────────────────────────────

  it("parses application/json body correctly", async () => {
    const req = createRequest("POST", "http://localhost/api/mcp/revoke", {
      body: VALID_JSON_BODY,
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockRevokeToken).toHaveBeenCalledTimes(1);
  });

  // ─── Error paths ─────────────────────────────────────────────────────────────

  it("returns 400 when token is missing", async () => {
    const req = createRequest("POST", "http://localhost/api/mcp/revoke", {
      body: { client_id: "mcpc_testclient" },
    });
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe("invalid_request");
    expect(mockRevokeToken).not.toHaveBeenCalled();
  });

  it("returns 400 when client_id is missing", async () => {
    const req = createRequest("POST", "http://localhost/api/mcp/revoke", {
      body: { token: "mcp_access_token_abc" },
    });
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe("invalid_request");
    expect(mockRevokeToken).not.toHaveBeenCalled();
  });

  it("returns 400 when both token and client_id are missing", async () => {
    const req = createRequest("POST", "http://localhost/api/mcp/revoke", {
      body: {},
    });
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe("invalid_request");
  });

  it("returns 400 when body is invalid JSON", async () => {
    const req = new (await import("next/server")).NextRequest(
      "http://localhost/api/mcp/revoke",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-valid-json{{{",
      },
    );
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe("invalid_request");
  });

  it.each([
    { token: { nested: true }, client_id: "mcpc_testclient" },
    { token: ["mcp_access_token_abc"], client_id: "mcpc_testclient" },
    { token: "mcp_access_token_abc", client_id: { nested: true } },
    { ...VALID_JSON_BODY, client_secret: { nested: true } },
  ])("returns 400 for non-string OAuth parameters", async (body) => {
    const req = createRequest("POST", "http://localhost/api/mcp/revoke", { body });
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe("invalid_request");
    expect(mockRevokeToken).not.toHaveBeenCalled();
  });

  it("returns 400 when client_id exceeds the shared DB-backed length limit", async () => {
    const req = createRequest("POST", "http://localhost/api/mcp/revoke", {
      body: {
        ...VALID_JSON_BODY,
        client_id: "x".repeat(MCP_CLIENT_ID_MAX_LENGTH + 1),
      },
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(mockRevokeToken).not.toHaveBeenCalled();
  });

  it.each([
    ["token", MCP_PRESENTED_TOKEN_MAX_LENGTH],
    ["token_type_hint", MCP_TOKEN_TYPE_HINT_MAX_LENGTH],
    ["client_secret", MCP_CLIENT_SECRET_MAX_LENGTH],
  ] as const)("returns 400 when %s exceeds its shared length limit", async (field, max) => {
    const req = createRequest("POST", "http://localhost/api/mcp/revoke", {
      body: { ...VALID_JSON_BODY, [field]: "x".repeat(max + 1) },
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(mockRevokeToken).not.toHaveBeenCalled();
  });

  it("preserves empty optional OAuth parameters for public-client compatibility", async () => {
    const req = createRequest("POST", "http://localhost/api/mcp/revoke", {
      body: { ...VALID_JSON_BODY, token_type_hint: "", client_secret: "" },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockRevokeToken).toHaveBeenCalledWith(
      expect.objectContaining({ clientSecretHash: undefined }),
    );
  });

  // ─── Rate limiting ──────────────────────────────────────────────────────────

  it("returns 429 with Retry-After header when rate limit is exceeded", async () => {
    mockRateLimiterCheck.mockResolvedValue({
      allowed: false,
      retryAfterMs: 45_000,
    });

    const req = createRequest("POST", "http://localhost/api/mcp/revoke", {
      body: VALID_JSON_BODY,
    });
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json.error).toBe("rate_limited");
    expect(res.headers.get("Retry-After")).toBe("45");
    expect(mockRevokeToken).not.toHaveBeenCalled();
  });

  it("returns 429 with Retry-After defaulting to 60 when retryAfterMs is not provided", async () => {
    mockRateLimiterCheck.mockResolvedValue({
      allowed: false,
      retryAfterMs: undefined,
    });

    const req = createRequest("POST", "http://localhost/api/mcp/revoke", {
      body: VALID_JSON_BODY,
    });
    const res = await POST(req);

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
  });

  it("fails closed (503, no mutation) when Redis is unavailable", async () => {
    await assertRedisFailClosed({
      invoke: () =>
        POST(
          createRequest("POST", "http://localhost/api/mcp/revoke", {
            body: VALID_JSON_BODY,
          }),
        ),
      limiter: revokeLimiter,
      expectation: { envelope: "oauth" },
      assertNoMutation: [mockRevokeToken],
      limiterFactory: revokeLimiterFactorySnapshot.replay(),
      failure: { allowed: false, redisErrored: true },
    });
  });
});
