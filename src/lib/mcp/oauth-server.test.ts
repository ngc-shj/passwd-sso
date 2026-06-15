import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  computeS256Challenge,
  verifyPkceS256,
  createAuthorizationCode,
  exchangeCodeForToken,
  validateMcpToken,
  exchangeRefreshToken,
} from "./oauth-server";

// ─── Mock Prisma ──────────────────────────────────────────────

vi.mock("@/lib/prisma", () => ({
  prisma: {},
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: vi.fn(async (prisma, fn) => fn(prisma)),
}));

vi.mock("@/lib/crypto/crypto-server", () => ({
  hashToken: vi.fn((token: string) => `hashed:${token}`),
}));

vi.mock("@/lib/logger", () => ({
  getLogger: vi.fn(() => ({
    warn: vi.fn(),
    info: vi.fn(),
    child: vi.fn(() => ({ warn: vi.fn(), info: vi.fn() })),
  })),
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
        mcpClient: { clientId: "mcpc_test", clientSecretHash: "hashed:secret", isActive: true, tenantId: "tenant-uuid" },
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
        mcpClient: { clientId: "mcpc_test", clientSecretHash: "hashed:secret", isActive: true, tenantId: "tenant-uuid" },
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
        mcpClient: { clientId: "mcpc_other", clientSecretHash: "hashed:secret", isActive: true, tenantId: "tenant-uuid" },
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
    const mockConsume = vi.fn().mockResolvedValue({ count: 1 });
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
      updateMany: mockConsume,
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
    expect(mockConsume).toHaveBeenCalledOnce();
    expect(mockConsume).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "code-id", usedAt: null } }),
    );
    expect(mockTokenCreate).toHaveBeenCalledOnce();
  });

  it("rejects a second concurrent exchange of the same code (single-use CAS)", async () => {
    const verifier = "correct-verifier-string-for-test";
    const challenge = computeS256Challenge(verifier);

    const { prisma } = await import("@/lib/prisma");
    // Simulate the CAS loser: findUnique still sees usedAt === null (no row lock),
    // but the conditional consume matches 0 rows because the winner already set usedAt.
    const mockConsume = vi.fn().mockResolvedValue({ count: 0 });
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
      updateMany: mockConsume,
    };
    (prisma as Record<string, unknown>).mcpAccessToken = { create: mockTokenCreate };

    const result = await exchangeCodeForToken({
      code: "valid-code",
      clientId: "mcpc_test",
      clientSecretHash: "hashed:secret",
      redirectUri: "https://example.com/callback",
      codeVerifier: verifier,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_grant");
    // No token may be minted for the loser.
    expect(mockTokenCreate).not.toHaveBeenCalled();
  });
});

// ─── validateMcpToken tests ───────────────────────────────────

