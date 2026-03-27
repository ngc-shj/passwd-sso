import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  computeS256Challenge,
  verifyPkceS256,
  createAuthorizationCode,
  exchangeCodeForToken,
  validateMcpToken,
} from "./oauth-server";

// ─── Mock Prisma ──────────────────────────────────────────────

vi.mock("@/lib/prisma", () => ({
  prisma: {},
}));

vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: vi.fn(async (_prisma, fn) => fn()),
}));

vi.mock("@/lib/crypto-server", () => ({
  hashToken: vi.fn((token: string) => `hashed:${token}`),
}));

// ─── PKCE tests ───────────────────────────────────────────────

describe("computeS256Challenge", () => {
  it("returns base64url-encoded SHA-256 of verifier", () => {
    // Known test vector from RFC 7636
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = computeS256Challenge(verifier);
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("produces different challenges for different verifiers", () => {
    const a = computeS256Challenge("verifier-a");
    const b = computeS256Challenge("verifier-b");
    expect(a).not.toBe(b);
  });
});

describe("verifyPkceS256", () => {
  it("returns true when challenge matches verifier", () => {
    const verifier = "my-secret-verifier-string-that-is-long-enough";
    const challenge = computeS256Challenge(verifier);
    expect(verifyPkceS256(challenge, verifier)).toBe(true);
  });

  it("returns false when verifier is wrong", () => {
    const verifier = "correct-verifier";
    const challenge = computeS256Challenge(verifier);
    expect(verifyPkceS256(challenge, "wrong-verifier")).toBe(false);
  });

  it("returns false when challenge is tampered", () => {
    const verifier = "some-verifier";
    const tampered = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    expect(verifyPkceS256(tampered, verifier)).toBe(false);
  });

  it("returns false when lengths differ", () => {
    expect(verifyPkceS256("short", "verifier")).toBe(false);
  });
});

// ─── createAuthorizationCode tests ───────────────────────────

describe("createAuthorizationCode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates an authorization code and returns plaintext + expiry", async () => {
    const { prisma } = await import("@/lib/prisma");
    const mockCreate = vi.fn().mockResolvedValue({ id: "code-uuid" });
    (prisma as Record<string, unknown>).mcpAuthorizationCode = { create: mockCreate };

    const result = await createAuthorizationCode({
      clientId: "client-uuid",
      tenantId: "tenant-uuid",
      userId: "user-uuid",
      redirectUri: "https://example.com/callback",
      scope: "credentials:read",
      codeChallenge: "challenge",
    });

    expect(result.code).toBeTruthy();
    expect(typeof result.code).toBe("string");
    expect(result.expiresAt).toBeInstanceOf(Date);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(mockCreate).toHaveBeenCalledOnce();
  });
});

// ─── exchangeCodeForToken tests ───────────────────────────────

