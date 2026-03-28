import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockValidateApiKeyOnly,
  mockValidateServiceAccountToken,
  mockHasSaTokenScope,
} = vi.hoisted(() => ({
  mockValidateApiKeyOnly: vi.fn(),
  mockValidateServiceAccountToken: vi.fn(),
  mockHasSaTokenScope: vi.fn(),
}));

vi.mock("@/lib/api-key", () => ({
  validateApiKeyOnly: mockValidateApiKeyOnly,
}));
vi.mock("@/lib/service-account-token", () => ({
  validateServiceAccountToken: mockValidateServiceAccountToken,
  hasSaTokenScope: mockHasSaTokenScope,
}));
vi.mock("@/lib/constants/service-account", () => ({
  SA_TOKEN_PREFIX: "sa_",
}));

import { validateV1Auth } from "./v1-auth";

function makeRequest(bearerToken?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }
  return new NextRequest("http://localhost:3000/api/v1/passwords", { headers });
}

describe("validateV1Auth", () => {
  beforeEach(() => {
    mockValidateApiKeyOnly.mockReset();
    mockValidateServiceAccountToken.mockReset();
    mockHasSaTokenScope.mockReset();
  });

  it("returns ok with api_key actorType when API key is valid with required scope", async () => {
    mockValidateApiKeyOnly.mockResolvedValue({
      ok: true,
      data: {
        apiKeyId: "ak-1",
        userId: "user-1",
        tenantId: "tenant-1",
        scopes: ["passwords:read"],
      },
    });

    const result = await validateV1Auth(makeRequest("api_validtoken"), "passwords:read");

    expect(result).toEqual({
      ok: true,
      data: {
        userId: "user-1",
        tenantId: "tenant-1",
        rateLimitKey: "ak-1",
        actorType: "api_key",
      },
    });
    expect(mockValidateServiceAccountToken).not.toHaveBeenCalled();
  });

  it("returns SCOPE_INSUFFICIENT 403 when API key scope is insufficient", async () => {
    mockValidateApiKeyOnly.mockResolvedValue({
      ok: false,
      error: "SCOPE_INSUFFICIENT",
      status: 403,
    });

    const result = await validateV1Auth(makeRequest("api_validtoken"), "passwords:write");

    expect(result).toEqual({ ok: false, error: "SCOPE_INSUFFICIENT", status: 403 });
    expect(mockValidateServiceAccountToken).not.toHaveBeenCalled();
  });

  it("returns ok with service_account actorType when SA token is valid with required scope", async () => {
    mockValidateApiKeyOnly.mockResolvedValue({
      ok: false,
      error: "INVALID_TOKEN_TYPE",
      status: 401,
    });
    mockValidateServiceAccountToken.mockResolvedValue({
      ok: true,
      data: {
        tokenId: "tok-1",
        serviceAccountId: "sa-1",
        tenantId: "tenant-1",
        scopes: ["passwords:read"],
      },
    });
    mockHasSaTokenScope.mockReturnValue(true);

    const result = await validateV1Auth(makeRequest("sa_validtoken"), "passwords:read");

    expect(result).toEqual({
      ok: true,
      data: {
        userId: null,
        tenantId: "tenant-1",
        rateLimitKey: "sa-1",
        actorType: "service_account",
      },
    });
  });

  it("returns SCOPE_INSUFFICIENT 403 when SA token scope is insufficient", async () => {
    mockValidateApiKeyOnly.mockResolvedValue({
      ok: false,
      error: "INVALID_TOKEN_TYPE",
      status: 401,
    });
    mockValidateServiceAccountToken.mockResolvedValue({
      ok: true,
      data: {
        tokenId: "tok-2",
        serviceAccountId: "sa-2",
        tenantId: "tenant-2",
        scopes: ["passwords:read"],
      },
    });
    mockHasSaTokenScope.mockReturnValue(false);

    const result = await validateV1Auth(makeRequest("sa_validtoken"), "passwords:write");

    expect(result).toEqual({ ok: false, error: "SCOPE_INSUFFICIENT", status: 403 });
  });

  it("returns 401 when no bearer token is present", async () => {
    mockValidateApiKeyOnly.mockResolvedValue({
      ok: false,
      error: "INVALID_TOKEN_TYPE",
      status: 401,
    });

    const result = await validateV1Auth(makeRequest(), "passwords:read");

    expect(result).toEqual(expect.objectContaining({ ok: false, status: 401 }));
    expect(mockValidateServiceAccountToken).not.toHaveBeenCalled();
  });

  it("does not fall through to SA validation when API key has a non-INVALID_TOKEN_TYPE error", async () => {
    // api_ prefix token that fails (e.g., revoked) — should NOT try SA path
    mockValidateApiKeyOnly.mockResolvedValue({
      ok: false,
      error: "API_KEY_REVOKED",
      status: 401,
    });

    const result = await validateV1Auth(makeRequest("api_revokedtoken"), "passwords:read");

    expect(result).toEqual(expect.objectContaining({ ok: false, status: 401 }));
    expect(mockValidateServiceAccountToken).not.toHaveBeenCalled();
  });
});
