import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockPrismaUser,
  mockPrismaTransaction,
  mockLogAudit,
  mockExtractRequestMeta,
  mockGetLogger,
  mockLoggerInstance,
} = vi.hoisted(() => {
  const mockLoggerInstance = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    mockPrismaUser: { findUnique: vi.fn(), update: vi.fn() },
    mockPrismaTransaction: vi.fn(),
    mockLogAudit: vi.fn(),
    mockExtractRequestMeta: vi.fn().mockReturnValue({ ip: null, userAgent: null }),
    mockGetLogger: vi.fn(() => mockLoggerInstance),
    mockLoggerInstance,
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: mockPrismaUser,
    $transaction: mockPrismaTransaction,
  },
}));
vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
  extractRequestMeta: mockExtractRequestMeta,
}));
vi.mock("@/lib/logger", () => ({
  default: { child: () => mockLoggerInstance },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: mockGetLogger,
}));
vi.mock("@/lib/constants", () => ({
  AUDIT_ACTION: {
    VAULT_UNLOCK_FAILED: "VAULT_UNLOCK_FAILED",
    VAULT_LOCKOUT_TRIGGERED: "VAULT_LOCKOUT_TRIGGERED",
  },
  AUDIT_SCOPE: { PERSONAL: "PERSONAL" },
}));

import { checkLockout, recordFailure, resetLockout } from "./account-lockout";

describe("checkLockout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns locked: false when user has no lock", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({ accountLockedUntil: null });
    const result = await checkLockout("user-1");
    expect(result).toEqual({ locked: false, lockedUntil: null });
  });

  it("returns locked: true when lock is active", async () => {
    const future = new Date(Date.now() + 60_000);
    mockPrismaUser.findUnique.mockResolvedValue({ accountLockedUntil: future });
    const result = await checkLockout("user-1");
    expect(result).toEqual({ locked: true, lockedUntil: future });
  });

  it("returns locked: false when lock has expired", async () => {
    const past = new Date(Date.now() - 1);
    mockPrismaUser.findUnique.mockResolvedValue({ accountLockedUntil: past });
    const result = await checkLockout("user-1");
    expect(result).toEqual({ locked: false, lockedUntil: null });
  });

  it("returns locked: false at exact expiry boundary", async () => {
    const now = new Date();
    vi.useFakeTimers({ now });
    mockPrismaUser.findUnique.mockResolvedValue({ accountLockedUntil: now });
    const result = await checkLockout("user-1");
    expect(result.locked).toBe(false);
    vi.useRealTimers();
  });
});

