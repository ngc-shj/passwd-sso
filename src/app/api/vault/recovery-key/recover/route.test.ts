import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";
import { assertRedisFailClosed, snapshotFactory } from "@/__tests__/helpers/fail-closed";

const { mockAuth, mockPrismaUser, mockVerifyCheck, mockResetCheck, mockResetClear, mockLogAudit, mockWithUserTenantRls, mockInvalidateUserSessions, mockCreateRateLimiter } = vi.hoisted(() => {
  const mockVerifyCheck = vi.fn().mockResolvedValue({ allowed: true });
  const mockResetCheck = vi.fn().mockResolvedValue({ allowed: true });
  const mockResetClear = vi.fn();
  return {
    mockAuth: vi.fn(),
    mockPrismaUser: { findUnique: vi.fn(), update: vi.fn() },
    mockVerifyCheck,
    mockResetCheck,
    mockResetClear,
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
    // Recording factory: verifyLimiter created first (route.ts :49), then
    // resetLimiter (route.ts :54) — mockReturnValueOnce chain preserves
    // that creation-order mapping while giving each a distinct check mock.
    mockCreateRateLimiter: vi.fn()
      .mockReturnValueOnce({ check: mockVerifyCheck, clear: vi.fn() })
      .mockReturnValueOnce({ check: mockResetCheck, clear: mockResetClear }),
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
  verifyPassphraseVerifier: vi.fn((client: string, stored: string, _v: number) => client === stored ? ({ ok: true } as const) : ({ ok: false, reason: "WRONG_PASSPHRASE" } as const)),
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
import { VERIFIER_VERSION } from "@/lib/crypto/verifier-version";

// Captured immediately after import (before any beforeEach clears mocks) —
// both module-level limiter constructions (verifyLimiter then resetLimiter,
// route.ts :49/:54) happen once at import time. mock.results[0]/[1] map to
// creation order, matching the mockReturnValueOnce chain above.
const recoverLimiterFactoryRecord = snapshotFactory(mockCreateRateLimiter);
const verifyLimiter = mockCreateRateLimiter.mock.results[0]?.value as {
  check: typeof mockVerifyCheck;
  clear: ReturnType<typeof vi.fn>;
};
const resetLimiterUnderTest = mockCreateRateLimiter.mock.results[1]?.value as {
  check: typeof mockResetCheck;
  clear: typeof mockResetClear;
};

const URL = "http://localhost/api/vault/recovery-key/recover";

const userWithRecovery = {
  recoveryVerifierHmac: "a".repeat(64),
  recoveryVerifierVersion: 1,
  recoveryEncryptedSecretKey: "enc-data",
  recoverySecretKeyIv: "b".repeat(24),
  recoverySecretKeyAuthTag: "c".repeat(32),
  recoveryHkdfSalt: "d".repeat(64),
  accountSalt: "e".repeat(64),
  keyVersion: 1,
  tenantId: "test-tenant-id",
};

const resetBody = {
  step: "reset" as const,
  verifierHash: "a".repeat(64),
  encryptedSecretKey: "new-enc-data",
  secretKeyIv: "b".repeat(24),
  secretKeyAuthTag: "c".repeat(32),
  accountSalt: "d".repeat(64),
  newVerifierHash: "e".repeat(64),
  recoveryEncryptedSecretKey: "new-recovery-enc",
  recoverySecretKeyIv: "f".repeat(24),
  recoverySecretKeyAuthTag: "a".repeat(32),
  recoveryHkdfSalt: "b".repeat(64),
  recoveryVerifierHash: "c".repeat(64),
};

describe("POST /api/vault/recovery-key/recover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockVerifyCheck.mockResolvedValue({ allowed: true });
    mockResetCheck.mockResolvedValue({ allowed: true });
    mockResetClear.mockResolvedValue(undefined);
    mockPrismaUser.findUnique.mockResolvedValue(userWithRecovery);
    mockPrismaUser.update.mockResolvedValue({});
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(createRequest("POST", URL, {
      body: { step: "verify", verifierHash: "a".repeat(64) },
    }));
    expect(res.status).toBe(401);
  });

  it("returns 429 when rate limited", async () => {
    mockVerifyCheck.mockResolvedValue({ allowed: false, retryAfterMs: 30_000 });
    const res = await POST(createRequest("POST", URL, {
      body: { step: "verify", verifierHash: "a".repeat(64) },
    }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
  });

  it("fails closed (503, no mutation) when Redis is unavailable — verify", async () => {
    await assertRedisFailClosed({
      invoke: () => POST(createRequest("POST", URL, {
        body: { step: "verify", verifierHash: "a".repeat(64) },
      })),
      limiter: verifyLimiter,
      expectation: { envelope: "canonical" },
      assertNoMutation: [mockPrismaUser.update],
      limiterFactory: recoverLimiterFactoryRecord.replay(),
      failure: { allowed: false, redisErrored: true },
    });
  });

  it("fails closed (503, no mutation) when Redis is unavailable — reset", async () => {
    await assertRedisFailClosed({
      invoke: () => POST(createRequest("POST", URL, { body: resetBody })),
      limiter: resetLimiterUnderTest,
      expectation: { envelope: "canonical" },
      assertNoMutation: [mockPrismaUser.update],
      limiterFactory: recoverLimiterFactoryRecord.replay(),
      failure: { allowed: false, redisErrored: true },
    });
  });

  // ─── Step: verify ─────────────────────────────────────────

  describe("step=verify", () => {
    it("returns encrypted data on valid recovery key", async () => {
      const res = await POST(createRequest("POST", URL, {
        body: { step: "verify", verifierHash: "a".repeat(64) },
      }));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.verified).toBe(true);
      expect(json.encryptedSecretKey).toBe("enc-data");
      expect(json.hkdfSalt).toBe("d".repeat(64));
      expect(json).not.toHaveProperty("recoveryVerifierHmac");
    });

    it("returns 401 on invalid recovery key", async () => {
      const res = await POST(createRequest("POST", URL, {
        body: { step: "verify", verifierHash: "f".repeat(64) },
      }));
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toBe("INVALID_RECOVERY_KEY");
    });

    it("emits VERIFIER_PEPPER_MISSING audit and returns 401 when pepper version is missing", async () => {
      const { verifyPassphraseVerifier } = await import("@/lib/crypto/crypto-server");
      vi.mocked(verifyPassphraseVerifier).mockReturnValueOnce({ ok: false, reason: "MISSING_PEPPER_VERSION" });

      const res = await POST(createRequest("POST", URL, {
        body: { step: "verify", verifierHash: "a".repeat(64) },
      }));
      expect(res.status).toBe(401);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "VERIFIER_PEPPER_MISSING",
          scope: "TENANT",
          tenantId: "test-tenant-id",
        }),
      );
    });

    it("returns 404 when recovery key not set", async () => {
      mockPrismaUser.findUnique.mockResolvedValue({
        ...userWithRecovery,
        recoveryVerifierHmac: null,
      });
      const res = await POST(createRequest("POST", URL, {
        body: { step: "verify", verifierHash: "a".repeat(64) },
      }));
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe("RECOVERY_KEY_NOT_SET");
    });
  });

  // ─── Step: reset ──────────────────────────────────────────

  it("blocks reset step when resetLimiter denies", async () => {
    mockResetCheck.mockResolvedValueOnce({ allowed: false, retryAfterMs: 30_000 });
    const res = await POST(createRequest("POST", URL, { body: resetBody }));
    expect(res.status).toBe(429);
  });

  it("does not block verify when resetLimiter would deny", async () => {
    // resetLimiter is not consulted for the "verify" step, so only verifyLimiter matters
    mockVerifyCheck.mockResolvedValue({ allowed: true });
    mockResetCheck.mockResolvedValue({ allowed: false, retryAfterMs: 30_000 });
    const res = await POST(createRequest("POST", URL, {
      body: { step: "verify", verifierHash: "a".repeat(64) },
    }));
    expect(res.status).not.toBe(429);
  });

  it("calls resetLimiter.clear() on successful reset", async () => {
    const res = await POST(createRequest("POST", URL, { body: resetBody }));
    expect(res.status).toBe(200);
    expect(mockResetClear).toHaveBeenCalledWith(`rl:recovery_reset:user-1`);
  });

  describe("step=reset", () => {
    it("updates passphrase and recovery data on success", async () => {
      const res = await POST(createRequest("POST", URL, { body: resetBody }));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);

      expect(mockPrismaUser.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "user-1" },
          data: expect.objectContaining({
            encryptedSecretKey: resetBody.encryptedSecretKey,
            accountSalt: resetBody.accountSalt,
            passphraseVerifierHmac: `hmac_${resetBody.newVerifierHash}`,
            passphraseVerifierVersion: VERIFIER_VERSION,
            recoveryEncryptedSecretKey: resetBody.recoveryEncryptedSecretKey,
            recoveryVerifierVersion: VERIFIER_VERSION,
            failedUnlockAttempts: 0,
            lastFailedUnlockAt: null,
            accountLockedUntil: null,
          }),
        }),
      );

      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "RECOVERY_PASSPHRASE_RESET",
          userId: "user-1",
          metadata: expect.objectContaining({
            keyVersion: 1,
            recoveryKeyRegenerated: true,
            lockoutReset: true,
          }),
        }),
      );
    });

    it("passes excludeSessionToken to invalidateUserSessions to preserve the caller's current session", async () => {
      // Regression guard for the bug class fixed in passkey/verify:
      // a successful recovery reset must NOT wipe the caller's own
      // session via the global cascade. The excludeSessionToken option
      // (resolved from the request cookie) is the mechanism that keeps
      // the caller signed in while every other bearer credential is
      // revoked.
      const SESSION_TOKEN = "test-session-cookie-value";
      const res = await POST(createRequest("POST", URL, {
        body: resetBody,
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

    it("returns 401 on invalid verifier in reset step", async () => {
      const res = await POST(createRequest("POST", URL, {
        body: { ...resetBody, verifierHash: "f".repeat(64) },
      }));
      expect(res.status).toBe(401);
    });

    it("emits VERIFIER_PEPPER_MISSING audit and returns 401 when pepper version is missing", async () => {
      const { verifyPassphraseVerifier } = await import("@/lib/crypto/crypto-server");
      vi.mocked(verifyPassphraseVerifier).mockReturnValueOnce({ ok: false, reason: "MISSING_PEPPER_VERSION" });

      const res = await POST(createRequest("POST", URL, { body: resetBody }));
      expect(res.status).toBe(401);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "VERIFIER_PEPPER_MISSING",
          scope: "TENANT",
          tenantId: "test-tenant-id",
        }),
      );
    });

    it("returns 400 on missing fields", async () => {
      const res = await POST(createRequest("POST", URL, {
        body: { step: "reset", verifierHash: "a".repeat(64) },
      }));
      expect(res.status).toBe(400);
    });

    it("rejects replay of a used recovery key after the recovery verifier has rotated", async () => {
      // First reset: succeeds. The recoveryVerifierHmac in the row is "a"*64
      // and the request's verifierHash is "a"*64, so verifyHmac (mocked as
      // strict equality) returns true and the row update fires.
      const firstRes = await POST(createRequest("POST", URL, { body: resetBody }));
      expect(firstRes.status).toBe(200);

      // Simulate the post-rotation DB state: the recoveryVerifierHmac in the
      // row is now hmac_<resetBody.recoveryVerifierHash>, since the legitimate
      // reset rotated the recovery key atomically with the passphrase change.
      mockPrismaUser.findUnique.mockResolvedValue({
        ...userWithRecovery,
        recoveryVerifierHmac: `hmac_${resetBody.recoveryVerifierHash}`,
      });

      // Replay the same request body: the attacker presents the OLD
      // verifierHash ("a"*64), but the stored verifier has rotated, so the
      // strict-equality mock returns false → INVALID_RECOVERY_KEY.
      const replayRes = await POST(createRequest("POST", URL, { body: resetBody }));
      expect(replayRes.status).toBe(401);
      const replayJson = await replayRes.json();
      expect(replayJson.error).toBe("INVALID_RECOVERY_KEY");
    });

    it("rejects replay even within the rate-limit window", async () => {
      // Force the rate limiter to allow both attempts so this test isolates
      // the verifier-rotation rejection path from rate-limit rejection.
      mockResetCheck.mockResolvedValue({ allowed: true });

      const firstRes = await POST(createRequest("POST", URL, { body: resetBody }));
      expect(firstRes.status).toBe(200);

      // Post-rotation state with rotated stored verifier.
      mockPrismaUser.findUnique.mockResolvedValue({
        ...userWithRecovery,
        recoveryVerifierHmac: `hmac_${resetBody.recoveryVerifierHash}`,
      });

      const replayRes = await POST(createRequest("POST", URL, { body: resetBody }));
      expect(replayRes.status).toBe(401);
      // The DB write must NOT have happened on replay.
      expect(mockPrismaUser.update).toHaveBeenCalledTimes(1);
    });
  });
});
