import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaUser, mockVerifyCheck, mockResetCheck, mockResetClear, mockLogAudit, mockWithUserTenantRls } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaUser: { findUnique: vi.fn(), update: vi.fn() },
  mockVerifyCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockResetCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockResetClear: vi.fn(),
  mockLogAudit: vi.fn(),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { user: mockPrismaUser },
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: vi.fn()
    .mockReturnValueOnce({ check: mockVerifyCheck, clear: vi.fn() })
    .mockReturnValueOnce({ check: mockResetCheck, clear: mockResetClear }),
}));
vi.mock("@/lib/crypto-server", () => ({
  hmacVerifier: vi.fn((v: string) => `hmac_${v}`),
  verifyPassphraseVerifier: vi.fn((client: string, stored: string) => client === stored),
}));
vi.mock("@/lib/auth/csrf", () => ({
  assertOrigin: vi.fn(() => null),
}));
vi.mock("@/lib/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: vi.fn(() => ({ ip: "127.0.0.1", userAgent: "test" })),
  personalAuditBase: vi.fn((_, userId) => ({ scope: "PERSONAL", userId })),
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/logger", () => ({
  default: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { POST } from "./route";

const URL = "http://localhost/api/vault/recovery-key/recover";

const userWithRecovery = {
  recoveryVerifierHmac: "a".repeat(64),
  recoveryEncryptedSecretKey: "enc-data",
  recoverySecretKeyIv: "b".repeat(24),
  recoverySecretKeyAuthTag: "c".repeat(32),
  recoveryHkdfSalt: "d".repeat(64),
  accountSalt: "e".repeat(64),
  keyVersion: 1,
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
            recoveryEncryptedSecretKey: resetBody.recoveryEncryptedSecretKey,
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

    it("returns 401 on invalid verifier in reset step", async () => {
      const res = await POST(createRequest("POST", URL, {
        body: { ...resetBody, verifierHash: "f".repeat(64) },
      }));
      expect(res.status).toBe(401);
    });

    it("returns 400 on missing fields", async () => {
      const res = await POST(createRequest("POST", URL, {
        body: { step: "reset", verifierHash: "a".repeat(64) },
      }));
      expect(res.status).toBe(400);
    });
  });
});