describe("recordFailure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setupTransaction(row: {
    failed_unlock_attempts: number;
    last_failed_unlock_at: Date | null;
    account_locked_until: Date | null;
  }) {
    mockPrismaTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        $executeRaw: vi.fn(),
        $queryRaw: vi.fn().mockResolvedValue([row]),
        user: { update: vi.fn() },
      };
      return fn(tx);
    });
  }

  it("increments counter on first failure", async () => {
    setupTransaction({
      failed_unlock_attempts: 0,
      last_failed_unlock_at: null,
      account_locked_until: null,
    });

    const result = await recordFailure("user-1");
    expect(result).not.toBeNull();
    expect(result!.attempts).toBe(1);
    expect(result!.locked).toBe(false);
  });

  it("locks after 5 failures (15 min)", async () => {
    setupTransaction({
      failed_unlock_attempts: 4,
      last_failed_unlock_at: new Date(),
      account_locked_until: null,
    });

    const result = await recordFailure("user-1");
    expect(result).not.toBeNull();
    expect(result!.attempts).toBe(5);
    expect(result!.locked).toBe(true);
    expect(result!.lockedUntil).toBeInstanceOf(Date);
  });

  it("locks after 10 failures (1 hour)", async () => {
    setupTransaction({
      failed_unlock_attempts: 9,
      last_failed_unlock_at: new Date(),
      account_locked_until: null,
    });

    const result = await recordFailure("user-1");
    expect(result).not.toBeNull();
    expect(result!.attempts).toBe(10);
    expect(result!.locked).toBe(true);
  });

  it("locks after 15 failures (24 hours)", async () => {
    setupTransaction({
      failed_unlock_attempts: 14,
      last_failed_unlock_at: new Date(),
      account_locked_until: null,
    });

    const result = await recordFailure("user-1");
    expect(result).not.toBeNull();
    expect(result!.attempts).toBe(15);
    expect(result!.locked).toBe(true);
  });

  it("maintains max lock duration beyond 15 failures", async () => {
    setupTransaction({
      failed_unlock_attempts: 20,
      last_failed_unlock_at: new Date(),
      account_locked_until: null,
    });

    const result = await recordFailure("user-1");
    expect(result).not.toBeNull();
    expect(result!.attempts).toBe(21);
    expect(result!.locked).toBe(true);
  });

  it("preserves monotonic increase of accountLockedUntil", async () => {
    const farFuture = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48h from now
    setupTransaction({
      failed_unlock_attempts: 4,
      last_failed_unlock_at: new Date(),
      account_locked_until: farFuture,
    });

    const result = await recordFailure("user-1");
    expect(result).not.toBeNull();
    // 5 failures = 15 min lock, but existing 48h lock is longer
    expect(result!.lockedUntil).toEqual(farFuture);
  });

  it("records VAULT_UNLOCK_FAILED audit on every failure", async () => {
    setupTransaction({
      failed_unlock_attempts: 0,
      last_failed_unlock_at: null,
      account_locked_until: null,
    });

    await recordFailure("user-1");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "VAULT_UNLOCK_FAILED",
        userId: "user-1",
        metadata: { attempts: 1 },
      }),
    );
  });

  it("records VAULT_LOCKOUT_TRIGGERED audit when threshold crossed", async () => {
    setupTransaction({
      failed_unlock_attempts: 4,
      last_failed_unlock_at: new Date(),
      account_locked_until: null,
    });

    await recordFailure("user-1");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "VAULT_LOCKOUT_TRIGGERED",
        userId: "user-1",
      }),
    );
    expect(mockLoggerInstance.warn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", lockMinutes: 15 }),
      "vault.lockout.triggered",
    );
  });

  it("resets counter when lastFailedUnlockAt is older than 24h (observation window)", async () => {
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25h ago
    setupTransaction({
      failed_unlock_attempts: 14,
      last_failed_unlock_at: oldDate,
      account_locked_until: null,
    });

    const result = await recordFailure("user-1");
    expect(result).not.toBeNull();
    // Counter should reset to 1, not increment to 15
    expect(result!.attempts).toBe(1);
    expect(result!.locked).toBe(false);
  });

  it("returns null on lock_timeout (counter not incremented)", async () => {
    const lockTimeoutError = Object.assign(new Error("lock timeout"), {
      code: "55P03",
    });
    mockPrismaTransaction.mockRejectedValue(lockTimeoutError);

    const result = await recordFailure("user-1");
    expect(result).toBeNull();
    expect(mockLoggerInstance.warn).toHaveBeenCalledWith(
      { userId: "user-1" },
      "vault.unlock.lockTimeout",
    );
  });

  it("records audit with reason: lock_timeout on lock_timeout", async () => {
    const lockTimeoutError = Object.assign(new Error("lock timeout"), {
      code: "55P03",
    });
    mockPrismaTransaction.mockRejectedValue(lockTimeoutError);

    await recordFailure("user-1");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "VAULT_UNLOCK_FAILED",
        metadata: { reason: "lock_timeout" },
      }),
    );
  });

  it("rethrows unexpected errors", async () => {
    mockPrismaTransaction.mockRejectedValue(new Error("unexpected"));
    await expect(recordFailure("user-1")).rejects.toThrow("unexpected");
  });
});

describe("resetLockout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resets all lockout fields", async () => {
    mockPrismaUser.update.mockResolvedValue({});
    await resetLockout("user-1");
    expect(mockPrismaUser.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: {
        failedUnlockAttempts: 0,
        lastFailedUnlockAt: null,
        accountLockedUntil: null,
      },
    });
  });

  it("swallows errors and logs them", async () => {
    mockPrismaUser.update.mockRejectedValue(new Error("db error"));
    // Should not throw
    await resetLockout("user-1");
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" }),
      "vault.lockout.resetLockout.error",
    );
  });
});
