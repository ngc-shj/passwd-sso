import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config
vi.mock("../../lib/config.js", () => ({
  loadConfig: () => ({ serverUrl: "https://test.example.com", locale: "en" }),
  loadToken: vi.fn(),
  saveToken: vi.fn(),
  saveConfig: vi.fn(),
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

const { apiRequest, setTokenCache, clearTokenCache } = await import("../../lib/api-client.js");
const { loadToken, saveToken, saveConfig } = await import("../../lib/config.js");

describe("apiRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearTokenCache();
    setTokenCache("test-token-123");
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

  it("throws when not logged in", async () => {
    clearTokenCache();
    (loadToken as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await expect(apiRequest("/api/test")).rejects.toThrow("Not logged in");
  });

  it("attempts token refresh on 401", async () => {
    // First call returns 401
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: "UNAUTHORIZED" }),
    });
    // Refresh call
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ token: "new-token", expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString() }),
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
    // Verify the retry used the new token
    const retryCall = mockFetch.mock.calls[2];
    expect(retryCall[1].headers.Authorization).toBe("Bearer new-token");

    // Verify token and config were persisted
    expect(saveToken).toHaveBeenCalledWith("new-token");
    expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({
      tokenExpiresAt: expect.any(String),
    }));
  });

  it("returns 401 response when refresh also fails", async () => {
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
    const soonExpiry = new Date(Date.now() + 60 * 1000).toISOString();
    setTokenCache("old-token", soonExpiry);

    // Refresh call
    const newExpiry = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ token: "refreshed-token", expiresAt: newExpiry }),
    });
    // Actual API call with refreshed token
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: "ok" }),
    });

    const res = await apiRequest("/api/test");
    expect(res.ok).toBe(true);
    // Verify the actual request used the refreshed token
    const actualCall = mockFetch.mock.calls[1];
    expect(actualCall[1].headers.Authorization).toBe("Bearer refreshed-token");

    // Verify token and config were persisted
    expect(saveToken).toHaveBeenCalledWith("refreshed-token");
    expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({
      tokenExpiresAt: expect.any(String),
    }));
  });
});
