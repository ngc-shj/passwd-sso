/**
 * Account lockout logic for vault unlock brute-force protection.
 *
 * Progressive lockout thresholds (DB-persistent):
 *   5 failures → 15 min lock
 *  10 failures →  1 hour lock
 *  15 failures → 24 hour lock
 *
 * Uses SELECT ... FOR UPDATE with lock_timeout to prevent lost updates.
 * Observation window: counter resets if last failure was >24h ago.
 */

import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { getLogger } from "@/lib/logger";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import type { NextRequest } from "next/server";

/** Observation window: reset counter if last failure was this long ago */
const OBSERVATION_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Lockout thresholds — ordered descending by attempts.
 * First match wins (most severe threshold applied).
 */
const LOCKOUT_THRESHOLDS = [
  { attempts: 15, lockMinutes: 1440 }, // 24h
  { attempts: 10, lockMinutes: 60 },   // 1h
  { attempts: 5, lockMinutes: 15 },    // 15min
] as const;

export interface LockoutStatus {
  locked: boolean;
  lockedUntil: Date | null;
}

export interface RecordFailureResult {
  locked: boolean;
  lockedUntil: Date | null;
  attempts: number;
}

/**
 * Check if a user's account is currently locked.
 * Simple DB read — no row locking needed.
 */
export async function checkLockout(userId: string): Promise<LockoutStatus> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { accountLockedUntil: true },
  });

  if (!user?.accountLockedUntil) {
    return { locked: false, lockedUntil: null };
  }

  const now = new Date();
  if (now < user.accountLockedUntil) {
    return { locked: true, lockedUntil: user.accountLockedUntil };
  }

  return { locked: false, lockedUntil: null };
}

// Row type returned by SELECT ... FOR UPDATE raw query
// NOTE: Column names match @map values in schema.prisma (@@map("users")).
// If @map or @@map values change, update these raw SQL queries accordingly.
interface UserLockoutRow {
  failed_unlock_attempts: number;
  last_failed_unlock_at: Date | null;
  account_locked_until: Date | null;
}

/**
 * Record a failed unlock attempt with progressive lockout.
 *
 * Uses $transaction + SELECT ... FOR UPDATE for row-level locking.
 * Returns null if lock_timeout occurs (counter NOT incremented).
 */
