import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockAuth, mockValidateExtensionToken, mockHasScope,
  mockValidateApiKey, mockHasApiKeyScope,
  mockValidateServiceAccountToken, mockHasSaTokenScope,
} = vi.hoisted(
  () => ({
    mockAuth: vi.fn(),
    mockValidateExtensionToken: vi.fn(),
    mockHasScope: vi.fn(),
    mockValidateApiKey: vi.fn(),
    mockHasApiKeyScope: vi.fn(),
    mockValidateServiceAccountToken: vi.fn(),
    mockHasSaTokenScope: vi.fn(),
  }),
);

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/auth/tokens/extension-token", () => ({
  validateExtensionToken: mockValidateExtensionToken,
  hasScope: mockHasScope,
}));
vi.mock("@/lib/auth/tokens/api-key", () => ({
  validateApiKey: mockValidateApiKey,
  hasApiKeyScope: mockHasApiKeyScope,
}));
vi.mock("@/lib/auth/tokens/service-account-token", () => ({
  validateServiceAccountToken: mockValidateServiceAccountToken,
  hasSaTokenScope: mockHasSaTokenScope,
}));
vi.mock("@/lib/constants/auth/api-key", () => ({
  API_KEY_PREFIX: "api_",
}));
vi.mock("@/lib/constants/auth/service-account", () => ({
  SA_TOKEN_PREFIX: "sa_",
}));

import { authOrToken } from "./auth-or-token";

function makeRequest(bearerToken?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }
  return new NextRequest("http://localhost:3000/api/test", { headers });
}

