import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import {
  generateCodeVerifier,
  computeS256Challenge,
  startCallbackServer,
  validateServerUrl,
} from "../../lib/oauth.js";

describe("PKCE", () => {
  it("generateCodeVerifier returns base64url string of correct length", () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 random bytes → 43 chars in base64url
    expect(verifier.length).toBe(43);
  });

  it("computeS256Challenge produces correct S256 for RFC 7636 Appendix B vector", () => {
    // RFC 7636 Appendix B test vector
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const expectedChallenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(computeS256Challenge(verifier)).toBe(expectedChallenge);
  });

  it("computeS256Challenge is deterministic", () => {
    const verifier = generateCodeVerifier();
    expect(computeS256Challenge(verifier)).toBe(computeS256Challenge(verifier));
  });
});

describe("startCallbackServer port assignment", () => {
  it("returns a valid OS-assigned port", async () => {
    const { port, waitForCallback } = await startCallbackServer("test-state");
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
    // Clean up — trigger timeout rejection and ignore it
    waitForCallback().catch(() => {});
  });
});

describe("startCallbackServer", () => {
  // Suppress unhandled rejection warnings from internal Promise plumbing
  // (errors are properly caught via waitForCallback in production code)
  const noop = () => {};
  beforeAll(() => { process.on("unhandledRejection", noop); });
  afterAll(() => { process.off("unhandledRejection", noop); });
  it("resolves with code and state on valid callback", async () => {
    const expectedState = "test-state-abc";
    const { port, waitForCallback } = await startCallbackServer(expectedState);

    const callbackUrl = `http://127.0.0.1:${port}/callback?code=auth_code_123&state=${expectedState}`;
    const res = await fetch(callbackUrl);
    expect(res.status).toBe(200);

    const result = await waitForCallback();
    expect(result.code).toBe("auth_code_123");
    expect(result.state).toBe(expectedState);
  });

  it("rejects on state mismatch", async () => {
    const { port, waitForCallback } = await startCallbackServer("expected-state");

    const callbackPromise = waitForCallback();
    const callbackUrl = `http://127.0.0.1:${port}/callback?code=code&state=wrong-state`;
    const res = await fetch(callbackUrl);
    expect(res.status).toBe(400);

    await expect(callbackPromise).rejects.toThrow("state mismatch");
  });

  it("rejects on missing state parameter", async () => {
    const { port, waitForCallback } = await startCallbackServer("expected-state");

    const callbackPromise = waitForCallback();
    const callbackUrl = `http://127.0.0.1:${port}/callback?code=code`;
    const res = await fetch(callbackUrl);
    expect(res.status).toBe(400);

    await expect(callbackPromise).rejects.toThrow("missing code or state");
  });

  it("rejects on missing code parameter", async () => {
    const { port, waitForCallback } = await startCallbackServer("expected-state");

    const callbackPromise = waitForCallback();
    const callbackUrl = `http://127.0.0.1:${port}/callback?state=expected-state`;
    const res = await fetch(callbackUrl);
    expect(res.status).toBe(400);

    await expect(callbackPromise).rejects.toThrow("missing code or state");
  });

  it("rejects on OAuth error parameter", async () => {
    const { port, waitForCallback } = await startCallbackServer("state");

    const callbackPromise = waitForCallback();
    const callbackUrl = `http://127.0.0.1:${port}/callback?error=access_denied&error_description=User+denied`;
    const res = await fetch(callbackUrl);
    expect(res.status).toBe(400);

    await expect(callbackPromise).rejects.toThrow("User denied");
  });

  it("times out when no callback arrives", async () => {
    vi.useFakeTimers();
    const { port, waitForCallback } = await startCallbackServer("state");

    const promise = waitForCallback();

    // Advance past the 120s timeout
    await vi.advanceTimersByTimeAsync(121_000);

    await expect(promise).rejects.toThrow("Timed out");
    vi.useRealTimers();
  });
});

describe("validateServerUrl", () => {
  it("accepts HTTPS URLs", () => {
    expect(() => validateServerUrl("https://vault.example.com")).not.toThrow();
  });

  it("accepts http://127.0.0.1 for local dev", () => {
    expect(() => validateServerUrl("http://127.0.0.1:3000")).not.toThrow();
  });

  it("accepts http://localhost for local dev", () => {
    expect(() => validateServerUrl("http://localhost:3000")).not.toThrow();
  });

  it("accepts http://[::1] for IPv6 loopback", () => {
    expect(() => validateServerUrl("http://[::1]:3000")).not.toThrow();
  });

  it("rejects plain HTTP for non-loopback", () => {
    expect(() => validateServerUrl("http://vault.example.com")).toThrow("HTTPS");
  });

  it("rejects invalid URLs", () => {
    expect(() => validateServerUrl("not-a-url")).toThrow("Invalid");
  });
});