describe("exchangeCodeForToken", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { prisma } = await import("@/lib/prisma");
    // Provide $transaction that passes prisma itself as the tx argument
    (prisma as Record<string, unknown>).$transaction = async (fn: (tx: unknown) => unknown) =>
      fn(prisma);
  });

  it("returns invalid_grant when code not found", async () => {
    const { prisma } = await import("@/lib/prisma");
    (prisma as Record<string, unknown>).mcpAuthorizationCode = {
      findUnique: vi.fn().mockResolvedValue(null),
    };

    const result = await exchangeCodeForToken({
      code: "nonexistent-code",
      clientId: "mcpc_test",
      clientSecretHash: "hashed:secret",
      redirectUri: "https://example.com/callback",
      codeVerifier: "verifier",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_grant");
  });

  it("returns invalid_grant when code is already used", async () => {
    const { prisma } = await import("@/lib/prisma");
    (prisma as Record<string, unknown>).mcpAuthorizationCode = {
      findUnique: vi.fn().mockResolvedValue({
        id: "code-id",
        usedAt: new Date(),
        expiresAt: new Date(Date.now() + 60000),
        mcpClient: { clientId: "mcpc_test", clientSecretHash: "hashed:secret", isActive: true },
        clientId: "client-uuid",
        tenantId: "tenant-uuid",
        userId: "user-uuid",
        serviceAccountId: null,
        redirectUri: "https://example.com/callback",
        codeChallenge: "challenge",
        codeChallengeMethod: "S256",
        scope: "credentials:read",
      }),
    };

    const result = await exchangeCodeForToken({
      code: "used-code",
      clientId: "mcpc_test",
      clientSecretHash: "hashed:secret",
      redirectUri: "https://example.com/callback",
      codeVerifier: "verifier",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_grant");
  });

  it("returns invalid_grant when code is expired", async () => {
    const { prisma } = await import("@/lib/prisma");
    (prisma as Record<string, unknown>).mcpAuthorizationCode = {
      findUnique: vi.fn().mockResolvedValue({
        id: "code-id",
        usedAt: null,
        expiresAt: new Date(Date.now() - 1000), // expired
        mcpClient: { clientId: "mcpc_test", clientSecretHash: "hashed:secret", isActive: true },
        clientId: "client-uuid",
        tenantId: "tenant-uuid",
        userId: "user-uuid",
        serviceAccountId: null,
        redirectUri: "https://example.com/callback",
        codeChallenge: "challenge",
        codeChallengeMethod: "S256",
        scope: "credentials:read",
      }),
    };

    const result = await exchangeCodeForToken({
      code: "expired-code",
      clientId: "mcpc_test",
      clientSecretHash: "hashed:secret",
      redirectUri: "https://example.com/callback",
      codeVerifier: "verifier",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_grant");
  });

  it("returns invalid_client when client_id does not match", async () => {
    const { prisma } = await import("@/lib/prisma");
    (prisma as Record<string, unknown>).mcpAuthorizationCode = {
      findUnique: vi.fn().mockResolvedValue({
        id: "code-id",
        usedAt: null,
        expiresAt: new Date(Date.now() + 60000),
        mcpClient: { clientId: "mcpc_other", clientSecretHash: "hashed:secret", isActive: true },
        clientId: "client-uuid",
        tenantId: "tenant-uuid",
        userId: "user-uuid",
        serviceAccountId: null,
        redirectUri: "https://example.com/callback",
        codeChallenge: "challenge",
        codeChallengeMethod: "S256",
        scope: "credentials:read",
      }),
    };

    const result = await exchangeCodeForToken({
      code: "valid-code",
      clientId: "mcpc_test",
      clientSecretHash: "hashed:secret",
      redirectUri: "https://example.com/callback",
      codeVerifier: "verifier",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_client");
  });

  it("returns invalid_grant when PKCE verification fails", async () => {
    const verifier = "correct-verifier-string";
    const wrongVerifier = "wrong-verifier";
    const challenge = computeS256Challenge(verifier);

    const { prisma } = await import("@/lib/prisma");
    (prisma as Record<string, unknown>).mcpAuthorizationCode = {
      findUnique: vi.fn().mockResolvedValue({
        id: "code-id",
        usedAt: null,
        expiresAt: new Date(Date.now() + 60000),
        mcpClient: { clientId: "mcpc_test", clientSecretHash: "hashed:secret", isActive: true },
        clientId: "client-uuid",
        tenantId: "tenant-uuid",
        userId: "user-uuid",
        serviceAccountId: null,
        redirectUri: "https://example.com/callback",
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
        scope: "credentials:read",
      }),
    };

    const result = await exchangeCodeForToken({
      code: "valid-code",
      clientId: "mcpc_test",
      clientSecretHash: "hashed:secret",
      redirectUri: "https://example.com/callback",
      codeVerifier: wrongVerifier,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_grant");
  });

  it("returns invalid_client when clientSecretHash does not match", async () => {
    const { prisma } = await import("@/lib/prisma");
    (prisma as Record<string, unknown>).mcpAuthorizationCode = {
      findUnique: vi.fn().mockResolvedValue({
        id: "code-id",
        usedAt: null,
        expiresAt: new Date(Date.now() + 60000),
        mcpClient: { clientId: "mcpc_test", clientSecretHash: "hashed:correct-secret", isActive: true, tenantId: "tenant-uuid" },
        clientId: "client-uuid",
        tenantId: "tenant-uuid",
        userId: "user-uuid",
        serviceAccountId: null,
        redirectUri: "https://example.com/callback",
        codeChallenge: "any-challenge",
        codeChallengeMethod: "S256",
        scope: "credentials:read",
      }),
    };

    const result = await exchangeCodeForToken({
      code: "valid-code",
      clientId: "mcpc_test",
      clientSecretHash: "hashed:wrong-secret",
      redirectUri: "https://example.com/callback",
      codeVerifier: "verifier",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_client");
  });

  it("returns invalid_client when client isActive is false", async () => {
    const { prisma } = await import("@/lib/prisma");
    (prisma as Record<string, unknown>).mcpAuthorizationCode = {
      findUnique: vi.fn().mockResolvedValue({
        id: "code-id",
        usedAt: null,
        expiresAt: new Date(Date.now() + 60000),
        mcpClient: { clientId: "mcpc_test", clientSecretHash: "hashed:secret", isActive: false, tenantId: "tenant-uuid" },
        clientId: "client-uuid",
        tenantId: "tenant-uuid",
        userId: "user-uuid",
        serviceAccountId: null,
        redirectUri: "https://example.com/callback",
        codeChallenge: "any-challenge",
        codeChallengeMethod: "S256",
        scope: "credentials:read",
      }),
    };

    const result = await exchangeCodeForToken({
      code: "valid-code",
      clientId: "mcpc_test",
      clientSecretHash: "hashed:secret",
      redirectUri: "https://example.com/callback",
      codeVerifier: "verifier",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_client");
  });

  it("returns invalid_grant when redirectUri does not match", async () => {
    const verifier = "correct-verifier-for-redirect-test";
    const challenge = computeS256Challenge(verifier);

    const { prisma } = await import("@/lib/prisma");
    (prisma as Record<string, unknown>).mcpAuthorizationCode = {
      findUnique: vi.fn().mockResolvedValue({
        id: "code-id",
        usedAt: null,
        expiresAt: new Date(Date.now() + 60000),
        mcpClient: { clientId: "mcpc_test", clientSecretHash: "hashed:secret", isActive: true, tenantId: "tenant-uuid" },
        clientId: "client-uuid",
        tenantId: "tenant-uuid",
        userId: "user-uuid",
        serviceAccountId: null,
        redirectUri: "https://example.com/callback",
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
        scope: "credentials:read",
      }),
    };

    const result = await exchangeCodeForToken({
      code: "valid-code",
      clientId: "mcpc_test",
      clientSecretHash: "hashed:secret",
      redirectUri: "https://example.com/different-callback",
      codeVerifier: verifier,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_grant");
  });

  it("returns access token on successful exchange", async () => {
    const verifier = "correct-verifier-string-for-test";
    const challenge = computeS256Challenge(verifier);

    const { prisma } = await import("@/lib/prisma");
    const mockUpdate = vi.fn().mockResolvedValue({});
    const mockTokenCreate = vi.fn().mockResolvedValue({ id: "token-id" });
    (prisma as Record<string, unknown>).mcpAuthorizationCode = {
      findUnique: vi.fn().mockResolvedValue({
        id: "code-id",
        usedAt: null,
        expiresAt: new Date(Date.now() + 60000),
        mcpClient: { clientId: "mcpc_test", clientSecretHash: "hashed:secret", isActive: true, tenantId: "tenant-uuid" },
        clientId: "client-uuid",
        tenantId: "tenant-uuid",
        userId: "user-uuid",
        serviceAccountId: null,
        redirectUri: "https://example.com/callback",
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
        scope: "credentials:read",
      }),
      update: mockUpdate,
    };
    (prisma as Record<string, unknown>).mcpAccessToken = { create: mockTokenCreate };

    const result = await exchangeCodeForToken({
      code: "valid-code",
      clientId: "mcpc_test",
      clientSecretHash: "hashed:secret",
      redirectUri: "https://example.com/callback",
      codeVerifier: verifier,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.accessToken).toMatch(/^mcp_/);
      expect(result.data.tokenType).toBe("Bearer");
      expect(result.data.expiresIn).toBeGreaterThan(0);
      expect(result.data.scope).toBe("credentials:read");
    }
    expect(mockUpdate).toHaveBeenCalledOnce();
    expect(mockTokenCreate).toHaveBeenCalledOnce();
  });
});

// ─── validateMcpToken tests ───────────────────────────────────

describe("validateMcpToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns invalid_token when token does not start with mcp_ prefix", async () => {
    const result = await validateMcpToken("bearer_invalid_token");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_token");
  });

  it("returns invalid_token when token not found in DB", async () => {
    const { prisma } = await import("@/lib/prisma");
    (prisma as Record<string, unknown>).mcpAccessToken = {
      findUnique: vi.fn().mockResolvedValue(null),
    };

    const result = await validateMcpToken("mcp_nonexistent_token");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_token");
  });

  it("returns token_revoked when token has revokedAt set", async () => {
    const { prisma } = await import("@/lib/prisma");
    (prisma as Record<string, unknown>).mcpAccessToken = {
      findUnique: vi.fn().mockResolvedValue({
        id: "token-id",
        tenantId: "tenant-uuid",
        clientId: "client-uuid",
        userId: "user-uuid",
        serviceAccountId: null,
        scope: "credentials:read",
        expiresAt: new Date(Date.now() + 60000),
        revokedAt: new Date(),
      }),
    };

    const result = await validateMcpToken("mcp_revoked_token");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("token_revoked");
  });

  it("returns token_expired when token is past expiry", async () => {
    const { prisma } = await import("@/lib/prisma");
    (prisma as Record<string, unknown>).mcpAccessToken = {
      findUnique: vi.fn().mockResolvedValue({
        id: "token-id",
        tenantId: "tenant-uuid",
        clientId: "client-uuid",
        userId: "user-uuid",
        serviceAccountId: null,
        scope: "credentials:read",
        expiresAt: new Date(Date.now() - 1000),
        revokedAt: null,
      }),
    };

    const result = await validateMcpToken("mcp_expired_token");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("token_expired");
  });

  it("returns token data on valid token", async () => {
    const { prisma } = await import("@/lib/prisma");
    (prisma as Record<string, unknown>).mcpAccessToken = {
      findUnique: vi.fn().mockResolvedValue({
        id: "token-id",
        tenantId: "tenant-uuid",
        clientId: "client-uuid",
        userId: "user-uuid",
        serviceAccountId: null,
        scope: "credentials:read,credentials:list",
        expiresAt: new Date(Date.now() + 3600000),
        revokedAt: null,
      }),
    };

    const result = await validateMcpToken("mcp_valid_token");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.tokenId).toBe("token-id");
      expect(result.data.tenantId).toBe("tenant-uuid");
      expect(result.data.userId).toBe("user-uuid");
      expect(result.data.scopes).toEqual(["credentials:read", "credentials:list"]);
    }
  });
});
