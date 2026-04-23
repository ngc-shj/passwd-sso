import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockAuth,
  mockValidateExtensionToken,
  mockValidateApiKey,
  mockValidateServiceAccountToken,
  mockValidateMcpToken,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockValidateExtensionToken: vi.fn(),
  mockValidateApiKey: vi.fn(),
  mockValidateServiceAccountToken: vi.fn(),
  mockValidateMcpToken: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/auth/extension-token", () => ({
  validateExtensionToken: mockValidateExtensionToken,
  hasScope: vi.fn().mockReturnValue(true),
}));
vi.mock("@/lib/auth/api-key", () => ({
  validateApiKey: mockValidateApiKey,
  hasApiKeyScope: vi.fn().mockReturnValue(true),
}));
vi.mock("@/lib/auth/service-account-token", () => ({
  validateServiceAccountToken: mockValidateServiceAccountToken,
  hasSaTokenScope: vi.fn().mockReturnValue(true),
}));
vi.mock("@/lib/mcp/oauth-server", () => ({
  validateMcpToken: mockValidateMcpToken,
}));

import { authOrToken, hasMcpScope } from "@/lib/auth-or-token";
import { MCP_TOKEN_PREFIX } from "@/lib/constants/mcp";

function makeRequest(token?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (token) headers["authorization"] = `Bearer ${token}`;
  return new NextRequest("http://localhost/api/test", { headers });
}

describe("KNOWN_PREFIXES includes MCP_TOKEN_PREFIX", () => {
  it("MCP_TOKEN_PREFIX starts with 'mcp_'", () => {
    expect(MCP_TOKEN_PREFIX).toBe("mcp_");
  });

  it("mcp_ prefix does not fall through to extension token validator", async () => {
    mockAuth.mockResolvedValue(null);
    mockValidateMcpToken.mockResolvedValue({ ok: false, error: "invalid_token" });

    const req = makeRequest("mcp_invalid_token");
    await authOrToken(req);

    expect(mockValidateMcpToken).toHaveBeenCalledWith("mcp_invalid_token");
    expect(mockValidateExtensionToken).not.toHaveBeenCalled();
  });
});

describe("authOrToken mcp_token dispatch", () => {
  beforeEach(() => {
    mockAuth.mockResolvedValue(null);
  });

  it("returns mcp_token auth result for valid mcp_ token", async () => {
    mockValidateMcpToken.mockResolvedValue({
      ok: true,
      data: {
        tokenId: "tok-1",
        tenantId: "tenant-1",
        clientId: "internal-uuid",
        mcpClientId: "mcpc_abc",
        userId: "user-1",
        serviceAccountId: null,
        scopes: ["credentials:list"],
      },
    });

    const req = makeRequest("mcp_validtoken");
    const result = await authOrToken(req);

    expect(result).toEqual({
      type: "mcp_token",
      userId: "user-1",
      tenantId: "tenant-1",
      tokenId: "tok-1",
      mcpClientId: "mcpc_abc",
      scopes: ["credentials:list"],
    });
  });

  it("returns mcp_token with userId null for SA OAuth", async () => {
    mockValidateMcpToken.mockResolvedValue({
      ok: true,
      data: {
        tokenId: "tok-2",
        tenantId: "tenant-1",
        clientId: "internal-uuid",
        mcpClientId: "mcpc_xyz",
        userId: null,
        serviceAccountId: "sa-1",
        scopes: ["credentials:list"],
      },
    });

    const req = makeRequest("mcp_satoken");
    const result = await authOrToken(req);

    expect(result).toMatchObject({
      type: "mcp_token",
      userId: null,
      tenantId: "tenant-1",
    });
  });

  it("returns null for invalid mcp_ token", async () => {
    mockValidateMcpToken.mockResolvedValue({ ok: false, error: "invalid_token" });

    const req = makeRequest("mcp_badtoken");
    const result = await authOrToken(req);

    expect(result).toBeNull();
  });

  it("returns scope_insufficient when MCP token lacks required scope", async () => {
    const { hasMcpScope: _hasMcpScope } = await import("@/lib/auth-or-token");
    // Override hasScope check by mocking hasMcpScope indirectly via the module
    mockValidateMcpToken.mockResolvedValue({
      ok: true,
      data: {
        tokenId: "tok-3",
        tenantId: "tenant-1",
        clientId: "internal-uuid",
        mcpClientId: "mcpc_abc",
        userId: "user-1",
        serviceAccountId: null,
        scopes: [],
      },
    });

    const req = makeRequest("mcp_limitedtoken");
    const result = await authOrToken(req, "passwords:read" as never);

    expect(result).toEqual({ type: "scope_insufficient" });
  });

  it("coexists with api_ prefix dispatch", async () => {
    mockValidateApiKey.mockResolvedValue({
      ok: true,
      data: {
        userId: "user-2",
        tenantId: "tenant-2",
        apiKeyId: "ak-1",
        scopes: ["passwords:read"],
      },
    });

    const req = makeRequest("api_validkey");
    const result = await authOrToken(req);

    expect(result).toMatchObject({ type: "api_key", userId: "user-2" });
    expect(mockValidateMcpToken).not.toHaveBeenCalled();
  });

  it("coexists with sa_ prefix dispatch", async () => {
    mockValidateServiceAccountToken.mockResolvedValue({
      ok: true,
      data: {
        serviceAccountId: "sa-1",
        tenantId: "tenant-1",
        tokenId: "tok-sa",
        scopes: ["passwords:read"],
      },
    });

    const req = makeRequest("sa_validtoken");
    const result = await authOrToken(req);

    expect(result).toMatchObject({ type: "service_account" });
    expect(mockValidateMcpToken).not.toHaveBeenCalled();
  });
});

describe("hasMcpScope", () => {
  it("returns true when scope is present", () => {
    expect(hasMcpScope(["credentials:list", "vault:status"] as never[], "credentials:list" as never)).toBe(true);
  });

  it("returns false when scope is absent", () => {
    expect(hasMcpScope(["credentials:list"] as never[], "vault:unlock-data" as never)).toBe(false);
  });

  it("returns false for empty scopes", () => {
    expect(hasMcpScope([], "credentials:list" as never)).toBe(false);
  });
});
