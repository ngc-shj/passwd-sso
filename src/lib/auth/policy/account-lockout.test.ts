import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

const {
  mockPrismaUser,
  mockPrismaTenant,
  mockTxState,
  mockLogAudit,
  mockLogAuditInTx,
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
    // Raw-SQL behavior for the inner bypass-RLS callback (the former
    // $transaction body now runs directly on the withBypassRls tx). Model
    // methods (user/tenant) delegate to the shared module mocks so existing
    // assertions on mockPrismaUser/mockPrismaTenant still hold.
    mockTxState: {
      queryRawImpl: vi.fn(),
      executeRawImpl: vi.fn(),
    } as {
      queryRawImpl: Mock;
      executeRawImpl: Mock;
    },
    mockLogAudit: vi.fn(),
    mockLogAuditInTx: vi.fn(),
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
  },
}));
// The former inner prisma.$transaction was folded away: the lockout body now
// runs directly on the tx that withBypassRls passes to its callback. So the
// tx mock here must expose every method the body calls: $executeRaw (SET LOCAL),
// $queryRaw (the FOR UPDATE row read), user.update (counter write), plus the
// user.findUnique / tenant.findUnique used by the other bypass call-sites
// (tenantId resolution, checkLockout, getLockoutThresholds). Model methods
// delegate to the shared module mocks so existing assertions still hold.
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: vi.fn((_prisma: unknown, fn: (tx: unknown) => unknown) => {
    const tx = {
      $executeRaw: (...args: unknown[]) => mockTxState.executeRawImpl(...args),
      $queryRaw: (...args: unknown[]) => mockTxState.queryRawImpl(...args),
      user: mockPrismaUser,
      tenant: mockPrismaTenant,
    };
    return fn(tx);
  }),
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  logAuditInTx: mockLogAuditInTx,
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
vi.mock("@/lib/auth/policy/lockout-admin-notify", () => ({
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
    invalidateLockoutThresholdCache("tenant-default");
  });

  // Resolve the user's tenant + its schema-default thresholds so recordFailure
  // exercises the NORMAL (5/10/15) path via the tenant-scoped audit (logAuditInTx).
  // Without a resolvable tenant the code now fails closed to the strictest
  // threshold (lock at 1) — covered by its own dedicated tests below.
  function mockDefaultTenantThresholds() {
    mockPrismaUser.findUnique.mockResolvedValue({ tenantId: "tenant-default" });
    mockPrismaTenant.findUnique.mockResolvedValue({
      lockoutThreshold1: 5,
      lockoutDuration1Minutes: 15,
      lockoutThreshold2: 10,
      lockoutDuration2Minutes: 60,
      lockoutThreshold3: 15,
      lockoutDuration3Minutes: 1440,
    });
  }

  function setupTransaction(row: {
    failed_unlock_attempts: number;
    last_failed_unlock_at: Date | null;
    account_locked_until: Date | null;
  }) {
    mockTxState.executeRawImpl.mockResolvedValue(undefined);
    mockTxState.queryRawImpl.mockResolvedValue([row]);
    mockPrismaUser.update.mockResolvedValue(undefined);
    mockDefaultTenantThresholds();
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
    // With a resolved tenant, the audit is written atomically via logAuditInTx
    // (tx, tenantId, auditObj) — the tenant-scoped path.
    expect(mockLogAuditInTx).toHaveBeenCalledWith(
      expect.anything(),
      "tenant-default",
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
    expect(mockLogAuditInTx).toHaveBeenCalledWith(
      expect.anything(),
      "tenant-default",
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
    mockTxState.queryRawImpl.mockRejectedValue(lockTimeoutError);

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
    mockTxState.queryRawImpl.mockRejectedValue(prismaError);

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
    mockTxState.queryRawImpl.mockRejectedValue(wrappedError);

    const result = await recordFailure("user-1");
    expect(result).toBeNull();
  });

  it("records audit with reason: lock_timeout on lock_timeout", async () => {
    const lockTimeoutError = Object.assign(new Error("lock timeout"), {
      code: "55P03",
    });
    mockTxState.queryRawImpl.mockRejectedValue(lockTimeoutError);

    await recordFailure("user-1");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "VAULT_UNLOCK_FAILED",
        metadata: { reason: "lock_timeout" },
      }),
    );
  });

  it("rethrows unexpected errors", async () => {
    mockTxState.queryRawImpl.mockRejectedValue(new Error("unexpected"));
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

  it("swallows the atomic audit error in the VAULT_UNLOCK_FAILED block", async () => {
    setupTransaction({
      failed_unlock_attempts: 0,
      last_failed_unlock_at: null,
      account_locked_until: null,
    });
    // With a resolved tenant the audit uses logAuditInTx (mockLogAuditInTx).
    mockLogAuditInTx.mockImplementationOnce(() => {
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

  it("swallows the atomic audit error in the VAULT_LOCKOUT_TRIGGERED block", async () => {
    setupTransaction({
      failed_unlock_attempts: 4,
      last_failed_unlock_at: new Date(),
      account_locked_until: null,
    });
    // First call (VAULT_UNLOCK_FAILED) succeeds; second (VAULT_LOCKOUT_TRIGGERED) throws
    mockLogAuditInTx
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
    mockTxState.queryRawImpl.mockRejectedValue(lockTimeoutError);

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
    mockTxState.executeRawImpl.mockResolvedValue(undefined);
    mockTxState.queryRawImpl.mockResolvedValue([row]);
    mockPrismaUser.update.mockResolvedValue(undefined);
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

  // Regression (null-tenant fail-open class): a missing tenant row is corruption
  // (tenantId is FK-backed), NOT "no policy". Returning the schema-default
  // thresholds (lock at 5) would GRANT extra attempts to a tenant that had
  // tightened to lock-at-1 — a fail-open weakening. Fail closed to the strictest
  // configurable threshold (lock at 1 attempt), and log it.
  // Mutation check: revert to DEFAULT_LOCKOUT_THRESHOLDS and this locks at 5 not
  // 1 — the single-attempt lock assertion fails.
  it("fails closed to the strictest threshold (lock at 1) when the tenant row is missing", async () => {
    invalidateLockoutThresholdCache("tenant-missing");
    mockPrismaTenant.findUnique.mockResolvedValue(null);
    setupTransaction({
      failed_unlock_attempts: 0, // first failure → 1 attempt must already lock
      last_failed_unlock_at: null,
      account_locked_until: null,
    });

    const result = await recordFailure("user-1", undefined, "tenant-missing");
    expect(result).not.toBeNull();
    expect(result!.attempts).toBe(1);
    expect(result!.locked).toBe(true);
    expect(mockLoggerInstance.warn).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-missing" }),
      "vault.lockout.tenantRowMissing.usingStrictest",
    );
    invalidateLockoutThresholdCache("tenant-missing");
  });

  // Regression (null-tenant fail-open class): a DB error must not be swallowed to
  // the schema-default (which could be weaker than a tightened tenant policy).
  // Fail closed to the strictest threshold (lock at 1) and log the degradation.
  // Mutation check: revert to DEFAULT_LOCKOUT_THRESHOLDS and this locks at 5 not
  // 1 — the single-attempt lock assertion fails; remove the warn and the log
  // assertion fails.
  it("fails closed to the strictest threshold (lock at 1) when the threshold fetch throws", async () => {
    invalidateLockoutThresholdCache("tenant-dberr");
    mockPrismaTenant.findUnique.mockRejectedValue(new Error("DB down"));
    setupTransaction({
      failed_unlock_attempts: 0,
      last_failed_unlock_at: null,
      account_locked_until: null,
    });

    const result = await recordFailure("user-1", undefined, "tenant-dberr");

    expect(result).not.toBeNull();
    expect(result!.attempts).toBe(1);
    expect(result!.locked).toBe(true);
    expect(mockLoggerInstance.warn).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-dberr" }),
      "vault.lockout.thresholdsFetchFailed.usingStrictest",
    );
    invalidateLockoutThresholdCache("tenant-dberr");
  });

  // Regression (external review Low): the strictest fallback must NOT be cached.
  // If a transient DB failure pinned STRICTEST into the 60s TTL cache, users of
  // a lenient tenant would keep locking at 1 attempt after the DB recovered.
  // The next call after recovery must re-query and apply the tenant's real
  // thresholds. Mutation check: cache the fallback in the catch/null branches of
  // getLockoutThresholds and the second call here locks at 1, not 5.
  it("does not cache the strictest fallback — recovers to real thresholds on the next call", async () => {
    invalidateLockoutThresholdCache("tenant-recover");

    // First call: fetch fails → strictest fallback (locks at 1 attempt)
    mockPrismaTenant.findUnique.mockRejectedValueOnce(new Error("DB down"));
    setupTransaction({
      failed_unlock_attempts: 0,
      last_failed_unlock_at: null,
      account_locked_until: null,
    });
    const during = await recordFailure("user-1", undefined, "tenant-recover");
    expect(during).not.toBeNull();
    expect(during!.locked).toBe(true); // strictest applied during the outage

    // Second call: DB recovered → tenant's lenient thresholds (lock at 5) apply
    mockPrismaTenant.findUnique.mockResolvedValue({
      lockoutThreshold1: 5,
      lockoutDuration1Minutes: 15,
      lockoutThreshold2: 10,
      lockoutDuration2Minutes: 60,
      lockoutThreshold3: 15,
      lockoutDuration3Minutes: 1440,
    });
    setupTransaction({
      failed_unlock_attempts: 1, // 1 previous → 2 after increment, below threshold1=5
      last_failed_unlock_at: new Date(),
      account_locked_until: null,
    });
    const after = await recordFailure("user-1", undefined, "tenant-recover");

    expect(after).not.toBeNull();
    expect(mockPrismaTenant.findUnique).toHaveBeenCalledTimes(2); // fallback was not cached
    expect(after!.attempts).toBe(2);
    expect(after!.locked).toBe(false); // real (lenient) policy applies again
    invalidateLockoutThresholdCache("tenant-recover");
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