export async function recordFailure(
  userId: string,
  request?: NextRequest,
): Promise<RecordFailureResult | null> {
  const now = new Date();
  let lockTimeout = false;

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Set lock_timeout to prevent indefinite waits
      await tx.$executeRaw`SET LOCAL lock_timeout = '200ms'`;

      // Acquire row-level exclusive lock
      // NOTE: Table "users" (@@map), columns use @map snake_case names
      const rows = await tx.$queryRaw<UserLockoutRow[]>`
        SELECT "failed_unlock_attempts", "last_failed_unlock_at", "account_locked_until"
        FROM "users"
        WHERE "id" = ${userId}
        FOR UPDATE
      `;

      if (rows.length === 0) {
        throw new Error(`User not found: ${userId}`);
      }

      const row = rows[0];
      const prevAttempts = row.failed_unlock_attempts;
      const lastFailedAt = row.last_failed_unlock_at;
      const existingLockedUntil = row.account_locked_until;

      // Observation window: reset counter if last failure was >24h ago
      let newAttempts: number;
      if (
        lastFailedAt &&
        now.getTime() - lastFailedAt.getTime() < OBSERVATION_WINDOW_MS
      ) {
        newAttempts = prevAttempts + 1;
      } else {
        newAttempts = 1;
      }

      // Threshold check — descending order, first match wins
      let newLockedUntil: Date | null = null;
      let lockMinutes: number | null = null;
      for (const threshold of LOCKOUT_THRESHOLDS) {
        if (newAttempts >= threshold.attempts) {
          lockMinutes = threshold.lockMinutes;
          newLockedUntil = new Date(
            now.getTime() + threshold.lockMinutes * 60 * 1000,
          );
          break;
        }
      }

      // Monotonic increase: max(existing, new) to prevent shortening
      let finalLockedUntil = newLockedUntil;
      if (existingLockedUntil && newLockedUntil) {
        finalLockedUntil =
          existingLockedUntil > newLockedUntil
            ? existingLockedUntil
            : newLockedUntil;
      } else if (existingLockedUntil && !newLockedUntil) {
        // Keep existing lock if still active
        finalLockedUntil =
          now < existingLockedUntil ? existingLockedUntil : null;
      }

      await tx.user.update({
        where: { id: userId },
        data: {
          failedUnlockAttempts: newAttempts,
          lastFailedUnlockAt: now,
          accountLockedUntil: finalLockedUntil,
        },
      });

      return {
        attempts: newAttempts,
        locked: finalLockedUntil !== null && now < finalLockedUntil,
        lockedUntil: finalLockedUntil,
        lockMinutes,
      };
    });

    // Async nonblocking audit: VAULT_UNLOCK_FAILED (every failure)
    // NOTE: logAudit() internally swallows exceptions, so this catch is
    // unlikely to fire. Kept as a safety net in case logAudit's contract changes.
    try {
      const meta = request ? extractRequestMeta(request) : { ip: null, userAgent: null };
      logAudit({
        scope: AUDIT_SCOPE.PERSONAL,
        action: AUDIT_ACTION.VAULT_UNLOCK_FAILED,
        userId,
        metadata: { attempts: result.attempts },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
    } catch (auditErr) {
      getLogger().error({ err: auditErr, userId }, "audit.vaultUnlockFailed.error");
    }

    // Async nonblocking audit: VAULT_LOCKOUT_TRIGGERED (threshold crossed)
    // NOTE: Same as above — logAudit() swallows internally; catch kept as safety net.
    if (result.lockMinutes !== null) {
      try {
        const meta = request ? extractRequestMeta(request) : { ip: null, userAgent: null };
        logAudit({
          scope: AUDIT_SCOPE.PERSONAL,
          action: AUDIT_ACTION.VAULT_LOCKOUT_TRIGGERED,
          userId,
          metadata: {
            attempts: result.attempts,
            lockMinutes: result.lockMinutes,
            lockedUntil: result.lockedUntil?.toISOString() ?? null,
          },
          ip: meta.ip,
          userAgent: meta.userAgent,
        });
        // IMPROVE(#40): implement admin notification (CloudWatch Alarm / SNS)
        getLogger().warn(
          {
            userId,
            attempts: result.attempts,
            lockMinutes: result.lockMinutes,
            lockedUntil: result.lockedUntil,
          },
          "vault.lockout.triggered",
        );
      } catch (auditErr) {
        getLogger().error({ err: auditErr, userId }, "audit.vaultLockoutTriggered.error");
      }
    }

    return {
      locked: result.locked,
      lockedUntil: result.lockedUntil,
      attempts: result.attempts,
    };
  } catch (err) {
    // lock_timeout: transaction rolled back, counter NOT incremented
    if (isLockTimeoutError(err)) {
      lockTimeout = true;
      getLogger().warn({ userId }, "vault.unlock.lockTimeout");

      // Record audit even on lock_timeout (async nonblocking, outside transaction)
      // NOTE: logAudit() swallows internally; catch kept as safety net.
      try {
        const meta = request ? extractRequestMeta(request) : { ip: null, userAgent: null };
        logAudit({
          scope: AUDIT_SCOPE.PERSONAL,
          action: AUDIT_ACTION.VAULT_UNLOCK_FAILED,
          userId,
          metadata: { reason: "lock_timeout" },
          ip: meta.ip,
          userAgent: meta.userAgent,
        });
      } catch (auditErr) {
        getLogger().error({ err: auditErr, userId }, "audit.vaultUnlockFailed.lockTimeout.error");
      }

      return null;
    }
    // Unexpected error — log and re-throw
    getLogger().error({ err, userId, lockTimeout }, "vault.lockout.recordFailure.error");
    throw err;
  }
}

/**
 * Reset lockout state after successful unlock.
 * Wrapped in try/catch — failure must never block a successful unlock.
 */
export async function resetLockout(userId: string): Promise<void> {
  try {
    await prisma.user.update({
      where: { id: userId },
      data: {
        failedUnlockAttempts: 0,
        lastFailedUnlockAt: null,
        accountLockedUntil: null,
      },
    });
  } catch (err) {
    getLogger().error({ err, userId }, "vault.lockout.resetLockout.error");
    // Swallow — do not block successful unlock
  }
}

/**
 * Check if an error is a PostgreSQL lock_timeout error.
 * PG error code 55P03 = lock_not_available.
 *
 * Prisma may surface this in multiple formats:
 *  1. Direct PG error: err.code === "55P03"
 *  2. Prisma wrapped:  err.cause.code === "55P03"
 *  3. PrismaClientKnownRequestError: err.code === "P2010" && err.meta.code === "55P03"
 */
function isLockTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;

  // Direct PG error: err.code === "55P03"
  if ("code" in err && (err as { code: string }).code === "55P03") {
    return true;
  }

  // Prisma P2010 (Raw query failed): err.meta.code === "55P03"
  if (
    "code" in err &&
    (err as { code: string }).code === "P2010" &&
    "meta" in err &&
    err.meta &&
    typeof err.meta === "object" &&
    "code" in err.meta &&
    (err.meta as { code: string }).code === "55P03"
  ) {
    return true;
  }

  // Prisma wrapped error: err.cause.code === "55P03"
  if (
    "cause" in err &&
    err.cause &&
    typeof err.cause === "object" &&
    "code" in err.cause &&
    (err.cause as { code: string }).code === "55P03"
  ) {
    return true;
  }

  return false;
}
