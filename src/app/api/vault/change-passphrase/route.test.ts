import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaUser, mockRateLimiter, mockLogAudit, mockWithUserTenantRls, mockInvalidateUserSessions } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaUser: { findUnique: vi.fn(), update: vi.fn() },
  mockRateLimiter: { check: vi.fn() },
  mockLogAudit: vi.fn(),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
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
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { user: mockPrismaUser },
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => mockRateLimiter,
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
  extractRequestMeta: vi.fn(() => ({ ip: "127.0.0.1", userAgent: "test" })),
  personalAuditBase: vi.fn((_, userId) => ({ scope: "PERSONAL", userId })),
  tenantAuditBase: vi.fn((_, userId, tenantId) => ({ scope: "TENANT", userId, tenantId })),
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
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
    const SESSION_TOKEN = "test-session-cookie-value";
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
});
