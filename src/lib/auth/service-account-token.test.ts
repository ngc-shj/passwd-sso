import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockPrisma, mockHashToken, mockWithBypassRls } = vi.hoisted(() => ({
  mockPrisma: {
    serviceAccountToken: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
  mockHashToken: vi.fn(),
  mockWithBypassRls: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/crypto/crypto-server", () => ({ hashToken: mockHashToken }));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));

import {
  validateServiceAccountToken,
  parseSaTokenScopes,
  hasSaTokenScope,
} from "./service-account-token";

function makeRequest(bearerToken?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }
  return new NextRequest("http://localhost:3000/api/test", { headers });
}

describe("parseSaTokenScopes", () => {
  it("parses valid scopes from CSV", () => {
    expect(parseSaTokenScopes("passwords:read,tags:read")).toEqual([
      "passwords:read",
      "tags:read",
    ]);
  });

  it("drops unknown scopes", () => {
    expect(parseSaTokenScopes("passwords:read,unknown:scope,tags:read")).toEqual([
      "passwords:read",
      "tags:read",
    ]);
  });

  it("returns empty array for empty string", () => {
    expect(parseSaTokenScopes("")).toEqual([]);
  });

  it("trims whitespace", () => {
    expect(parseSaTokenScopes(" passwords:read , tags:read ")).toEqual([
      "passwords:read",
      "tags:read",
    ]);
  });
});

describe("hasSaTokenScope", () => {
  it("returns true when scope is present", () => {
    expect(hasSaTokenScope(["passwords:read", "tags:read"], "tags:read")).toBe(true);
  });

  it("returns false when scope is absent", () => {
    expect(hasSaTokenScope(["passwords:read"], "tags:read")).toBe(false);
  });
});

describe("validateServiceAccountToken", () => {
  const TENANT_ID = "tenant-1";
  const SA_ID = "sa-1";
  const TOKEN_ID = "token-1";

  beforeEach(() => {
    vi.clearAllMocks();
    mockHashToken.mockReturnValue("hashed_token");
    mockWithBypassRls.mockImplementation((_p: unknown, fn: () => unknown) => fn());
  });

  it("returns INVALID_TOKEN_TYPE when no Authorization header", async () => {
    const result = await validateServiceAccountToken(makeRequest());
    expect(result).toEqual({ ok: false, error: "INVALID_TOKEN_TYPE" });
  });

  it("returns INVALID_TOKEN_TYPE when token lacks sa_ prefix", async () => {
    const result = await validateServiceAccountToken(makeRequest("api_test123"));
    expect(result).toEqual({ ok: false, error: "INVALID_TOKEN_TYPE" });
  });

  it("returns SA_TOKEN_INVALID when token not found in DB", async () => {
    mockPrisma.serviceAccountToken.findUnique.mockResolvedValue(null);

    const result = await validateServiceAccountToken(makeRequest("sa_test123"));
    expect(result).toEqual({ ok: false, error: "SA_TOKEN_INVALID" });
  });

  it("returns SA_TOKEN_REVOKED when token is revoked", async () => {
    mockPrisma.serviceAccountToken.findUnique.mockResolvedValue({
      id: TOKEN_ID,
      serviceAccountId: SA_ID,
      tenantId: TENANT_ID,
      scope: "passwords:read",
      expiresAt: new Date(Date.now() + 86400000),
      revokedAt: new Date(),
      lastUsedAt: null,
      serviceAccount: { isActive: true },
    });

    const result = await validateServiceAccountToken(makeRequest("sa_test123"));
    expect(result).toEqual({ ok: false, error: "SA_TOKEN_REVOKED" });
  });

  it("returns SA_TOKEN_EXPIRED when token is expired", async () => {
    mockPrisma.serviceAccountToken.findUnique.mockResolvedValue({
      id: TOKEN_ID,
      serviceAccountId: SA_ID,
      tenantId: TENANT_ID,
      scope: "passwords:read",
      expiresAt: new Date(Date.now() - 1000),
      revokedAt: null,
      lastUsedAt: null,
      serviceAccount: { isActive: true },
    });

    const result = await validateServiceAccountToken(makeRequest("sa_test123"));
    expect(result).toEqual({ ok: false, error: "SA_TOKEN_EXPIRED" });
  });

  it("returns SA_INACTIVE when parent service account is inactive", async () => {
    mockPrisma.serviceAccountToken.findUnique.mockResolvedValue({
      id: TOKEN_ID,
      serviceAccountId: SA_ID,
      tenantId: TENANT_ID,
      scope: "passwords:read",
      expiresAt: new Date(Date.now() + 86400000),
      revokedAt: null,
      lastUsedAt: null,
      serviceAccount: { isActive: false },
    });

    const result = await validateServiceAccountToken(makeRequest("sa_test123"));
    expect(result).toEqual({ ok: false, error: "SA_INACTIVE" });
  });

  it("returns valid result for a valid token", async () => {
    mockPrisma.serviceAccountToken.findUnique.mockResolvedValue({
      id: TOKEN_ID,
      serviceAccountId: SA_ID,
      tenantId: TENANT_ID,
      scope: "passwords:read,tags:read",
      expiresAt: new Date(Date.now() + 86400000),
      revokedAt: null,
      lastUsedAt: null,
      serviceAccount: { isActive: true },
    });
    mockPrisma.serviceAccountToken.update.mockResolvedValue({});

    const result = await validateServiceAccountToken(makeRequest("sa_test123"));
    expect(result).toEqual({
      ok: true,
      data: {
        tokenId: TOKEN_ID,
        serviceAccountId: SA_ID,
        tenantId: TENANT_ID,
        scopes: ["passwords:read", "tags:read"],
      },
    });
  });

  it("throttles lastUsedAt update when recently used", async () => {
    mockPrisma.serviceAccountToken.findUnique.mockResolvedValue({
      id: TOKEN_ID,
      serviceAccountId: SA_ID,
      tenantId: TENANT_ID,
      scope: "passwords:read",
      expiresAt: new Date(Date.now() + 86400000),
      revokedAt: null,
      lastUsedAt: new Date(), // just now
      serviceAccount: { isActive: true },
    });

    const result = await validateServiceAccountToken(makeRequest("sa_test123"));
    expect(result.ok).toBe(true);
    expect(mockPrisma.serviceAccountToken.update).not.toHaveBeenCalled();
  });
});
