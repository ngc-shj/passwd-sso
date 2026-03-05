import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockAuth, mockValidateExtensionToken, mockHasScope, mockValidateApiKey, mockHasApiKeyScope } = vi.hoisted(
  () => ({
    mockAuth: vi.fn(),
    mockValidateExtensionToken: vi.fn(),
    mockHasScope: vi.fn(),
    mockValidateApiKey: vi.fn(),
    mockHasApiKeyScope: vi.fn(),
  }),
);

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/extension-token", () => ({
  validateExtensionToken: mockValidateExtensionToken,
  hasScope: mockHasScope,
}));
vi.mock("@/lib/api-key", () => ({
  validateApiKey: mockValidateApiKey,
  hasApiKeyScope: mockHasApiKeyScope,
}));
vi.mock("@/lib/constants/api-key", () => ({
  API_KEY_PREFIX: "api_",
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

    const result = await authOrToken(makeRequest());
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
      makeRequest(),
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
      makeRequest(),
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

  it("dispatches to extension token when Bearer lacks api_ prefix", async () => {
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
  });
});
