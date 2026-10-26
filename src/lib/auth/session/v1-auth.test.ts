import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const {
  mockValidateApiKeyOnly,
  mockValidateServiceAccountToken,
  mockHasSaTokenScope,
} = vi.hoisted(() => ({
  mockValidateApiKeyOnly: vi.fn(),
  mockValidateServiceAccountToken: vi.fn(),
  mockHasSaTokenScope: vi.fn(),
}));

vi.mock("@/lib/auth/tokens/api-key", () => ({
  validateApiKeyOnly: mockValidateApiKeyOnly,
}));
vi.mock("@/lib/auth/tokens/service-account-token", () => ({
  validateServiceAccountToken: mockValidateServiceAccountToken,
  hasSaTokenScope: mockHasSaTokenScope,
}));
vi.mock("@/lib/constants/auth/service-account", () => ({
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

/** Helper: assert a failure result's ready-made response has this status + error code. */
async function expectFailureBody(
  result: { ok: false; response: NextResponse },
  status: number,
  error: string,
) {
  expect(result.response.status).toBe(status);
  await expect(result.response.json()).resolves.toEqual({ error });
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

  it("returns API_KEY_SCOPE_INSUFFICIENT 403 when API key scope is insufficient", async () => {
    mockValidateApiKeyOnly.mockResolvedValue({
      ok: false,
      error: "SCOPE_INSUFFICIENT",
      status: 403,
    });

    const result = await validateV1Auth(makeRequest("api_validtoken"), "passwords:write");

    expect(result.ok).toBe(false);
    if (!result.ok) await expectFailureBody(result, 403, "API_KEY_SCOPE_INSUFFICIENT");
    expect(mockValidateServiceAccountToken).not.toHaveBeenCalled();
  });

  it("returns PASSKEY_REQUIRED 403 and never falls through to the SA branch", async () => {
    mockValidateApiKeyOnly.mockResolvedValue({
      ok: false,
      error: "PASSKEY_REQUIRED",
      status: 403,
    });

    const result = await validateV1Auth(makeRequest("api_validtoken"), "passwords:read");

    expect(result.ok).toBe(false);
    if (!result.ok) await expectFailureBody(result, 403, "PASSKEY_REQUIRED");
    expect(mockValidateServiceAccountToken).not.toHaveBeenCalled();
  });

  // T-2: fail-closed propagation — a derivation error from validateApiKeyOnly
  // must not be swallowed (paired with the api_key success cell above).
  it("propagates a derivation error from validateApiKeyOnly rather than swallowing it", async () => {
    mockValidateApiKeyOnly.mockRejectedValue(new Error("derivation failed"));

    await expect(
      validateV1Auth(makeRequest("api_validtoken"), "passwords:read"),
    ).rejects.toThrow("derivation failed");
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

  it("returns API_KEY_SCOPE_INSUFFICIENT 403 when SA token scope is insufficient", async () => {
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

    expect(result.ok).toBe(false);
    if (!result.ok) await expectFailureBody(result, 403, "API_KEY_SCOPE_INSUFFICIENT");
  });

  it("returns UNAUTHORIZED 401 when no bearer token is present", async () => {
    mockValidateApiKeyOnly.mockResolvedValue({
      ok: false,
      error: "INVALID_TOKEN_TYPE",
      status: 401,
    });

    const result = await validateV1Auth(makeRequest(), "passwords:read");

    expect(result.ok).toBe(false);
    if (!result.ok) await expectFailureBody(result, 401, "UNAUTHORIZED");
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

    expect(result.ok).toBe(false);
    if (!result.ok) await expectFailureBody(result, 401, "UNAUTHORIZED");
    expect(mockValidateServiceAccountToken).not.toHaveBeenCalled();
  });
});