describe("registerClient", () => {
  const mockFetch = vi.fn();
  beforeEach(() => {
    mockFetch.mockReset();
    global.fetch = mockFetch;
  });

  it("sends correct DCR request body", async () => {
    const { registerClient } = await import("../../lib/oauth.js");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        client_id: "mcpc_test123",
        redirect_uris: ["http://127.0.0.1:9999/callback"],
      }),
    });

    const result = await registerClient("https://vault.example.com", "http://127.0.0.1:9999/callback");
    expect(result.clientId).toBe("mcpc_test123");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://vault.example.com/api/mcp/register");
    expect(opts.method).toBe("POST");

    const body = JSON.parse(opts.body);
    expect(body.client_name).toBe("passwd-sso-cli");
    expect(body.redirect_uris).toEqual(["http://127.0.0.1:9999/callback"]);
    expect(body.token_endpoint_auth_method).toBe("none");
  });

  it("throws on non-ok response", async () => {
    const { registerClient } = await import("../../lib/oauth.js");
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => "Service Unavailable",
    });

    await expect(
      registerClient("https://vault.example.com", "http://127.0.0.1:9999/callback"),
    ).rejects.toThrow("DCR registration failed (503)");
  });

  it("throws when server registers unexpected redirect_uri", async () => {
    const { registerClient } = await import("../../lib/oauth.js");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        client_id: "mcpc_test123",
        redirect_uris: ["https://evil.com/callback"],
      }),
    });

    await expect(
      registerClient("https://vault.example.com", "http://127.0.0.1:9999/callback"),
    ).rejects.toThrow("unexpected redirect_uri");
  });

  it("throws when response is missing client_id", async () => {
    const { registerClient } = await import("../../lib/oauth.js");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ redirect_uris: ["http://127.0.0.1:9999/callback"] }),
    });

    await expect(
      registerClient("https://vault.example.com", "http://127.0.0.1:9999/callback"),
    ).rejects.toThrow("DCR response missing client_id");
  });
});

describe("refreshTokenGrant", () => {
  const mockFetch = vi.fn();
  beforeEach(() => {
    mockFetch.mockReset();
    global.fetch = mockFetch;
  });

  it("sends POST /api/mcp/token with grant_type=refresh_token, refresh_token, client_id", async () => {
    const { refreshTokenGrant } = await import("../../lib/oauth.js");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "mcp_new_access",
        refresh_token: "mcpr_new_refresh",
        expires_in: 3600,
        scope: "credentials:list vault:status",
      }),
    });

    await refreshTokenGrant("https://vault.example.com", "mcpr_old_refresh", "mcpc_client123");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://vault.example.com/api/mcp/token");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(opts.body).toContain("grant_type=refresh_token");
    expect(opts.body).toContain("refresh_token=mcpr_old_refresh");
    expect(opts.body).toContain("client_id=mcpc_client123");
  });

  it("parses successful response into TokenResponse", async () => {
    const { refreshTokenGrant } = await import("../../lib/oauth.js");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "mcp_new_access",
        refresh_token: "mcpr_new_refresh",
        expires_in: 7200,
        scope: "credentials:list",
      }),
    });

    const result = await refreshTokenGrant("https://vault.example.com", "mcpr_old", "mcpc_client");

    expect(result).not.toBeNull();
    expect(result!.accessToken).toBe("mcp_new_access");
    expect(result!.refreshToken).toBe("mcpr_new_refresh");
    expect(result!.expiresIn).toBe(7200);
    expect(result!.scope).toBe("credentials:list");
  });

  it("returns null on non-ok response (does NOT throw)", async () => {
    const { refreshTokenGrant } = await import("../../lib/oauth.js");
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => "invalid_grant",
    });

    const result = await refreshTokenGrant("https://vault.example.com", "mcpr_expired", "mcpc_client");
    expect(result).toBeNull();
  });

  it("throws on JSON parse error when response.ok but body is invalid", async () => {
    const { refreshTokenGrant } = await import("../../lib/oauth.js");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    });

    await expect(
      refreshTokenGrant("https://vault.example.com", "mcpr_valid", "mcpc_client"),
    ).rejects.toThrow();
  });
});

