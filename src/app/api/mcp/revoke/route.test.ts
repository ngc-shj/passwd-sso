import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "../../../../__tests__/helpers/request-builder";

const {
  mockRevokeToken,
  mockRateLimiterCheck,
} = vi.hoisted(() => ({
  mockRevokeToken: vi.fn().mockResolvedValue(undefined),
  mockRateLimiterCheck: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("@/lib/mcp/oauth-server", () => ({
  revokeToken: mockRevokeToken,
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateLimiterCheck }),
}));
vi.mock("@/lib/auth/ip-access", () => ({
  extractClientIp: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimitKeyFromIp: vi.fn((ip: string) => ip),
}));

import { POST } from "@/app/api/mcp/revoke/route";

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
});
