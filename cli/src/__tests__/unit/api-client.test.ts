import { describe, it, expect, vi, beforeEach } from "vitest";
import { MS_PER_MINUTE, MS_PER_HOUR } from "../../lib/time.js";

// Mock config
vi.mock("../../lib/config.js", () => ({
  // Deliberately different from the credential server: tokens must never go here.
  loadConfig: () => ({ serverUrl: "https://config.example.com", locale: "en" }),
  loadCredentials: vi.fn(),
  saveCredentials: vi.fn(),
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

const { apiRequest, setTokenCache, clearTokenCache, assertLoggedIn, getTokenServerUrl } = await import("../../lib/api-client.js");
const { loadCredentials, saveCredentials } = await import("../../lib/config.js");

describe("assertLoggedIn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearTokenCache();
  });

  it("throws 'Not logged in' when no token exists", () => {
    (loadCredentials as ReturnType<typeof vi.fn>).mockReturnValue(null);

    expect(() => assertLoggedIn()).toThrow("Not logged in. Run `passwd-sso login` first.");
  });

  it("does not throw when a token is cached", () => {
    setTokenCache("test-token-123", "https://test.example.com");

    expect(() => assertLoggedIn()).not.toThrow();
  });
});

describe("apiRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearTokenCache();
    setTokenCache("test-token-123", "https://test.example.com");
  });

  it("sends GET request with Bearer token", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: "test" }),
    });

    const res = await apiRequest("/api/vault/status");
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ data: "test" });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://test.example.com/api/vault/status",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer test-token-123",
        }),
      }),
    );
  });

  it("sends POST request with body", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    });

    const res = await apiRequest("/api/passwords", {
      method: "POST",
      body: { title: "Test" },
    });
    expect(res.ok).toBe(true);

    const fetchCall = mockFetch.mock.calls[0];
    expect(fetchCall[1].body).toBe(JSON.stringify({ title: "Test" }));
  });

  it("reports a refused redirect with the server and the fix, not a bare fetch failure", async () => {
    mockFetch.mockRejectedValueOnce(
      new TypeError("fetch failed", { cause: new Error("unexpected redirect") }),
    );

    await expect(apiRequest("/api/vault/status")).rejects.toThrow(
      "The server at https://test.example.com redirected the request",
    );
  });

  it("throws when not logged in", async () => {
    clearTokenCache();
    (loadCredentials as ReturnType<typeof vi.fn>).mockReturnValue(null);

    await expect(apiRequest("/api/test")).rejects.toThrow("Not logged in");
  });

  it("attempts token refresh on 401 via OAuth refresh_token grant", async () => {
    // Set up OAuth credentials with refresh token
    clearTokenCache();
    setTokenCache("old-token", "https://test.example.com", new Date(Date.now() + MS_PER_HOUR).toISOString(), "mcpr_refresh123", "mcpc_client123");

    // First call returns 401
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: "UNAUTHORIZED" }),
    });
    // OAuth refresh call: POST /api/mcp/token with grant_type=refresh_token
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "mcp_new_access",
        refresh_token: "mcpr_new_refresh",
        expires_in: 3600,
        scope: "credentials:list credentials:use",
      }),
    });
    // Retry call after refresh
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: "success" }),
    });

    const res = await apiRequest("/api/test");
    expect(res.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(3);

    // Verify the refresh call hit OAuth token endpoint with correct params
    const refreshCall = mockFetch.mock.calls[1];
    expect(refreshCall[0]).toBe("https://test.example.com/api/mcp/token");
    expect(refreshCall[1].method).toBe("POST");
    expect(refreshCall[1].headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(refreshCall[1].body).toContain("grant_type=refresh_token");
    expect(refreshCall[1].body).toContain("refresh_token=mcpr_refresh123");
    expect(refreshCall[1].body).toContain("client_id=mcpc_client123");

    // Verify the retry used the new access token
    const retryCall = mockFetch.mock.calls[2];
    expect(retryCall[1].headers.Authorization).toBe("Bearer mcp_new_access");

    // Verify credentials were persisted with all 4 fields
    expect(saveCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "mcp_new_access",
        refreshToken: "mcpr_new_refresh",
        clientId: "mcpc_client123",
        expiresAt: expect.any(String),
        serverUrl: "https://test.example.com",
      }),
    );
  });

  it("returns 401 response when refresh also fails", async () => {
    clearTokenCache();
    setTokenCache("old-token", "https://test.example.com", new Date(Date.now() + MS_PER_HOUR).toISOString(), "mcpr_refresh", "mcpc_client");

    // First call: 401
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: "UNAUTHORIZED" }),
    });
    // Refresh call: also fails
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: "REFRESH_FAILED" }),
    });

    const res = await apiRequest("/api/test");
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("proactively refreshes when token is expiring soon", async () => {
    clearTokenCache();
    // Set token with expiresAt within the 2-min refresh buffer
    const soonExpiry = new Date(Date.now() + MS_PER_MINUTE).toISOString();
    setTokenCache("old-token", "https://test.example.com", soonExpiry, "mcpr_refresh_old", "mcpc_client123");

    // Refresh call: OAuth token endpoint
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "mcp_refreshed",
        refresh_token: "mcpr_refreshed",
        expires_in: 3600,
        scope: "credentials:list",
      }),
    });
    // Actual API call with refreshed token
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: "ok" }),
    });

    const res = await apiRequest("/api/test");
    expect(res.ok).toBe(true);
    // Verify the refresh call sent the correct refresh_token
    const proactiveRefreshCall = mockFetch.mock.calls[0];
    expect(proactiveRefreshCall[0]).toBe("https://test.example.com/api/mcp/token");
    expect(proactiveRefreshCall[1].body).toContain("refresh_token=mcpr_refresh_old");
    // Verify the actual request used the refreshed token
    const actualCall = mockFetch.mock.calls[1];
    expect(actualCall[1].headers.Authorization).toBe("Bearer mcp_refreshed");

    // Verify credentials were persisted with all 4 fields
    expect(saveCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "mcp_refreshed",
        refreshToken: "mcpr_refreshed",
        clientId: "mcpc_client123",
        expiresAt: expect.any(String),
        serverUrl: "https://test.example.com",
      }),
    );
  });

  it("skips refresh when no refresh token cached (--token login)", async () => {
    clearTokenCache();
    // Manual token login: no refresh token
    setTokenCache("manual-token", "https://test.example.com", new Date(Date.now() + MS_PER_MINUTE).toISOString());

    // API call returns 401
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: "UNAUTHORIZED" }),
    });

    const res = await apiRequest("/api/test");
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
    // No refresh attempt — only the original call
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("tokens are bound to the issuing server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearTokenCache();
  });

  it("apiRequest targets the credential server, not config.serverUrl", async () => {
    setTokenCache("tok", "https://issuer.example.com");
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });

    await apiRequest("/api/vault/status");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe("https://issuer.example.com/api/vault/status");
  });

  it("the refresh grant goes to the credential server and re-saves its serverUrl", async () => {
    setTokenCache(
      "old",
      "https://issuer.example.com",
      new Date(Date.now() + MS_PER_MINUTE).toISOString(),
      "mcpr_r",
      "mcpc_c",
    );
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "new", refresh_token: "mcpr_n", expires_in: 3600, scope: "" }),
    });
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });

    await apiRequest("/api/test");

    expect(mockFetch.mock.calls[0][0]).toBe("https://issuer.example.com/api/mcp/token");
    expect(mockFetch.mock.calls[1][0]).toBe("https://issuer.example.com/api/test");
    expect(saveCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ serverUrl: "https://issuer.example.com" }),
    );
    for (const call of mockFetch.mock.calls) {
      expect(String(call[0])).not.toContain("config.example.com");
    }
  });

  it("getTokenServerUrl returns the server recorded in loaded credentials", () => {
    (loadCredentials as ReturnType<typeof vi.fn>).mockReturnValue({
      accessToken: "t",
      refreshToken: "",
      clientId: "",
      expiresAt: new Date(Date.now() + MS_PER_HOUR).toISOString(),
      serverUrl: "https://stored.example.com",
    });

    expect(getTokenServerUrl()).toBe("https://stored.example.com");
  });

  it("getTokenServerUrl throws when not logged in", () => {
    (loadCredentials as ReturnType<typeof vi.fn>).mockReturnValue(null);

    expect(() => getTokenServerUrl()).toThrow("Not logged in");
  });
});