describe("validateMcpToken", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // C13: provide active-membership default so existing valid-token tests pass.
    const { prisma } = await import("@/lib/prisma");
    (prisma as Record<string, unknown>).tenantMember = {
      findUnique: vi.fn().mockResolvedValue({ deactivatedAt: null }),
    };
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
        mcpClient: { clientId: "mcpc_testclient123", isActive: true, tenantId: "tenant-uuid" },
        userId: "user-uuid",
        serviceAccountId: null,
        scope: "credentials:read,credentials:list",
        expiresAt: new Date(Date.now() + 3600000),
        revokedAt: null,
        lastUsedAt: new Date(Date.now() - 60_000), // 1 minute ago (within threshold)
      }),
      update: vi.fn().mockResolvedValue({}),
    };

    const result = await validateMcpToken("mcp_valid_token");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.tokenId).toBe("token-id");
      expect(result.data.tenantId).toBe("tenant-uuid");
      expect(result.data.userId).toBe("user-uuid");
      expect(result.data.mcpClientId).toBe("mcpc_testclient123");
      expect(result.data.scopes).toEqual(["credentials:read", "credentials:list"]);
    }
  });

  it("updates lastUsedAt when null", async () => {
    const { prisma } = await import("@/lib/prisma");
    const mockUpdate = vi.fn().mockResolvedValue({});
    (prisma as Record<string, unknown>).mcpAccessToken = {
      findUnique: vi.fn().mockResolvedValue({
        id: "token-id",
        tenantId: "t1",
        clientId: "c1",
        mcpClient: { clientId: "mcpc_abc", isActive: true, tenantId: "t1" },
        userId: "u1",
        serviceAccountId: null,
        scope: "credentials:list",
        expiresAt: new Date(Date.now() + 3600_000),
        revokedAt: null,
        lastUsedAt: null,
      }),
      update: mockUpdate,
    };

    const { validateMcpToken } = await import("./oauth-server");
    await validateMcpToken("mcp_valid_token");

    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "token-id" },
      data: { lastUsedAt: expect.any(Date) },
    });
  });

  it("updates lastUsedAt when older than threshold", async () => {
    const { prisma } = await import("@/lib/prisma");
    const mockUpdate = vi.fn().mockResolvedValue({});
    (prisma as Record<string, unknown>).mcpAccessToken = {
      findUnique: vi.fn().mockResolvedValue({
        id: "token-id",
        tenantId: "t1",
        clientId: "c1",
        mcpClient: { clientId: "mcpc_abc", isActive: true, tenantId: "t1" },
        userId: "u1",
        serviceAccountId: null,
        scope: "credentials:list",
        expiresAt: new Date(Date.now() + 3600_000),
        revokedAt: null,
        lastUsedAt: new Date(Date.now() - 10 * 60 * 1000), // 10 minutes ago
      }),
      update: mockUpdate,
    };

    const { validateMcpToken } = await import("./oauth-server");
    await validateMcpToken("mcp_valid_token");

    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "token-id" },
      data: { lastUsedAt: expect.any(Date) },
    });
  });

  it("does not update lastUsedAt when within threshold", async () => {
    const { prisma } = await import("@/lib/prisma");
    const mockUpdate = vi.fn().mockResolvedValue({});
    (prisma as Record<string, unknown>).mcpAccessToken = {
      findUnique: vi.fn().mockResolvedValue({
        id: "token-id",
        tenantId: "t1",
        clientId: "c1",
        mcpClient: { clientId: "mcpc_abc", isActive: true, tenantId: "t1" },
        userId: "u1",
        serviceAccountId: null,
        scope: "credentials:list",
        expiresAt: new Date(Date.now() + 3600_000),
        revokedAt: null,
        lastUsedAt: new Date(Date.now() - 60_000), // 1 minute ago (within 5min threshold)
      }),
      update: mockUpdate,
    };

    const { validateMcpToken } = await import("./oauth-server");
    await validateMcpToken("mcp_valid_token");

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  // A07-4: third McpClient lookup site — token issued before client was
  // deactivated must be rejected immediately, not wait for TTL expiry.
  it("A07-4: rejects token bound to an inactive client (isActive=false)", async () => {
    const { prisma } = await import("@/lib/prisma");
    (prisma as Record<string, unknown>).mcpAccessToken = {
      findUnique: vi.fn().mockResolvedValue({
        id: "token-id",
        tenantId: "t1",
        clientId: "c1",
        mcpClient: { clientId: "mcpc_abc", isActive: false, tenantId: "t1" }, // deactivated
        userId: "u1",
        serviceAccountId: null,
        scope: "credentials:list",
        expiresAt: new Date(Date.now() + 3600_000),
        revokedAt: null,
        lastUsedAt: null,
      }),
      update: vi.fn(),
    };

    const { validateMcpToken } = await import("./oauth-server");
    const result = await validateMcpToken("mcp_valid_token");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("invalid_token");
    }
  });

  // Defensive tenant-boundary check: token.tenantId must match its parent
  // client's own tenantId. A corrupted row must fail closed.
  it("rejects a token whose tenantId differs from its client's tenantId", async () => {
    const { prisma } = await import("@/lib/prisma");
    (prisma as Record<string, unknown>).mcpAccessToken = {
      findUnique: vi.fn().mockResolvedValue({
        id: "token-id",
        tenantId: "tenant-A",
        clientId: "c1",
        mcpClient: { clientId: "mcpc_abc", isActive: true, tenantId: "tenant-OTHER" },
        userId: "u1",
        serviceAccountId: null,
        scope: "credentials:list",
        expiresAt: new Date(Date.now() + 3600_000),
        revokedAt: null,
        lastUsedAt: null,
      }),
      update: vi.fn(),
    };

    const { validateMcpToken } = await import("./oauth-server");
    const result = await validateMcpToken("mcp_valid_token");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("invalid_token");
    }
  });

  // ── C13: deactivated-user rejection ───────────────────────

  it("C13(a): deactivated-in-token-tenant ⇒ invalid_token", async () => {
    const { prisma } = await import("@/lib/prisma");
    (prisma as Record<string, unknown>).mcpAccessToken = {
      findUnique: vi.fn().mockResolvedValue({
        id: "token-id",
        tenantId: "tenant-uuid",
        clientId: "client-uuid",
        mcpClient: { clientId: "mcpc_abc", isActive: true, tenantId: "tenant-uuid" },
        userId: "user-uuid",
        serviceAccountId: null,
        scope: "credentials:list",
        expiresAt: new Date(Date.now() + 3600_000),
        revokedAt: null,
        lastUsedAt: null,
      }),
      update: vi.fn(),
    };
    (prisma as Record<string, unknown>).tenantMember = {
      findUnique: vi.fn().mockResolvedValue({ deactivatedAt: new Date("2025-01-01") }),
    };

    const { validateMcpToken } = await import("./oauth-server");
    const result = await validateMcpToken("mcp_deactivated_token");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_token");
  });

  it("C13(b): deactivated in token tenant (cross-tenant bypass guard) ⇒ invalid_token", async () => {
    const { prisma } = await import("@/lib/prisma");
    const mockTenantMemberFindUnique = vi.fn().mockResolvedValue({ deactivatedAt: new Date("2025-01-01") });
    (prisma as Record<string, unknown>).mcpAccessToken = {
      findUnique: vi.fn().mockResolvedValue({
        id: "token-id",
        tenantId: "tenant-A",
        clientId: "client-uuid",
        mcpClient: { clientId: "mcpc_abc", isActive: true, tenantId: "tenant-A" },
        userId: "user-uuid",
        serviceAccountId: null,
        scope: "credentials:list",
        expiresAt: new Date(Date.now() + 3600_000),
        revokedAt: null,
        lastUsedAt: null,
      }),
      update: vi.fn(),
    };
    (prisma as Record<string, unknown>).tenantMember = {
      findUnique: mockTenantMemberFindUnique,
    };

    const { validateMcpToken } = await import("./oauth-server");
    const result = await validateMcpToken("mcp_deactivated_in_tenant_a");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_token");
    // Verify lookup is scoped to the token's own tenantId
    expect(mockTenantMemberFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId_userId: { tenantId: "tenant-A", userId: "user-uuid" } },
      }),
    );
  });

  it("C13(c): active membership ⇒ valid", async () => {
    const { prisma } = await import("@/lib/prisma");
    (prisma as Record<string, unknown>).mcpAccessToken = {
      findUnique: vi.fn().mockResolvedValue({
        id: "token-id",
        tenantId: "tenant-uuid",
        clientId: "client-uuid",
        mcpClient: { clientId: "mcpc_abc", isActive: true, tenantId: "tenant-uuid" },
        userId: "user-uuid",
        serviceAccountId: null,
        scope: "credentials:list",
        expiresAt: new Date(Date.now() + 3600_000),
        revokedAt: null,
        lastUsedAt: null,
      }),
      update: vi.fn().mockResolvedValue({}),
    };
    (prisma as Record<string, unknown>).tenantMember = {
      findUnique: vi.fn().mockResolvedValue({ deactivatedAt: null }),
    };

    const { validateMcpToken } = await import("./oauth-server");
    const result = await validateMcpToken("mcp_active_user_token");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.userId).toBe("user-uuid");
    }
  });

  // ── C13 in exchangeRefreshToken ───────────────────────────

  it("C13(e): deactivated user in exchangeRefreshToken ⇒ invalid_grant", async () => {
    const { prisma } = await import("@/lib/prisma");
    const baseRt = {
      id: "rt-id",
      tokenHash: "hashed:rt",
      rotatedAt: null,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 3600_000),
      clientId: "client-uuid",
      tenantId: "tenant-uuid",
      userId: "user-uuid",
      serviceAccountId: null,
      familyId: "fam-uuid",
      accessTokenId: "at-id",
      scope: "credentials:list",
      mcpClient: { clientId: "mcpc_test", clientSecretHash: "", isActive: true, tenantId: "tenant-uuid" },
    };
    (prisma as Record<string, unknown>).mcpRefreshToken = {
      findUnique: vi.fn().mockResolvedValue(baseRt),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi.fn().mockResolvedValue({ id: "new-rt-id" }),
    };
    (prisma as Record<string, unknown>).mcpAccessToken = {
      create: vi.fn().mockResolvedValue({ id: "new-at-id" }),
      update: vi.fn().mockResolvedValue({}),
    };
    (prisma as Record<string, unknown>).tenantMember = {
      findUnique: vi.fn().mockResolvedValue({ deactivatedAt: new Date("2025-01-01") }),
    };

    const result = await exchangeRefreshToken(
      { refreshToken: "rt", clientId: "mcpc_test", clientSecretHash: "" },
      { prisma: prisma as never },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_grant");
  });

  it("C13(f): active user in exchangeRefreshToken ⇒ rotates successfully", async () => {
    const { prisma } = await import("@/lib/prisma");
    const baseRt = {
      id: "rt-id",
      tokenHash: "hashed:rt2",
      rotatedAt: null,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 3600_000),
      clientId: "client-uuid",
      tenantId: "tenant-uuid",
      userId: "user-uuid",
      serviceAccountId: null,
      familyId: "fam-uuid",
      accessTokenId: "at-id",
      scope: "credentials:list",
      mcpClient: { clientId: "mcpc_test", clientSecretHash: "", isActive: true, tenantId: "tenant-uuid" },
    };
    (prisma as Record<string, unknown>).mcpRefreshToken = {
      findUnique: vi.fn().mockResolvedValue(baseRt),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi.fn().mockResolvedValue({ id: "new-rt-id" }),
    };
    (prisma as Record<string, unknown>).mcpAccessToken = {
      create: vi.fn().mockResolvedValue({ id: "new-at-id" }),
      update: vi.fn().mockResolvedValue({}),
    };
    (prisma as Record<string, unknown>).tenantMember = {
      findUnique: vi.fn().mockResolvedValue({ deactivatedAt: null }),
    };

    const result = await exchangeRefreshToken(
      { refreshToken: "rt2", clientId: "mcpc_test", clientSecretHash: "" },
      { prisma: prisma as never },
    );

    expect(result.ok).toBe(true);
  });

  it("C13(g): SA-bound (userId:null) in exchangeRefreshToken ⇒ rotates (no membership check)", async () => {
    const { prisma } = await import("@/lib/prisma");
    const mockTenantMemberFindUnique = vi.fn();
    const baseRt = {
      id: "rt-id",
      tokenHash: "hashed:rt3",
      rotatedAt: null,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 3600_000),
      clientId: "client-uuid",
      tenantId: "tenant-uuid",
      userId: null,
      serviceAccountId: "sa-uuid",
      familyId: "fam-uuid",
      accessTokenId: "at-id",
      scope: "credentials:list",
      mcpClient: { clientId: "mcpc_test", clientSecretHash: "", isActive: true, tenantId: "tenant-uuid" },
    };
    (prisma as Record<string, unknown>).mcpRefreshToken = {
      findUnique: vi.fn().mockResolvedValue(baseRt),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi.fn().mockResolvedValue({ id: "new-rt-id" }),
    };
    (prisma as Record<string, unknown>).mcpAccessToken = {
      create: vi.fn().mockResolvedValue({ id: "new-at-id" }),
      update: vi.fn().mockResolvedValue({}),
    };
    (prisma as Record<string, unknown>).tenantMember = {
      findUnique: mockTenantMemberFindUnique,
    };

    const result = await exchangeRefreshToken(
      { refreshToken: "rt3", clientId: "mcpc_test", clientSecretHash: "" },
      { prisma: prisma as never },
    );

    expect(result.ok).toBe(true);
    // SA-bound: membership query must NOT be called
    expect(mockTenantMemberFindUnique).not.toHaveBeenCalled();
  });

  it("C13(d): userId:null SA-bound token ⇒ valid (membership query NOT called)", async () => {
    const { prisma } = await import("@/lib/prisma");
    const mockTenantMemberFindUnique = vi.fn().mockResolvedValue({ deactivatedAt: null });
    (prisma as Record<string, unknown>).mcpAccessToken = {
      findUnique: vi.fn().mockResolvedValue({
        id: "token-id",
        tenantId: "tenant-uuid",
        clientId: "client-uuid",
        mcpClient: { clientId: "mcpc_abc", isActive: true, tenantId: "tenant-uuid" },
        userId: null,
        serviceAccountId: "sa-uuid",
        scope: "credentials:list",
        expiresAt: new Date(Date.now() + 3600_000),
        revokedAt: null,
        lastUsedAt: null,
      }),
      update: vi.fn().mockResolvedValue({}),
    };
    (prisma as Record<string, unknown>).tenantMember = {
      findUnique: mockTenantMemberFindUnique,
    };

    const { validateMcpToken } = await import("./oauth-server");
    const result = await validateMcpToken("mcp_sa_bound_token");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.userId).toBeNull();
      expect(result.data.serviceAccountId).toBe("sa-uuid");
    }
    // SA-bound: membership query must NOT be called
    expect(mockTenantMemberFindUnique).not.toHaveBeenCalled();
  });
});
