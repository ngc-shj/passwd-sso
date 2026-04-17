import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockPrismaUser,
  mockPrismaTenant,
  mockPrismaTransaction,
  mockLogAudit,
  mockExtractRequestMeta,
  mockGetLogger,
  mockLoggerInstance,
  mockNotifyAdminsOfLockout,
} = vi.hoisted(() => {
  const mockLoggerInstance = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    mockPrismaUser: { findUnique: vi.fn(), update: vi.fn() },
    mockPrismaTenant: { findUnique: vi.fn() },
    mockPrismaTransaction: vi.fn(),
    mockLogAudit: vi.fn(),
    mockExtractRequestMeta: vi.fn().mockReturnValue({ ip: null, userAgent: null }),
    mockGetLogger: vi.fn(() => mockLoggerInstance),
    mockLoggerInstance,
    mockNotifyAdminsOfLockout: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: mockPrismaUser,
    tenant: mockPrismaTenant,
    $transaction: mockPrismaTransaction,
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: vi.fn((_prisma: unknown, fn: () => unknown) => fn()),
}));
vi.mock("@/lib/audit", () => ({
  logAuditAsync: mockLogAudit,
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
vi.mock("@/lib/lockout-admin-notify", () => ({
  notifyAdminsOfLockout: mockNotifyAdminsOfLockout,
}));

import { checkLockout, recordFailure, resetLockout, invalidateLockoutThresholdCache } from "./account-lockout";
import { MS_PER_HOUR, MS_PER_MINUTE } from "@/lib/constants/time";

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

  it("does not shorten existing accountLockedUntil (max of existing vs new)", async () => {
    // Simulates: existing 48h lock should not be replaced by a shorter 15min lock.
    // This verifies the max(existing, new) logic, not actual concurrent transactions
    // (which require integration tests with real DB row locking).
    const farFuture = new Date(Date.now() + 48 * MS_PER_HOUR); // 48h from now
    setupTransaction({
      failed_unlock_attempts: 4,
      last_failed_unlock_at: new Date(),
      account_locked_until: farFuture,
    });

    const result = await recordFailure("user-1");
    expect(result).not.toBeNull();
    // 5 failures = 15 min lock, but existing 48h lock is longer → preserved
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
    const oldDate = new Date(Date.now() - 25 * MS_PER_HOUR); // 25h ago
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

  it("returns null on lock_timeout with direct PG error (55P03)", async () => {
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

  it("returns null on lock_timeout with Prisma P2010 wrapper (meta.code 55P03)", async () => {
    const prismaError = Object.assign(new Error("Raw query failed"), {
      code: "P2010",
      meta: { code: "55P03" },
    });
    mockPrismaTransaction.mockRejectedValue(prismaError);

    const result = await recordFailure("user-1");
    expect(result).toBeNull();
    expect(mockLoggerInstance.warn).toHaveBeenCalledWith(
      { userId: "user-1" },
      "vault.unlock.lockTimeout",
    );
  });

  it("returns null on lock_timeout with cause-wrapped error (cause.code 55P03)", async () => {
    const wrappedError = Object.assign(new Error("transaction failed"), {
      cause: Object.assign(new Error("lock timeout"), { code: "55P03" }),
    });
    mockPrismaTransaction.mockRejectedValue(wrappedError);

    const result = await recordFailure("user-1");
    expect(result).toBeNull();
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

  it("calls notifyAdminsOfLockout when threshold 5 is first crossed (4→5)", async () => {
    setupTransaction({
      failed_unlock_attempts: 4,
      last_failed_unlock_at: new Date(),
      account_locked_until: null,
    });

    await recordFailure("user-1");
    expect(mockNotifyAdminsOfLockout).toHaveBeenCalledWith({
      userId: "user-1",
      attempts: 5,
      lockMinutes: 15,
      ip: null,
    });
  });

  it("calls notifyAdminsOfLockout when threshold 10 is first crossed (9→10)", async () => {
    setupTransaction({
      failed_unlock_attempts: 9,
      last_failed_unlock_at: new Date(),
      account_locked_until: null,
    });

    await recordFailure("user-1");
    expect(mockNotifyAdminsOfLockout).toHaveBeenCalledWith({
      userId: "user-1",
      attempts: 10,
      lockMinutes: 60,
      ip: null,
    });
  });

  it("calls notifyAdminsOfLockout when threshold 15 is first crossed (14→15)", async () => {
    setupTransaction({
      failed_unlock_attempts: 14,
      last_failed_unlock_at: new Date(),
      account_locked_until: null,
    });

    await recordFailure("user-1");
    expect(mockNotifyAdminsOfLockout).toHaveBeenCalledWith({
      userId: "user-1",
      attempts: 15,
      lockMinutes: 1440,
      ip: null,
    });
  });

  it("does NOT call notifyAdminsOfLockout on 5→6 (already past threshold)", async () => {
    setupTransaction({
      failed_unlock_attempts: 5,
      last_failed_unlock_at: new Date(),
      account_locked_until: null,
    });

    await recordFailure("user-1");
    expect(mockNotifyAdminsOfLockout).not.toHaveBeenCalled();
  });

  it("does NOT call notifyAdminsOfLockout when attempts < 5", async () => {
    setupTransaction({
      failed_unlock_attempts: 2,
      last_failed_unlock_at: new Date(),
      account_locked_until: null,
    });

    await recordFailure("user-1");
    expect(mockNotifyAdminsOfLockout).not.toHaveBeenCalled();
  });

  it("clears existing expired lock when new attempts do not reach threshold", async () => {
    // existingLockedUntil is set but already expired, newLockedUntil is null
    // (attempts < 5 → no new threshold) → finalLockedUntil becomes null
    const expiredLock = new Date(Date.now() - 60_000); // 1 min in the past
    setupTransaction({
      failed_unlock_attempts: 1,
      last_failed_unlock_at: new Date(),
      account_locked_until: expiredLock,
    });

    const result = await recordFailure("user-1");
    expect(result).not.toBeNull();
    expect(result!.attempts).toBe(2);
    expect(result!.locked).toBe(false);
    expect(result!.lockedUntil).toBeNull();
  });

  it("keeps existing lock when it is still active and new attempts do not reach threshold", async () => {
    // existingLockedUntil is set and still active, newLockedUntil is null → keep existing
    const activeLock = new Date(Date.now() + MS_PER_HOUR); // 1h from now
    setupTransaction({
      failed_unlock_attempts: 1,
      last_failed_unlock_at: new Date(),
      account_locked_until: activeLock,
    });

    const result = await recordFailure("user-1");
    expect(result).not.toBeNull();
    expect(result!.locked).toBe(true);
    expect(result!.lockedUntil).toEqual(activeLock);
  });

  it("swallows logAuditAsync error in VAULT_UNLOCK_FAILED block", async () => {
    setupTransaction({
      failed_unlock_attempts: 0,
      last_failed_unlock_at: null,
      account_locked_until: null,
    });
    mockLogAudit.mockImplementationOnce(() => {
      throw new Error("audit write failed");
    });

    const result = await recordFailure("user-1");
    // Should not propagate — function returns normally
    expect(result).not.toBeNull();
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" }),
      "audit.vaultUnlockFailed.error",
    );
  });

  it("swallows logAuditAsync error in VAULT_LOCKOUT_TRIGGERED block", async () => {
    setupTransaction({
      failed_unlock_attempts: 4,
      last_failed_unlock_at: new Date(),
      account_locked_until: null,
    });
    // First call (VAULT_UNLOCK_FAILED) succeeds; second call (VAULT_LOCKOUT_TRIGGERED) throws
    mockLogAudit
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("audit write failed on lockout");
      });

    const result = await recordFailure("user-1");
    expect(result).not.toBeNull();
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" }),
      "audit.vaultLockoutTriggered.error",
    );
  });

  it("calls logAuditAsync in lock_timeout path (never throws)", async () => {
    const lockTimeoutError = Object.assign(new Error("lock timeout"), {
      code: "55P03",
    });
    mockPrismaTransaction.mockRejectedValue(lockTimeoutError);

    const result = await recordFailure("user-1");
    expect(result).toBeNull();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "VAULT_UNLOCK_FAILED",
        metadata: { reason: "lock_timeout" },
      }),
    );
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

describe("getLockoutThresholds (via recordFailure with tenantId)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Invalidate any cached thresholds from other tests
    invalidateLockoutThresholdCache("tenant-custom");
    invalidateLockoutThresholdCache("tenant-missing");
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

  it("applies custom thresholds when getLockoutThresholds returns per-tenant config", async () => {
    // Custom thresholds: 3 → 30min, 7 → 2h, 12 → 24h
    mockPrismaTenant.findUnique.mockResolvedValue({
      lockoutThreshold1: 3,
      lockoutDuration1Minutes: 30,
      lockoutThreshold2: 7,
      lockoutDuration2Minutes: 120,
      lockoutThreshold3: 12,
      lockoutDuration3Minutes: 1440,
    });
    setupTransaction({
      failed_unlock_attempts: 2, // 2 previous → 3 after increment = hits threshold1
      last_failed_unlock_at: new Date(),
      account_locked_until: null,
    });

    const result = await recordFailure("user-1", undefined, "tenant-custom");
    expect(result).not.toBeNull();
    expect(result!.attempts).toBe(3);
    expect(result!.locked).toBe(true);
    // 30min lock from custom threshold1
    const expectedLockMs = 30 * MS_PER_MINUTE;
    expect(result!.lockedUntil).toBeInstanceOf(Date);
    expect(Math.abs(result!.lockedUntil!.getTime() - (Date.now() + expectedLockMs))).toBeLessThan(5000);
  });

  it("calls prisma.tenant.findUnique with the correct tenantId", async () => {
    mockPrismaTenant.findUnique.mockResolvedValue({
      lockoutThreshold1: 5,
      lockoutDuration1Minutes: 15,
      lockoutThreshold2: 10,
      lockoutDuration2Minutes: 60,
      lockoutThreshold3: 15,
      lockoutDuration3Minutes: 1440,
    });
    setupTransaction({
      failed_unlock_attempts: 0,
      last_failed_unlock_at: null,
      account_locked_until: null,
    });

    await recordFailure("user-1", undefined, "tenant-abc");
    expect(mockPrismaTenant.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "tenant-abc" },
      }),
    );
    // Clean up cache
    invalidateLockoutThresholdCache("tenant-abc");
  });

  it("falls back to default thresholds when tenant is not found", async () => {
    mockPrismaTenant.findUnique.mockResolvedValue(null);
    setupTransaction({
      failed_unlock_attempts: 4,
      last_failed_unlock_at: new Date(),
      account_locked_until: null,
    });

    const result = await recordFailure("user-1", undefined, "tenant-missing");
    expect(result).not.toBeNull();
    // Default threshold: 5 attempts → 15min lock
    expect(result!.attempts).toBe(5);
    expect(result!.locked).toBe(true);
  });

  it("re-queries the DB after invalidateLockoutThresholdCache", async () => {
    // First call: return custom thresholds, cache them
    mockPrismaTenant.findUnique.mockResolvedValue({
      lockoutThreshold1: 3,
      lockoutDuration1Minutes: 30,
      lockoutThreshold2: 7,
      lockoutDuration2Minutes: 120,
      lockoutThreshold3: 12,
      lockoutDuration3Minutes: 1440,
    });
    setupTransaction({
      failed_unlock_attempts: 0,
      last_failed_unlock_at: null,
      account_locked_until: null,
    });
    await recordFailure("user-1", undefined, "tenant-custom");
    expect(mockPrismaTenant.findUnique).toHaveBeenCalledTimes(1);

    // Invalidate cache
    invalidateLockoutThresholdCache("tenant-custom");

    // Second call should re-query
    setupTransaction({
      failed_unlock_attempts: 0,
      last_failed_unlock_at: null,
      account_locked_until: null,
    });
    await recordFailure("user-1", undefined, "tenant-custom");
    expect(mockPrismaTenant.findUnique).toHaveBeenCalledTimes(2);
  });

  it("does NOT re-query the DB within the cache TTL", async () => {
    mockPrismaTenant.findUnique.mockResolvedValue({
      lockoutThreshold1: 3,
      lockoutDuration1Minutes: 30,
      lockoutThreshold2: 7,
      lockoutDuration2Minutes: 120,
      lockoutThreshold3: 12,
      lockoutDuration3Minutes: 1440,
    });
    setupTransaction({
      failed_unlock_attempts: 0,
      last_failed_unlock_at: null,
      account_locked_until: null,
    });

    // Call twice without invalidating — second call should use cached thresholds
    await recordFailure("user-1", undefined, "tenant-custom");
    setupTransaction({
      failed_unlock_attempts: 0,
      last_failed_unlock_at: null,
      account_locked_until: null,
    });
    await recordFailure("user-1", undefined, "tenant-custom");

    // DB should only be queried once (first call populates cache)
    expect(mockPrismaTenant.findUnique).toHaveBeenCalledTimes(1);
  });
});
