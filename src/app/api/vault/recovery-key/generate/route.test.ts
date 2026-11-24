import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";
import { assertRedisFailClosed, snapshotFactory } from "@/__tests__/helpers/fail-closed";

const {
  mockAuth,
  mockPrismaUser,
  mockTxUpdateMany,
  mockTxs,
  mockRateLimiter,
  mockCreateRateLimiter,
  mockLogAudit,
  mockLogAuditInTx,
  mockWithUserTenantRls,
  mockWithTenantRls,
} = vi.hoisted(() => {
  const mockRateLimiter = { check: vi.fn() };
  // Each withTenantRls call hands its callback a fresh tx with its own spies,
  // recorded in mockTxs, so a write on the ambient client (only the snapshot
  // read may use it) is distinguishable from one on the audited tx.
  // mockTxUpdateMany is the behaviour (the CAS row count) every tx delegates to.
  const mockTxUpdateMany = vi.fn();
  const mockTxs: { user: { update: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> } }[] = [];
  const mockWithTenantRls = vi.fn(async (_p: unknown, _t: unknown, fn: (tx: unknown) => unknown) => {
    const tx = {
      user: { update: vi.fn(), updateMany: vi.fn((args: unknown) => mockTxUpdateMany(args)) },
    };
    mockTxs.push(tx);
    return fn(tx);
  });
  return {
    mockAuth: vi.fn(),
    mockPrismaUser: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    mockTxUpdateMany,
    mockTxs,
    mockRateLimiter,
    mockCreateRateLimiter: vi.fn(() => mockRateLimiter),
    mockLogAudit: vi.fn(),
    mockLogAuditInTx: vi.fn(),
    mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
    mockWithTenantRls,
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
  hmacVerifier: vi.fn((v: string) => `hmac_${v}`),
  verifyPassphraseVerifier: vi.fn((client: string, stored: string, _storedVersion: number) =>
    client === stored ? ({ ok: true } as const) : ({ ok: false, reason: "WRONG_PASSPHRASE" } as const)
  ),
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

import { VERIFIER_VERSION } from "@/lib/crypto/verifier-version";
import { POST } from "./route";

// Captured immediately after import (before any beforeEach clears mocks) —
// the module-level `const generateLimiter = createRateLimiter(...)` call
// happens at import time.
const generateLimiterFactoryRecord = snapshotFactory(mockCreateRateLimiter);

const validBody = {
  currentVerifierHash: "a".repeat(64),
  encryptedSecretKey: "encrypted-recovery-data",
  secretKeyIv: "b".repeat(24),
  secretKeyAuthTag: "c".repeat(32),
  hkdfSalt: "d".repeat(64),
  verifierHash: "e".repeat(64),
};

const userWithVault = {
  vaultSetupAt: new Date(),
  passphraseVerifierHmac: "a".repeat(64),
  passphraseVerifierVersion: 1,
  recoveryVerifierVersion: 1,
  recoveryKeySetAt: null,
  recoveryKeyInvalidatedAt: null,
  keyVersion: 3,
  accountSalt: "9".repeat(64),
  tenantId: "test-tenant-id",
};

const URL = "http://localhost/api/vault/recovery-key/generate";

describe("POST /api/vault/recovery-key/generate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRateLimiter.check.mockResolvedValue({ allowed: true });
    mockPrismaUser.findUnique.mockResolvedValue(userWithVault);
    mockTxs.length = 0;
    mockTxUpdateMany.mockResolvedValue({ count: 1 });
    // Resolves like the real client so a write misrouted to the ambient
    // client is caught by the assertions on it, not by a crash.
    mockPrismaUser.update.mockResolvedValue({});
    mockPrismaUser.updateMany.mockResolvedValue({ count: 1 });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(createRequest("POST", URL, { body: validBody }));
    expect(res.status).toBe(401);
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimiter.check.mockResolvedValue({ allowed: false });
    const res = await POST(createRequest("POST", URL, { body: validBody }));
    expect(res.status).toBe(429);
  });

  it("fails closed (503, no mutation) when Redis is unavailable", async () => {
    await assertRedisFailClosed({
      invoke: () => POST(createRequest("POST", URL, { body: validBody })),
      limiter: mockRateLimiter,
      expectation: { envelope: "canonical" },
      assertNoMutation: [mockPrismaUser.update, mockPrismaUser.updateMany, mockTxUpdateMany],
      limiterFactory: generateLimiterFactoryRecord.replay(),
      failure: { allowed: false, redisErrored: true },
    });
  });

  it("returns 400 on invalid body", async () => {
    const res = await POST(createRequest("POST", URL, { body: { foo: "bar" } }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_ERROR");
    expect(json.details).toHaveProperty("properties");
  });

  it("returns 404 when vault not set up", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({ vaultSetupAt: null });
    const res = await POST(createRequest("POST", URL, { body: validBody }));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("VAULT_NOT_SETUP");
  });

  it("returns 409 when verifier not set", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({
      ...userWithVault,
      passphraseVerifierHmac: null,
    });
    const res = await POST(createRequest("POST", URL, { body: validBody }));
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
    });
    await POST(createRequest("POST", URL, { body: validBody }));
    expect(mockVerify).toHaveBeenCalledWith(
      validBody.currentVerifierHash,
      userWithVault.passphraseVerifierHmac,
      999,
    );
  });

  it("returns 401 when passphrase verification fails", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({
      ...userWithVault,
      passphraseVerifierHmac: "f".repeat(64),
    });
    const res = await POST(createRequest("POST", URL, { body: validBody }));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("INVALID_PASSPHRASE");
  });

  it("saves recovery key data and logs RECOVERY_KEY_CREATED", async () => {
    const res = await POST(createRequest("POST", URL, { body: validBody }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);

    expect(mockTxs).toHaveLength(1);
    expect(mockTxs[0].user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "user-1", accountSalt: userWithVault.accountSalt, keyVersion: userWithVault.keyVersion },
        data: expect.objectContaining({
          recoveryEncryptedSecretKey: validBody.encryptedSecretKey,
          recoverySecretKeyIv: validBody.secretKeyIv,
          recoverySecretKeyAuthTag: validBody.secretKeyAuthTag,
          recoveryHkdfSalt: validBody.hkdfSalt,
          recoveryVerifierHmac: `hmac_${validBody.verifierHash}`,
          recoveryVerifierVersion: VERIFIER_VERSION,
        }),
      }),
    );

    expect(mockLogAuditInTx).toHaveBeenCalledWith(
      mockTxs[0],
      "test-tenant-id",
      expect.objectContaining({
        action: "RECOVERY_KEY_CREATED",
        userId: "user-1",
        metadata: { keyVersion: userWithVault.keyVersion },
      }),
    );
  });

  it("writes the wrap only through the transaction, never the ambient client", async () => {
    const res = await POST(createRequest("POST", URL, { body: validBody }));

    expect(res.status).toBe(200);
    expect(mockTxs[0].user.updateMany).toHaveBeenCalledTimes(1);
    expect(mockPrismaUser.update).not.toHaveBeenCalled();
    expect(mockPrismaUser.updateMany).not.toHaveBeenCalled();
  });

  it("writes its audit row in the wrap's transaction, not post-commit", async () => {
    await POST(createRequest("POST", URL, { body: validBody }));

    expect(mockLogAuditInTx).toHaveBeenCalledTimes(1);
    expect(mockLogAuditInTx.mock.calls[0][0]).toBe(mockTxs[0]);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("returns 409 VAULT_WRAP_CONFLICT when the vault wrap moved since the snapshot", async () => {
    // A rotate-key (or another wrapping writer) committed between the verifier
    // check and the write: the CAS on the snapshot's accountSalt/keyVersion
    // matches no row.
    mockTxUpdateMany.mockResolvedValue({ count: 0 });

    const res = await POST(createRequest("POST", URL, { body: validBody }));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "VAULT_WRAP_CONFLICT" });
  });

  it("writes no audit row when the compare-and-swap loses", async () => {
    mockTxUpdateMany.mockResolvedValue({ count: 0 });

    await POST(createRequest("POST", URL, { body: validBody }));

    expect(mockLogAuditInTx).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("logs RECOVERY_KEY_REGENERATED when recovery key already exists", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({
      ...userWithVault,
      recoveryKeySetAt: new Date("2025-01-01"),
      recoveryKeyInvalidatedAt: null,
    });

    const res = await POST(createRequest("POST", URL, { body: validBody }));
    expect(res.status).toBe(200);

    expect(mockLogAuditInTx).toHaveBeenCalledWith(
      mockTxs[0],
      "test-tenant-id",
      expect.objectContaining({
        action: "RECOVERY_KEY_REGENERATED",
      }),
    );
  });

  it("logs RECOVERY_KEY_REGENERATED when recovery was invalidated by rotation (#433/F21+S5)", async () => {
    // Post-rotation state: recoveryKeySetAt was cleared during rotation,
    // recoveryKeyInvalidatedAt was stamped. The user clicks regenerate.
    // Per F21 the action MUST be REGENERATED (not CREATED) so the audit
    // trail and dialog UX both reflect "lost via rotation, re-generating"
    // instead of first-time setup.
    mockPrismaUser.findUnique.mockResolvedValue({
      ...userWithVault,
      recoveryKeySetAt: null,
      recoveryKeyInvalidatedAt: new Date(),
    });

    const res = await POST(createRequest("POST", URL, { body: validBody }));
    expect(res.status).toBe(200);

    expect(mockLogAuditInTx).toHaveBeenCalledWith(
      mockTxs[0],
      "test-tenant-id",
      expect.objectContaining({
        action: "RECOVERY_KEY_REGENERATED",
      }),
    );
  });

  it("answers 503 SERVICE_UNAVAILABLE, audits once and writes nothing when the pepper version is missing", async () => {
    const { verifyPassphraseVerifier } = await import("@/lib/crypto/crypto-server");
    vi.mocked(verifyPassphraseVerifier).mockReturnValueOnce({ ok: false, reason: "MISSING_PEPPER_VERSION" });

    const res = await POST(createRequest("POST", URL, { body: validBody }));
    const json = await res.json();

    expect(res.status).toBe(503);
    expect(json.error).toBe("SERVICE_UNAVAILABLE");
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "VERIFIER_PEPPER_MISSING",
        scope: "TENANT",
        userId: "user-1",
        tenantId: "test-tenant-id",
      }),
    );
    expect(mockWithTenantRls).not.toHaveBeenCalled();
    expect(mockPrismaUser.update).not.toHaveBeenCalled();
    expect(mockPrismaUser.updateMany).not.toHaveBeenCalled();
    expect(mockLogAuditInTx).not.toHaveBeenCalled();
  });
});