describe("authOrToken", () => {
  beforeEach(() => {
    mockAuth.mockReset();
    mockValidateExtensionToken.mockReset();
    mockHasScope.mockReset();
    mockValidateApiKey.mockReset();
    mockHasApiKeyScope.mockReset();
    mockValidateServiceAccountToken.mockReset();
    mockHasSaTokenScope.mockReset();
  });

  it("returns session result when session is valid", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });

    const result = await authOrToken(makeRequest());
    expect(result).toEqual({ type: "session", userId: "user-1" });
    expect(mockValidateExtensionToken).not.toHaveBeenCalled();
  });

  it("falls back to extension token when session is absent", async () => {
    mockAuth.mockResolvedValue(null);
    mockValidateExtensionToken.mockResolvedValue({
      ok: true,
      data: { userId: "user-2", scopes: ["passwords:read"] },
    });

    const result = await authOrToken(makeRequest("abcdef1234567890"));
    expect(result).toEqual({
      type: "token",
      userId: "user-2",
      scopes: ["passwords:read"],
    });
  });

  it("returns null when both session and token fail", async () => {
    mockAuth.mockResolvedValue(null);
    mockValidateExtensionToken.mockResolvedValue({ ok: false });

    const result = await authOrToken(makeRequest());
    expect(result).toBeNull();
  });

  it("returns scope_insufficient when token lacks required scope", async () => {
    mockAuth.mockResolvedValue(null);
    mockValidateExtensionToken.mockResolvedValue({
      ok: true,
      data: { userId: "user-3", scopes: ["passwords:read"] },
    });
    mockHasScope.mockReturnValue(false);

    const result = await authOrToken(
      makeRequest("abcdef1234567890"),
      "passwords:write" as Parameters<typeof authOrToken>[1],
    );
    expect(result).toEqual({ type: "scope_insufficient" });
  });

  it("returns token result when required scope is met", async () => {
    mockAuth.mockResolvedValue(null);
    mockValidateExtensionToken.mockResolvedValue({
      ok: true,
      data: { userId: "user-4", scopes: ["passwords:write"] },
    });
    mockHasScope.mockReturnValue(true);

    const result = await authOrToken(
      makeRequest("abcdef1234567890"),
      "passwords:write" as Parameters<typeof authOrToken>[1],
    );
    expect(result).toEqual({
      type: "token",
      userId: "user-4",
      scopes: ["passwords:write"],
    });
  });

  it("session auth always passes regardless of requiredScope", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-5" } });

    const result = await authOrToken(
      makeRequest(),
      "passwords:write" as Parameters<typeof authOrToken>[1],
    );
    expect(result).toEqual({ type: "session", userId: "user-5" });
    expect(mockHasScope).not.toHaveBeenCalled();
  });

  // ── API key path tests ────────────────────────────────────

  it("returns api_key result for valid API key", async () => {
    mockAuth.mockResolvedValue(null);
    mockValidateApiKey.mockResolvedValue({
      ok: true,
      data: {
        userId: "u1",
        tenantId: "t1",
        apiKeyId: "ak1",
        scopes: ["passwords:read"],
      },
    });

    const result = await authOrToken(makeRequest("api_test123"));
    expect(result).toEqual({
      type: "api_key",
      userId: "u1",
      tenantId: "t1",
      apiKeyId: "ak1",
      scopes: ["passwords:read"],
    });
    expect(mockValidateExtensionToken).not.toHaveBeenCalled();
  });

  it("returns null when API key validation fails", async () => {
    mockAuth.mockResolvedValue(null);
    mockValidateApiKey.mockResolvedValue({ ok: false, error: "API_KEY_INVALID" });

    const result = await authOrToken(makeRequest("api_invalid"));
    expect(result).toBeNull();
    expect(mockValidateExtensionToken).not.toHaveBeenCalled();
  });

  it("returns scope_insufficient when API key lacks required scope", async () => {
    mockAuth.mockResolvedValue(null);
    mockValidateApiKey.mockResolvedValue({
      ok: true,
      data: {
        userId: "u2",
        tenantId: "t2",
        apiKeyId: "ak2",
        scopes: ["passwords:read"],
      },
    });
    mockHasApiKeyScope.mockReturnValue(false);

    const result = await authOrToken(
      makeRequest("api_test456"),
      "passwords:write" as Parameters<typeof authOrToken>[1],
    );
    expect(result).toEqual({ type: "scope_insufficient" });
  });

  it("dispatches to extension token when Bearer lacks known prefix", async () => {
    mockAuth.mockResolvedValue(null);
    mockValidateExtensionToken.mockResolvedValue({
      ok: true,
      data: { userId: "u3", scopes: ["passwords:read"] },
    });

    const result = await authOrToken(makeRequest("ext_token_123"));
    expect(result).toEqual({
      type: "token",
      userId: "u3",
      scopes: ["passwords:read"],
    });
    expect(mockValidateApiKey).not.toHaveBeenCalled();
    expect(mockValidateServiceAccountToken).not.toHaveBeenCalled();
  });

  // ── Service account token path tests ──────────────────────

  it("returns service_account result for valid SA token", async () => {
    mockAuth.mockResolvedValue(null);
    mockValidateServiceAccountToken.mockResolvedValue({
      ok: true,
      data: {
        serviceAccountId: "sa-1",
        tenantId: "t1",
        tokenId: "tok-1",
        scopes: ["passwords:read"],
      },
    });

    const result = await authOrToken(makeRequest("sa_test123"));
    expect(result).toEqual({
      type: "service_account",
      serviceAccountId: "sa-1",
      tenantId: "t1",
      tokenId: "tok-1",
      scopes: ["passwords:read"],
    });
    expect(mockValidateApiKey).not.toHaveBeenCalled();
    expect(mockValidateExtensionToken).not.toHaveBeenCalled();
  });

  it("returns null when SA token validation fails", async () => {
    mockAuth.mockResolvedValue(null);
    mockValidateServiceAccountToken.mockResolvedValue({
      ok: false,
      error: "SA_TOKEN_INVALID",
    });

    const result = await authOrToken(makeRequest("sa_invalid"));
    expect(result).toBeNull();
    expect(mockValidateExtensionToken).not.toHaveBeenCalled();
  });

  it("returns scope_insufficient when SA token lacks required scope", async () => {
    mockAuth.mockResolvedValue(null);
    mockValidateServiceAccountToken.mockResolvedValue({
      ok: true,
      data: {
        serviceAccountId: "sa-2",
        tenantId: "t2",
        tokenId: "tok-2",
        scopes: ["passwords:read"],
      },
    });
    mockHasSaTokenScope.mockReturnValue(false);

    const result = await authOrToken(
      makeRequest("sa_test456"),
      "passwords:write" as Parameters<typeof authOrToken>[1],
    );
    expect(result).toEqual({ type: "scope_insufficient" });
    expect(mockHasSaTokenScope).toHaveBeenCalledWith(["passwords:read"], "passwords:write");
  });

  it("returns service_account result when SA token scope is satisfied", async () => {
    mockAuth.mockResolvedValue(null);
    mockValidateServiceAccountToken.mockResolvedValue({
      ok: true,
      data: {
        serviceAccountId: "sa-3",
        tenantId: "t3",
        tokenId: "tok-3",
        scopes: ["passwords:read"],
      },
    });
    mockHasSaTokenScope.mockReturnValue(true);

    const result = await authOrToken(
      makeRequest("sa_test789"),
      "passwords:read" as Parameters<typeof authOrToken>[1],
    );
    expect(result).toEqual({
      type: "service_account",
      serviceAccountId: "sa-3",
      tenantId: "t3",
      tokenId: "tok-3",
      scopes: ["passwords:read"],
    });
    expect(mockHasSaTokenScope).toHaveBeenCalledWith(["passwords:read"], "passwords:read");
  });

  // ── Prefix table safety tests ──────────────────────────────

  it("returns null for scim_ prefixed tokens (handled by dedicated routes)", async () => {
    mockAuth.mockResolvedValue(null);

    const result = await authOrToken(makeRequest("scim_test123"));
    expect(result).toBeNull();
    expect(mockValidateApiKey).not.toHaveBeenCalled();
    expect(mockValidateServiceAccountToken).not.toHaveBeenCalled();
    expect(mockValidateExtensionToken).not.toHaveBeenCalled();
  });

  it("returns null when no Bearer token and no session", async () => {
    mockAuth.mockResolvedValue(null);

    const result = await authOrToken(makeRequest());
    expect(result).toBeNull();
  });
});
