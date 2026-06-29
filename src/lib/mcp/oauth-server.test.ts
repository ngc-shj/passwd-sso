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

// The mocked `prisma` is an empty object the tests populate with per-delegate
// mocks at runtime; its real type is `PrismaClient` (a class), which does not
// structurally overlap an index signature, so attaching arbitrary delegate
// mocks requires bridging through `unknown`. Centralize that single bridge.
function mockDelegates(client: unknown): Record<string, unknown> {
  return client as Record<string, unknown>;
}

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: vi.fn(async (prisma, fn) => fn(prisma)),
}));

// Helper: add the passkey-state delegates (webAuthnCredential + tenant) to a
// prisma mock object so that derivePasskeyState resolves NON-BLOCKING (the
// default for every test that is NOT specifically testing the passkey gate).
// Count > 0 → hasPasskey=true; requirePasskey=false → never blocks.
// Note: requirePasskeyEnabledAt must be a Date | null (Prisma returns Date,
// derivePasskeyState calls .toISOString() on it).
function addPasskeyStateMocks(client: unknown, opts: { requirePasskey?: boolean; hasPasskey?: boolean } = {}) {
  const d = mockDelegates(client);
  d.webAuthnCredential = {
    count: vi.fn().mockResolvedValue(opts.hasPasskey === false ? 0 : 1),
  };
  d.tenant = {
    findUnique: vi.fn().mockResolvedValue({
      requirePasskey: opts.requirePasskey ?? false,
      requirePasskeyEnabledAt: null, // Date | null — null means no enabledAt
      passkeyGracePeriodDays: null,
    }),
  };
}

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
    mockDelegates(prisma).mcpAuthorizationCode = { create: mockCreate };

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
    mockDelegates(prisma).$transaction = async (fn: (tx: unknown) => unknown) =>
      fn(prisma);
  });

  it("returns invalid_grant when code not found", async () => {
    const { prisma } = await import("@/lib/prisma");
    mockDelegates(prisma).mcpAuthorizationCode = {
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
    mockDelegates(prisma).mcpAuthorizationCode = {
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
    mockDelegates(prisma).mcpAuthorizationCode = {
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
    mockDelegates(prisma).mcpAuthorizationCode = {
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
    mockDelegates(prisma).mcpAuthorizationCode = {
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
    mockDelegates(prisma).mcpAuthorizationCode = {
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
    mockDelegates(prisma).mcpAuthorizationCode = {
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
    mockDelegates(prisma).mcpAuthorizationCode = {
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
    mockDelegates(prisma).mcpAuthorizationCode = {
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
    mockDelegates(prisma).mcpAccessToken = { create: mockTokenCreate };
    // derivePasskeyState: non-blocking (requirePasskey=false, hasPasskey=true)
    addPasskeyStateMocks(prisma);

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
    mockDelegates(prisma).mcpAuthorizationCode = {
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
    mockDelegates(prisma).mcpAccessToken = { create: mockTokenCreate };
    addPasskeyStateMocks(prisma);

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
    mockDelegates(prisma).tenantMember = {
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
    mockDelegates(prisma).mcpAccessToken = {
      findUnique: vi.fn().mockResolvedValue(null),
    };

    const result = await validateMcpToken("mcp_nonexistent_token");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_token");
  });

  it("returns token_revoked when token has revokedAt set", async () => {
    const { prisma } = await import("@/lib/prisma");
    mockDelegates(prisma).mcpAccessToken = {
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
    mockDelegates(prisma).mcpAccessToken = {
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
    mockDelegates(prisma).mcpAccessToken = {
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
    mockDelegates(prisma).mcpAccessToken = {
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
    mockDelegates(prisma).mcpAccessToken = {
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
    mockDelegates(prisma).mcpAccessToken = {
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
    mockDelegates(prisma).mcpAccessToken = {
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
    mockDelegates(prisma).mcpAccessToken = {
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
  //
  // L2 — SCIM deactivation fail-open backstop: SCIM deactivation calls
  // invalidateUserSessions, which sets revokedAt on this MCP access token. If
  // that throws (the SCIM handler logs + returns 200 — a fail-open window),
  // revokedAt stays null. C13(a) below IS that scenario: revokedAt:null (token
  // never revoked) + member deactivated → invalid_token via the membership check
  // alone. This is what makes the SCIM fail-open safe.

  it("C13(a): deactivated-in-token-tenant ⇒ invalid_token", async () => {
    const { prisma } = await import("@/lib/prisma");
    mockDelegates(prisma).mcpAccessToken = {
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
    mockDelegates(prisma).tenantMember = {
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
    mockDelegates(prisma).mcpAccessToken = {
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
    mockDelegates(prisma).tenantMember = {
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
    mockDelegates(prisma).mcpAccessToken = {
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
    mockDelegates(prisma).tenantMember = {
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
      familyCreatedAt: new Date(Date.now() - 1_000), // recent — well within the 30-day cap
      accessTokenId: "at-id",
      scope: "credentials:list",
      mcpClient: { clientId: "mcpc_test", clientSecretHash: "", isActive: true, tenantId: "tenant-uuid" },
    };
    mockDelegates(prisma).mcpRefreshToken = {
      findUnique: vi.fn().mockResolvedValue(baseRt),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi.fn().mockResolvedValue({ id: "new-rt-id" }),
    };
    mockDelegates(prisma).mcpAccessToken = {
      create: vi.fn().mockResolvedValue({ id: "new-at-id" }),
      update: vi.fn().mockResolvedValue({}),
    };
    mockDelegates(prisma).tenantMember = {
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
      familyCreatedAt: new Date(Date.now() - 1_000), // recent — well within the 30-day cap
      accessTokenId: "at-id",
      scope: "credentials:list",
      mcpClient: { clientId: "mcpc_test", clientSecretHash: "", isActive: true, tenantId: "tenant-uuid" },
    };
    mockDelegates(prisma).mcpRefreshToken = {
      findUnique: vi.fn().mockResolvedValue(baseRt),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi.fn().mockResolvedValue({ id: "new-rt-id" }),
    };
    mockDelegates(prisma).mcpAccessToken = {
      create: vi.fn().mockResolvedValue({ id: "new-at-id" }),
      update: vi.fn().mockResolvedValue({}),
    };
    mockDelegates(prisma).tenantMember = {
      findUnique: vi.fn().mockResolvedValue({ deactivatedAt: null }),
    };
    addPasskeyStateMocks(prisma);

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
      familyCreatedAt: new Date(Date.now() - 1_000), // recent — well within the 30-day cap
      accessTokenId: "at-id",
      scope: "credentials:list",
      mcpClient: { clientId: "mcpc_test", clientSecretHash: "", isActive: true, tenantId: "tenant-uuid" },
    };
    mockDelegates(prisma).mcpRefreshToken = {
      findUnique: vi.fn().mockResolvedValue(baseRt),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi.fn().mockResolvedValue({ id: "new-rt-id" }),
    };
    mockDelegates(prisma).mcpAccessToken = {
      create: vi.fn().mockResolvedValue({ id: "new-at-id" }),
      update: vi.fn().mockResolvedValue({}),
    };
    mockDelegates(prisma).tenantMember = {
      findUnique: mockTenantMemberFindUnique,
    };
    // SA-bound: userId===null, so derivePasskeyState is never called.
    // Provide the delegates anyway for safety (non-blocking).
    addPasskeyStateMocks(prisma);

    const result = await exchangeRefreshToken(
      { refreshToken: "rt3", clientId: "mcpc_test", clientSecretHash: "" },
      { prisma: prisma as never },
    );

    expect(result.ok).toBe(true);
    // SA-bound: membership query must NOT be called
    expect(mockTenantMemberFindUnique).not.toHaveBeenCalled();
  });

  // ── C8 MCP absolute family cap ────────────────────────────

  it("C8(cap-exceeded): family older than 30 days ⇒ invalid_grant, no new tokens created", async () => {
    const { prisma } = await import("@/lib/prisma");
    // familyCreatedAt is 31 days ago; cap is 30 days
    const familyCreatedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    const mockCreate = vi.fn();
    const mockAccessCreate = vi.fn();
    const baseRt = {
      id: "rt-id",
      tokenHash: "hashed:rt-cap-exceeded",
      rotatedAt: null,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 3600_000),
      clientId: "client-uuid",
      tenantId: "tenant-uuid",
      userId: "user-uuid",
      serviceAccountId: null,
      familyId: "fam-cap-uuid",
      familyCreatedAt,
      accessTokenId: "at-id",
      scope: "credentials:list",
      mcpClient: { clientId: "mcpc_test", clientSecretHash: "", isActive: true, tenantId: "tenant-uuid" },
    };
    mockDelegates(prisma).mcpRefreshToken = {
      findUnique: vi.fn().mockResolvedValue(baseRt),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: mockCreate,
    };
    mockDelegates(prisma).mcpAccessToken = {
      create: mockAccessCreate,
      update: vi.fn().mockResolvedValue({}),
    };
    mockDelegates(prisma).tenantMember = {
      findUnique: vi.fn().mockResolvedValue({ deactivatedAt: null }),
    };
    addPasskeyStateMocks(prisma);

    const result = await exchangeRefreshToken(
      { refreshToken: "rt-cap-exceeded", clientId: "mcpc_test", clientSecretHash: "" },
      { prisma: prisma as never },
    );

    // Refusal shape: same as deactivated_user
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_grant");
    // No new tokens must be minted
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockAccessCreate).not.toHaveBeenCalled();
  });

  it("C8(cap-exceeded injectable clock): cap check uses injectable now param", async () => {
    const { prisma } = await import("@/lib/prisma");
    // familyCreatedAt is 1 day ago; injectable clock says 31 days have passed
    const familyCreatedAt = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    const frozenNow = familyCreatedAt.getTime() + 31 * 24 * 60 * 60 * 1000;
    const mockCreate = vi.fn();
    const mockAccessCreate = vi.fn();
    const baseRt = {
      id: "rt-id",
      tokenHash: "hashed:rt-cap-clock",
      rotatedAt: null,
      revokedAt: null,
      expiresAt: new Date(frozenNow + 3600_000),
      clientId: "client-uuid",
      tenantId: "tenant-uuid",
      userId: "user-uuid",
      serviceAccountId: null,
      familyId: "fam-cap-clock-uuid",
      familyCreatedAt,
      accessTokenId: "at-id",
      scope: "credentials:list",
      mcpClient: { clientId: "mcpc_test", clientSecretHash: "", isActive: true, tenantId: "tenant-uuid" },
    };
    mockDelegates(prisma).mcpRefreshToken = {
      findUnique: vi.fn().mockResolvedValue(baseRt),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: mockCreate,
    };
    mockDelegates(prisma).mcpAccessToken = {
      create: mockAccessCreate,
      update: vi.fn().mockResolvedValue({}),
    };
    mockDelegates(prisma).tenantMember = {
      findUnique: vi.fn().mockResolvedValue({ deactivatedAt: null }),
    };
    addPasskeyStateMocks(prisma);

    const result = await exchangeRefreshToken(
      { refreshToken: "rt-cap-clock", clientId: "mcpc_test", clientSecretHash: "", now: () => frozenNow },
      { prisma: prisma as never },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_grant");
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockAccessCreate).not.toHaveBeenCalled();
  });

  it("C8(within-cap): family within 30 days ⇒ rotates normally", async () => {
    const { prisma } = await import("@/lib/prisma");
    // familyCreatedAt is 10 days ago — well within the 30-day cap
    const familyCreatedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const mockCreate = vi.fn().mockResolvedValue({ id: "new-rt-id" });
    const baseRt = {
      id: "rt-id",
      tokenHash: "hashed:rt-within-cap",
      rotatedAt: null,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 3600_000),
      clientId: "client-uuid",
      tenantId: "tenant-uuid",
      userId: "user-uuid",
      serviceAccountId: null,
      familyId: "fam-within-cap-uuid",
      familyCreatedAt,
      accessTokenId: "at-id",
      scope: "credentials:list",
      mcpClient: { clientId: "mcpc_test", clientSecretHash: "", isActive: true, tenantId: "tenant-uuid" },
    };
    mockDelegates(prisma).mcpRefreshToken = {
      findUnique: vi.fn().mockResolvedValue(baseRt),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: mockCreate,
    };
    mockDelegates(prisma).mcpAccessToken = {
      create: vi.fn().mockResolvedValue({ id: "new-at-id" }),
      update: vi.fn().mockResolvedValue({}),
    };
    mockDelegates(prisma).tenantMember = {
      findUnique: vi.fn().mockResolvedValue({ deactivatedAt: null }),
    };
    addPasskeyStateMocks(prisma);

    const result = await exchangeRefreshToken(
      { refreshToken: "rt-within-cap", clientId: "mcpc_test", clientSecretHash: "" },
      { prisma: prisma as never },
    );

    // Within cap: rotation must succeed and a new refresh token must be created
    expect(result.ok).toBe(true);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("C13(d): userId:null SA-bound token ⇒ valid (membership query NOT called)", async () => {
    const { prisma } = await import("@/lib/prisma");
    const mockTenantMemberFindUnique = vi.fn().mockResolvedValue({ deactivatedAt: null });
    mockDelegates(prisma).mcpAccessToken = {
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
    mockDelegates(prisma).tenantMember = {
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

// ─── Passkey enforcement tests (lib-level) ────────────────────

describe("passkey enforcement in exchangeRefreshToken (lib)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const TENANT_ID = "tenant-pk-test";
  const USER_ID = "user-pk-test";
  const FAMILY_ID = "fam-pk-test";

  // Shared base refresh token row (valid, user-bound, within cap)
  function makeBaseRt(overrides: Record<string, unknown> = {}) {
    return {
      id: "rt-pk-id",
      tokenHash: "hashed:rt-pk",
      rotatedAt: null,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 3600_000),
      clientId: "client-uuid",
      tenantId: TENANT_ID,
      userId: USER_ID,
      serviceAccountId: null,
      familyId: FAMILY_ID,
      familyCreatedAt: new Date(Date.now() - 1_000),
      accessTokenId: "at-pk-id",
      scope: "credentials:list",
      mcpClient: { clientId: "mcpc_test", clientSecretHash: "", isActive: true, tenantId: TENANT_ID },
      ...overrides,
    };
  }

  it("passkey-blocked user ⇒ access_denied, NO new tokens minted", async () => {
    const { prisma } = await import("@/lib/prisma");
    const mockAccessCreate = vi.fn();
    const mockRefreshCreate = vi.fn();
    mockDelegates(prisma).mcpRefreshToken = {
      findUnique: vi.fn().mockResolvedValue(makeBaseRt()),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: mockRefreshCreate,
    };
    mockDelegates(prisma).mcpAccessToken = {
      create: mockAccessCreate,
      update: vi.fn().mockResolvedValue({}),
    };
    mockDelegates(prisma).tenantMember = {
      findUnique: vi.fn().mockResolvedValue({ deactivatedAt: null }),
    };
    // Passkey enforcement BLOCKS: requirePasskey=true, no passkey, grace expired.
    // requirePasskeyEnabledAt must be a Date (Prisma returns Date; derivePasskeyState
    // calls .toISOString() on it).
    addPasskeyStateMocks(prisma, { requirePasskey: true, hasPasskey: false });
    mockDelegates(prisma).tenant = {
      findUnique: vi.fn().mockResolvedValue({
        requirePasskey: true,
        requirePasskeyEnabledAt: new Date("2020-01-01T00:00:00.000Z"),
        passkeyGracePeriodDays: 7,
      }),
    };

    const result = await exchangeRefreshToken(
      { refreshToken: "rt-pk", clientId: "mcpc_test", clientSecretHash: "" },
      { prisma: prisma as never },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("access_denied");
      expect(result.tenantId).toBe(TENANT_ID);
      expect(result.userId).toBe(USER_ID);
    }
    // CRITICAL: no tokens must be minted when passkey enforcement blocks
    expect(mockAccessCreate).not.toHaveBeenCalled();
    expect(mockRefreshCreate).not.toHaveBeenCalled();
  });

  it("SA-bound (userId===null) with blocking-tenant ⇒ gate skipped, still rotates", async () => {
    const { prisma } = await import("@/lib/prisma");
    const mockRefreshCreate = vi.fn().mockResolvedValue({ id: "new-rt-sa" });
    mockDelegates(prisma).mcpRefreshToken = {
      findUnique: vi.fn().mockResolvedValue(makeBaseRt({ userId: null, serviceAccountId: "sa-1" })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: mockRefreshCreate,
    };
    mockDelegates(prisma).mcpAccessToken = {
      create: vi.fn().mockResolvedValue({ id: "new-at-sa" }),
      update: vi.fn().mockResolvedValue({}),
    };
    // No tenantMember needed (SA-bound skips that too)
    // Passkey would block a human — but SA-bound skip means this must rotate
    addPasskeyStateMocks(prisma, { requirePasskey: true, hasPasskey: false });
    mockDelegates(prisma).tenant = {
      findUnique: vi.fn().mockResolvedValue({
        requirePasskey: true,
        requirePasskeyEnabledAt: new Date("2020-01-01T00:00:00.000Z"),
        passkeyGracePeriodDays: 7,
      }),
    };

    const result = await exchangeRefreshToken(
      { refreshToken: "rt-pk", clientId: "mcpc_test", clientSecretHash: "" },
      { prisma: prisma as never },
    );

    expect(result.ok).toBe(true);
    expect(mockRefreshCreate).toHaveBeenCalledOnce();
  });

  // REGRESSION (critical): rotated (replayed) token presented while passkey would block
  // → must return REPLAY outcome (invalid_grant / reason:REPLAY) and fire family
  //   revocation, NOT access_denied. Proves the gate runs AFTER replay detection.
  it("REGRESSION: rotated token (replay) while passkey would block ⇒ invalid_grant/REPLAY + family revoked, NOT access_denied", async () => {
    const { prisma } = await import("@/lib/prisma");
    const mockRefreshUpdateMany = vi.fn().mockResolvedValue({ count: 0 }); // replay phase-2 path
    const mockRefreshFindMany = vi.fn().mockResolvedValue([{ accessTokenId: "at-pk-id" }]);
    const mockAccessUpdateMany = vi.fn().mockResolvedValue({});
    const mockAccessCreate = vi.fn();
    const mockRefreshCreate = vi.fn();
    // Token is already rotated — this is a replay
    mockDelegates(prisma).mcpRefreshToken = {
      findUnique: vi.fn().mockResolvedValue(makeBaseRt({ rotatedAt: new Date(Date.now() - 30_000) })),
      updateMany: mockRefreshUpdateMany,
      findMany: mockRefreshFindMany,
      create: mockRefreshCreate,
    };
    mockDelegates(prisma).mcpAccessToken = {
      create: mockAccessCreate,
      update: vi.fn().mockResolvedValue({}),
      updateMany: mockAccessUpdateMany,
    };
    // Passkey would block a human — but replay detection must fire first.
    // requirePasskeyEnabledAt must be a Date (Prisma returns Date).
    addPasskeyStateMocks(prisma, { requirePasskey: true, hasPasskey: false });
    mockDelegates(prisma).tenant = {
      findUnique: vi.fn().mockResolvedValue({
        requirePasskey: true,
        requirePasskeyEnabledAt: new Date("2020-01-01T00:00:00.000Z"),
        passkeyGracePeriodDays: 7,
      }),
    };

    const result = await exchangeRefreshToken(
      { refreshToken: "rt-pk", clientId: "mcpc_test", clientSecretHash: "" },
      { prisma: prisma as never },
    );

    // Must be REPLAY, not access_denied
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("invalid_grant");
      expect(result.reason).toBe("replay");
    }
    // Family revocation must have fired (mcpRefreshToken.updateMany called in Phase 2)
    expect(mockRefreshUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ familyId: FAMILY_ID, revokedAt: null }),
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      }),
    );
    // No new tokens minted
    expect(mockAccessCreate).not.toHaveBeenCalled();
    expect(mockRefreshCreate).not.toHaveBeenCalled();
  });
});

describe("passkey enforcement in exchangeCodeForToken (lib)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { prisma } = await import("@/lib/prisma");
    mockDelegates(prisma).$transaction = async (fn: (tx: unknown) => unknown) => fn(prisma);
  });

  const TENANT_ID = "tenant-code-pk";
  const USER_ID = "user-code-pk";

  function codeRow(overrides: Record<string, unknown> = {}) {
    const verifier = "pk-test-verifier-string-for-test";
    const challenge = computeS256Challenge(verifier);
    return {
      id: "code-pk-id",
      usedAt: null,
      expiresAt: new Date(Date.now() + 60000),
      mcpClient: { clientId: "mcpc_test", clientSecretHash: "", isActive: true, tenantId: TENANT_ID },
      clientId: "client-uuid",
      tenantId: TENANT_ID,
      userId: USER_ID,
      serviceAccountId: null,
      redirectUri: "https://example.com/callback",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      scope: "credentials:read",
      ...overrides,
    };
  }

  it("passkey-blocked user ⇒ access_denied, NO mcpAccessToken.create called", async () => {
    const { prisma } = await import("@/lib/prisma");
    const mockTokenCreate = vi.fn();
    mockDelegates(prisma).mcpAuthorizationCode = {
      findUnique: vi.fn().mockResolvedValue(codeRow()),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    };
    mockDelegates(prisma).mcpAccessToken = { create: mockTokenCreate };
    // Passkey enforcement BLOCKS. requirePasskeyEnabledAt must be a Date (Prisma returns Date).
    addPasskeyStateMocks(prisma, { requirePasskey: true, hasPasskey: false });
    mockDelegates(prisma).tenant = {
      findUnique: vi.fn().mockResolvedValue({
        requirePasskey: true,
        requirePasskeyEnabledAt: new Date("2020-01-01T00:00:00.000Z"),
        passkeyGracePeriodDays: 7,
      }),
    };

    const result = await exchangeCodeForToken({
      code: "pk-test-verifier-string-for-test", // doesn't matter — mocked
      clientId: "mcpc_test",
      clientSecretHash: "",
      redirectUri: "https://example.com/callback",
      codeVerifier: "pk-test-verifier-string-for-test",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("access_denied");
      expect(result.userId).toBe(USER_ID);
      expect(result.tenantId).toBe(TENANT_ID);
    }
    expect(mockTokenCreate).not.toHaveBeenCalled();
  });

  it("SA-bound (userId===null) ⇒ gate skipped, mints token", async () => {
    const { prisma } = await import("@/lib/prisma");
    const mockTokenCreate = vi.fn().mockResolvedValue({ id: "token-sa" });
    mockDelegates(prisma).mcpAuthorizationCode = {
      findUnique: vi.fn().mockResolvedValue(codeRow({ userId: null, serviceAccountId: "sa-2" })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    };
    mockDelegates(prisma).mcpAccessToken = { create: mockTokenCreate };
    // Passkey would block a human — but SA-bound (userId:null) skips the gate.
    addPasskeyStateMocks(prisma, { requirePasskey: true, hasPasskey: false });
    mockDelegates(prisma).tenant = {
      findUnique: vi.fn().mockResolvedValue({
        requirePasskey: true,
        requirePasskeyEnabledAt: new Date("2020-01-01T00:00:00.000Z"),
        passkeyGracePeriodDays: 7,
      }),
    };

    const result = await exchangeCodeForToken({
      code: "pk-test-verifier-string-for-test",
      clientId: "mcpc_test",
      clientSecretHash: "",
      redirectUri: "https://example.com/callback",
      codeVerifier: "pk-test-verifier-string-for-test",
    });

    expect(result.ok).toBe(true);
    expect(mockTokenCreate).toHaveBeenCalledOnce();
  });

  it("non-blocked user (requirePasskey=false) ⇒ mints token", async () => {
    const verifier = "nonblocked-verifier-string-for-test";
    const challenge = computeS256Challenge(verifier);
    const { prisma } = await import("@/lib/prisma");
    const mockTokenCreate = vi.fn().mockResolvedValue({ id: "token-ok" });
    mockDelegates(prisma).mcpAuthorizationCode = {
      findUnique: vi.fn().mockResolvedValue(codeRow({ codeChallenge: challenge })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    };
    mockDelegates(prisma).mcpAccessToken = { create: mockTokenCreate };
    addPasskeyStateMocks(prisma); // requirePasskey=false, hasPasskey=true → non-blocking

    const result = await exchangeCodeForToken({
      code: "anything",
      clientId: "mcpc_test",
      clientSecretHash: "",
      redirectUri: "https://example.com/callback",
      codeVerifier: verifier,
    });

    expect(result.ok).toBe(true);
    expect(mockTokenCreate).toHaveBeenCalledOnce();
  });
});
