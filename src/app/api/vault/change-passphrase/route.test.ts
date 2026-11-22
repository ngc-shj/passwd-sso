import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";
import { assertRedisFailClosed, snapshotFactory } from "@/__tests__/helpers/fail-closed";

const { mockAuth, mockPrismaUser, mockTx, mockRateLimiter, mockCreateRateLimiter, mockLogAudit, mockLogAuditInTx, mockWithUserTenantRls, mockWithTenantRls, mockInvalidateUserSessions } = vi.hoisted(() => {
  const mockRateLimiter = { check: vi.fn() };
  const mockPrismaUser = { findUnique: vi.fn(), update: vi.fn() };
  // The tx withTenantRls hands its callback; its user.update is the same spy
  // the ambient path used, so update-arg assertions still see it.
  const mockTx = { user: mockPrismaUser };
  return {
  mockAuth: vi.fn(),
  mockPrismaUser,
  mockTx,
  mockRateLimiter,
  // Recording factory — assertRedisFailClosed's factory-attribution step
  // reads mockCreateRateLimiter.mock.{calls,results}.
  mockCreateRateLimiter: vi.fn((_opts: unknown) => mockRateLimiter),
  mockLogAudit: vi.fn(),
  mockLogAuditInTx: vi.fn(),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
  mockWithTenantRls: vi.fn(async (_p: unknown, _t: unknown, fn: (tx: unknown) => unknown) => fn(mockTx)),
  mockInvalidateUserSessions: vi.fn().mockResolvedValue({
    sessions: 0,
    extensionTokens: 0,
    apiKeys: 0,
    mcpAccessTokens: 0,
    mcpRefreshTokens: 0,
    delegationSessions: 0,
    operatorTokens: 0,
    cacheTombstoneFailures: 0,
  }),
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { user: mockPrismaUser },
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: mockCreateRateLimiter,
}));
vi.mock("@/lib/crypto/crypto-server", () => ({
  hmacVerifier: vi.fn((v: string) => v),
  verifyPassphraseVerifier: vi.fn((client: string, stored: string, _v: number) => client === stored ? ({ ok: true } as const) : ({ ok: false, reason: "WRONG_PASSPHRASE" } as const)),
}));
vi.mock("@/lib/crypto/verifier-version", () => ({
  VERIFIER_VERSION: 1,
  getCurrentVerifierVersion: () => 1,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  logAuditInTx: mockLogAuditInTx,
  extractRequestMeta: vi.fn(() => ({ ip: "127.0.0.1", userAgent: "test" })),
  personalAuditBase: vi.fn((_, userId) => ({ scope: "PERSONAL", userId })),
  tenantAuditBase: vi.fn((_, userId, tenantId) => ({ scope: "TENANT", userId, tenantId })),
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/tenant-rls", () => ({
  withTenantRls: mockWithTenantRls,
}));
vi.mock("@/lib/logger", () => ({
  default: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("@/lib/auth/session/user-session-invalidation", () => ({
  invalidateUserSessions: mockInvalidateUserSessions,
}));

import { POST } from "./route";

// Module-scope snapshot (route.ts:33 `const changeLimiter = createRateLimiter(...)`
// runs at import time, above). See fail-closed.ts module doc.
const changeLimiterFactorySnapshot = snapshotFactory(mockCreateRateLimiter);
const changeLimiter = mockCreateRateLimiter.mock.results[0]!.value as {
  check: typeof mockRateLimiter.check;
};

const validBody = {
  currentVerifierHash: "a".repeat(64),
  encryptedSecretKey: "encrypted-key-data",
  secretKeyIv: "b".repeat(24),
  secretKeyAuthTag: "c".repeat(32),
  accountSalt: "d".repeat(64),
  newVerifierHash: "e".repeat(64),
};

const userWithVault = {
  vaultSetupAt: new Date(),
  passphraseVerifierHmac: "a".repeat(64),
  passphraseVerifierVersion: 1,
  tenantId: "test-tenant-id",
};

// Cookie fixtures use the plain `authjs.session-token` name, the configured
// name only over http; pin that so a shell-exported AUTH_URL cannot flip it.
beforeEach(() => {
  vi.stubEnv("AUTH_URL", "http://localhost:3000");
  vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/vault/change-passphrase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRateLimiter.check.mockResolvedValue({ allowed: true });
    mockPrismaUser.findUnique.mockResolvedValue(userWithVault);
    mockPrismaUser.update.mockResolvedValue({});
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(createRequest("POST", "http://localhost/api/vault/change-passphrase", { body: validBody }));
    expect(res.status).toBe(401);
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimiter.check.mockResolvedValue({ allowed: false });
    const res = await POST(createRequest("POST", "http://localhost/api/vault/change-passphrase", { body: validBody }));
    expect(res.status).toBe(429);
  });

  it("fails closed (503, no mutation) when Redis is unavailable", async () => {
    await assertRedisFailClosed({
      invoke: () =>
        POST(createRequest("POST", "http://localhost/api/vault/change-passphrase", { body: validBody })),
      limiter: changeLimiter,
      expectation: { envelope: "canonical" },
      assertNoMutation: [mockPrismaUser.update, mockInvalidateUserSessions],
      limiterFactory: changeLimiterFactorySnapshot.replay(),
      failure: { allowed: false, redisErrored: true },
    });
  });

  it("returns 400 on malformed JSON", async () => {
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/vault/change-passphrase", {
      method: "POST",
      body: "not-json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("INVALID_JSON");
  });

  it("returns 400 on invalid body (missing fields)", async () => {
    const res = await POST(createRequest("POST", "http://localhost/api/vault/change-passphrase", { body: { currentVerifierHash: "short" } }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_ERROR");
    expect(json.details).toHaveProperty("properties");
  });

  it("returns 400 when secretKeyIv has wrong length", async () => {
    const res = await POST(createRequest("POST", "http://localhost/api/vault/change-passphrase", {
      body: { ...validBody, secretKeyIv: "tooshort" },
    }));
    expect(res.status).toBe(400);
  });

  it("returns 404 when vault not set up", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({ vaultSetupAt: null });
    const res = await POST(createRequest("POST", "http://localhost/api/vault/change-passphrase", { body: validBody }));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("VAULT_NOT_SETUP");
  });

  it("returns 409 when verifier not set", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({
      ...userWithVault,
      passphraseVerifierHmac: null,
    });
    const res = await POST(createRequest("POST", "http://localhost/api/vault/change-passphrase", { body: validBody }));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("VERIFIER_NOT_SET");
  });

  it("forwards user.passphraseVerifierVersion (read from DB) to verifyPassphraseVerifier", async () => {
    const { verifyPassphraseVerifier } = await import("@/lib/crypto/crypto-server");
    const mockVerify = vi.mocked(verifyPassphraseVerifier);
    mockPrismaUser.findUnique.mockResolvedValue({
      ...userWithVault,
      passphraseVerifierVersion: 999,
      tenantId: "test-tenant-id",
    });
    await POST(createRequest("POST", "http://localhost/api/vault/change-passphrase", { body: validBody }));
    expect(mockVerify).toHaveBeenCalledWith(
      validBody.currentVerifierHash,
      userWithVault.passphraseVerifierHmac,
      999,
    );
  });

  it("returns 401 when current passphrase is wrong", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({
      ...userWithVault,
      passphraseVerifierHmac: "f".repeat(64), // different from currentVerifierHash
    });
    const res = await POST(createRequest("POST", "http://localhost/api/vault/change-passphrase", { body: validBody }));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("INVALID_PASSPHRASE");
  });

  it("successfully changes passphrase (200)", async () => {
    const res = await POST(createRequest("POST", "http://localhost/api/vault/change-passphrase", { body: validBody }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(mockPrismaUser.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "user-1" },
        data: expect.objectContaining({
          accountSalt: validBody.accountSalt,
          encryptedSecretKey: validBody.encryptedSecretKey,
          secretKeyIv: validBody.secretKeyIv,
          secretKeyAuthTag: validBody.secretKeyAuthTag,
        }),
      })
    );
  });

  it("passes excludeSessionToken to invalidateUserSessions to preserve the caller's current session", async () => {
    // Regression guard for the bug class fixed in passkey/verify:
    // a successful passphrase change must NOT wipe the caller's own
    // session via the global cascade. The excludeSessionToken option
    // (resolved from the request cookie) is the mechanism that keeps
    // the caller signed in while every other bearer credential is
    // revoked.
    const SESSION_TOKEN = "7e57-5e55-c00c1e";
    const res = await POST(createRequest("POST", "http://localhost/api/vault/change-passphrase", {
      body: validBody,
      headers: { cookie: `authjs.session-token=${SESSION_TOKEN}` },
    }));
    expect(res.status).toBe(200);
    expect(mockInvalidateUserSessions).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        allTenants: true,
        excludeSessionToken: SESSION_TOKEN,
      }),
    );
  });

  it("emits VERIFIER_PEPPER_MISSING audit and returns 401 when pepper version is missing", async () => {
    const { verifyPassphraseVerifier } = await import("@/lib/crypto/crypto-server");
    vi.mocked(verifyPassphraseVerifier).mockReturnValueOnce({ ok: false, reason: "MISSING_PEPPER_VERSION" });

    const res = await POST(createRequest("POST", "http://localhost/api/vault/change-passphrase", { body: validBody }));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe("INVALID_PASSPHRASE");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "VERIFIER_PEPPER_MISSING",
        scope: "TENANT",
        userId: "user-1",
        tenantId: "test-tenant-id",
      }),
    );
  });
  describe("VAULT_PASSPHRASE_CHANGE audit", () => {
    const post = () =>
      POST(createRequest("POST", "http://localhost/api/vault/change-passphrase", { body: validBody }));
    const completionCalls = () =>
      mockLogAudit.mock.calls.filter(
        ([params]) => (params as { action?: string }).action === "VAULT_PASSPHRASE_CHANGE",
      );

    it("records the committed change inside the transaction that updates the user", async () => {
      const res = await post();

      expect(res.status).toBe(200);
      expect(mockWithTenantRls).toHaveBeenCalledWith(expect.anything(), "test-tenant-id", expect.any(Function));
      expect(mockLogAuditInTx).toHaveBeenCalledTimes(1);
      expect(mockLogAuditInTx).toHaveBeenCalledWith(
        mockTx,
        "test-tenant-id",
        expect.objectContaining({
          action: "VAULT_PASSPHRASE_CHANGE",
          scope: "PERSONAL",
          userId: "user-1",
          metadata: { phase: "committed" },
        }),
      );
    });

    it("records the completion with invalidationFailed false and the revoked counts when invalidation succeeds", async () => {
      mockInvalidateUserSessions.mockResolvedValueOnce({
        sessions: 2,
        extensionTokens: 1,
        apiKeys: 0,
        mcpAccessTokens: 0,
        mcpRefreshTokens: 0,
        delegationSessions: 0,
        operatorTokens: 0,
        cacheTombstoneFailures: 0,
      });

      const res = await post();

      expect(res.status).toBe(200);
      expect(completionCalls()).toHaveLength(1);
      expect(completionCalls()[0][0]).toEqual(
        expect.objectContaining({
          scope: "PERSONAL",
          userId: "user-1",
          metadata: expect.objectContaining({
            phase: "completed",
            invalidationFailed: false,
            invalidatedSessions: 2,
            invalidatedExtensionTokens: 1,
          }),
        }),
      );
    });

    it("records the completion with invalidationFailed true and returns SESSION_INVALIDATE_FAILED when invalidation throws", async () => {
      mockInvalidateUserSessions.mockRejectedValueOnce(new Error("db down"));

      const res = await post();

      expect(res.status).toBe(500);
      expect((await res.json()).error).toBe("SESSION_INVALIDATE_FAILED");
      expect(mockLogAuditInTx).toHaveBeenCalledTimes(1);
      expect(completionCalls()).toHaveLength(1);
      expect(completionCalls()[0][0]).toEqual(
        expect.objectContaining({
          metadata: expect.objectContaining({
            phase: "completed",
            invalidationFailed: true,
            invalidatedSessions: null,
          }),
        }),
      );
    });

    it("writes no passphrase-change audit when the current passphrase is wrong", async () => {
      mockPrismaUser.findUnique.mockResolvedValue({
        ...userWithVault,
        passphraseVerifierHmac: "f".repeat(64),
      });

      const res = await post();

      expect(res.status).toBe(401);
      expect(mockLogAuditInTx).not.toHaveBeenCalled();
      expect(completionCalls()).toHaveLength(0);
    });
  });
});