describe("revokeTokenRequest", () => {
  const mockFetch = vi.fn();
  beforeEach(() => {
    mockFetch.mockReset();
    global.fetch = mockFetch;
  });

  it("sends POST /api/mcp/revoke with token, client_id, token_type_hint", async () => {
    const { revokeTokenRequest } = await import("../../lib/oauth.js");
    mockFetch.mockResolvedValueOnce({ ok: true });

    await revokeTokenRequest(
      "https://vault.example.com",
      "mcp_access_token",
      "mcpc_client123",
      "refresh_token",
    );

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://vault.example.com/api/mcp/revoke");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(opts.body).toContain("token=mcp_access_token");
    expect(opts.body).toContain("client_id=mcpc_client123");
    expect(opts.body).toContain("token_type_hint=refresh_token");
  });

  it("does not throw on network error (try-catch inside)", async () => {
    const { revokeTokenRequest } = await import("../../lib/oauth.js");
    mockFetch.mockRejectedValueOnce(new Error("Network failure"));

    await expect(
      revokeTokenRequest("https://vault.example.com", "mcp_token", "mcpc_client"),
    ).resolves.toBeUndefined();
  });

  it("does not throw on non-ok response", async () => {
    const { revokeTokenRequest } = await import("../../lib/oauth.js");
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });

    await expect(
      revokeTokenRequest("https://vault.example.com", "mcp_token", "mcpc_client"),
    ).resolves.toBeUndefined();
  });
});

describe("exchangeCode", () => {
  const mockFetch = vi.fn();
  beforeEach(() => {
    mockFetch.mockReset();
    global.fetch = mockFetch;
  });

  it("exchanges code for tokens successfully", async () => {
    const { exchangeCode } = await import("../../lib/oauth.js");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "mcp_access123",
        refresh_token: "mcpr_refresh456",
        expires_in: 3600,
        scope: "credentials:list vault:status",
      }),
    });

    const result = await exchangeCode("https://vault.example.com", {
      code: "auth_code",
      redirectUri: "http://127.0.0.1:9999/callback",
      clientId: "mcpc_test",
      codeVerifier: "verifier123",
    });

    expect(result.accessToken).toBe("mcp_access123");
    expect(result.refreshToken).toBe("mcpr_refresh456");
    expect(result.expiresIn).toBe(3600);
    expect(result.scope).toBe("credentials:list vault:status");
    expect(result.clientId).toBe("mcpc_test");

    // Verify request format
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://vault.example.com/api/mcp/token");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(opts.body).toContain("grant_type=authorization_code");
    expect(opts.body).toContain("code=auth_code");
    expect(opts.body).toContain("code_verifier=verifier123");
  });

  it("throws on non-ok response", async () => {
    const { exchangeCode } = await import("../../lib/oauth.js");
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => "invalid_grant",
    });

    await expect(
      exchangeCode("https://vault.example.com", {
        code: "bad_code",
        redirectUri: "http://127.0.0.1:9999/callback",
        clientId: "mcpc_test",
        codeVerifier: "verifier",
      }),
    ).rejects.toThrow("Token exchange failed (400)");
  });

  it("throws when response is missing access_token", async () => {
    const { exchangeCode } = await import("../../lib/oauth.js");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ refresh_token: "mcpr_r", expires_in: 3600 }),
    });

    await expect(
      exchangeCode("https://vault.example.com", {
        code: "code",
        redirectUri: "http://127.0.0.1:9999/callback",
        clientId: "mcpc_test",
        codeVerifier: "verifier",
      }),
    ).rejects.toThrow("Token response missing access_token");
  });

  it("defaults expires_in to 3600 when not a number", async () => {
    const { exchangeCode } = await import("../../lib/oauth.js");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "mcp_a",
        refresh_token: "mcpr_r",
        expires_in: "not_a_number",
        scope: "vault:status",
      }),
    });

    const result = await exchangeCode("https://vault.example.com", {
      code: "code",
      redirectUri: "http://127.0.0.1:9999/callback",
      clientId: "mcpc_test",
      codeVerifier: "verifier",
    });

    expect(result.expiresIn).toBe(3600);
  });
});
