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
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { logAudit, logAuditInTx, extractRequestMeta } from "@/lib/audit";
import { getLogger } from "@/lib/logger";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import { notifyAdminsOfLockout } from "@/lib/lockout-admin-notify";
import type { NextRequest } from "next/server";

/** Observation window: reset counter if last failure was this long ago */
const OBSERVATION_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Default lockout thresholds — ordered descending by attempts.
 * First match wins (most severe threshold applied).
 * Used as fallback when tenant config is unavailable.
 */
const DEFAULT_LOCKOUT_THRESHOLDS = [
  { attempts: 15, lockMinutes: 1440 }, // 24h
  { attempts: 10, lockMinutes: 60 },   // 1h
  { attempts: 5, lockMinutes: 15 },    // 15min
];

type LockoutThreshold = { attempts: number; lockMinutes: number };

const lockoutThresholdCache = new Map<string, { thresholds: LockoutThreshold[]; expiresAt: number }>();
const LOCKOUT_THRESHOLD_CACHE_TTL_MS = 60_000;

/**
 * Return per-tenant lockout thresholds, falling back to defaults if tenant
 * is not found or an error occurs. Results are cached for 60s.
 */
async function getLockoutThresholds(tenantId: string): Promise<LockoutThreshold[]> {
  const cached = lockoutThresholdCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.thresholds;
  }
  if (cached) lockoutThresholdCache.delete(tenantId);

  try {
    const tenant = await withBypassRls(
      prisma,
      () =>
        prisma.tenant.findUnique({
          where: { id: tenantId },
          select: {
            lockoutThreshold1: true,
            lockoutDuration1Minutes: true,
            lockoutThreshold2: true,
            lockoutDuration2Minutes: true,
            lockoutThreshold3: true,
            lockoutDuration3Minutes: true,
          },
        }),
      BYPASS_PURPOSE.SYSTEM_MAINTENANCE,
    );

    if (!tenant) {
      lockoutThresholdCache.set(tenantId, {
        thresholds: DEFAULT_LOCKOUT_THRESHOLDS,
        expiresAt: Date.now() + LOCKOUT_THRESHOLD_CACHE_TTL_MS,
      });
      return DEFAULT_LOCKOUT_THRESHOLDS;
    }

    // Build descending array: threshold3 (highest) → threshold1 (lowest)
    const thresholds: LockoutThreshold[] = [
      { attempts: tenant.lockoutThreshold3, lockMinutes: tenant.lockoutDuration3Minutes },
      { attempts: tenant.lockoutThreshold2, lockMinutes: tenant.lockoutDuration2Minutes },
      { attempts: tenant.lockoutThreshold1, lockMinutes: tenant.lockoutDuration1Minutes },
    ];

    lockoutThresholdCache.set(tenantId, {
      thresholds,
      expiresAt: Date.now() + LOCKOUT_THRESHOLD_CACHE_TTL_MS,
    });
    return thresholds;
  } catch {
    return DEFAULT_LOCKOUT_THRESHOLDS;
  }
}

/**
 * Invalidate the lockout threshold cache for a specific tenant.
 * Call this after updating tenant lockout policy settings.
 */
export function invalidateLockoutThresholdCache(tenantId: string): void {
  lockoutThresholdCache.delete(tenantId);
}

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
  // withBypassRls required: called outside tenant RLS context (pre-unlock check)
  const user = await withBypassRls(prisma, async () =>
    prisma.user.findUnique({
      where: { id: userId },
      select: { accountLockedUntil: true },
    }),
  BYPASS_PURPOSE.AUTH_FLOW);

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
 *
 * @param tenantId - Optional tenant ID for per-tenant lockout thresholds.
 *   If omitted, the user's tenantId is resolved from the database.
 */
export async function recordFailure(
  userId: string,
  request?: NextRequest,
  tenantId?: string,
): Promise<RecordFailureResult | null> {
  const now = new Date();

  // Resolve tenantId before the transaction (getLockoutThresholds is async)
  let resolvedTenantId = tenantId;
  if (!resolvedTenantId) {
    const userRow = await withBypassRls(
      prisma,
      () => prisma.user.findUnique({ where: { id: userId }, select: { tenantId: true } }),
      BYPASS_PURPOSE.AUTH_FLOW,
    );
    resolvedTenantId = userRow?.tenantId;
  }

  // Fetch per-tenant thresholds before acquiring the row lock
  const thresholds = resolvedTenantId
    ? await getLockoutThresholds(resolvedTenantId)
    : DEFAULT_LOCKOUT_THRESHOLDS;

  try {
    // withBypassRls required: called outside tenant RLS context (post-auth side effect).
    // The prisma proxy re-uses the bypass transaction for nested $transaction calls.
    const result = await withBypassRls(prisma, async () =>
      prisma.$transaction(async (tx) => {
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
      for (const threshold of thresholds) {
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

      // True only when newAttempts first reaches a threshold prevAttempts hadn't
      const matchedThreshold = thresholds.find(
        (t) => newAttempts >= t.attempts,
      );
      const thresholdCrossed =
        matchedThreshold !== undefined &&
        prevAttempts < matchedThreshold.attempts;

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
        thresholdCrossed,
      };
    }),
    BYPASS_PURPOSE.AUTH_FLOW);

    // Atomic audit: VAULT_UNLOCK_FAILED (every failure)
    try {
      const meta = request ? extractRequestMeta(request) : { ip: null, userAgent: null };
      if (resolvedTenantId) {
        await withBypassRls(prisma, async (tx) => {
          await logAuditInTx(tx, resolvedTenantId!, {
            scope: AUDIT_SCOPE.PERSONAL,
            action: AUDIT_ACTION.VAULT_UNLOCK_FAILED,
            userId,
            metadata: { attempts: result.attempts },
            ip: meta.ip,
            userAgent: meta.userAgent,
          });
        }, BYPASS_PURPOSE.AUDIT_WRITE);
      } else {
        logAudit({
          scope: AUDIT_SCOPE.PERSONAL,
          action: AUDIT_ACTION.VAULT_UNLOCK_FAILED,
          userId,
          metadata: { attempts: result.attempts },
          ip: meta.ip,
          userAgent: meta.userAgent,
        });
      }
    } catch (auditErr) {
      getLogger().error({ err: auditErr, userId }, "audit.vaultUnlockFailed.error");
    }

    // Atomic audit: VAULT_LOCKOUT_TRIGGERED (threshold crossed)
    if (result.lockMinutes !== null) {
      try {
        const meta = request ? extractRequestMeta(request) : { ip: null, userAgent: null };
        if (resolvedTenantId) {
          await withBypassRls(prisma, async (tx) => {
            await logAuditInTx(tx, resolvedTenantId!, {
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
          }, BYPASS_PURPOSE.AUDIT_WRITE);
        } else {
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
        }
        if (result.thresholdCrossed) {
          void notifyAdminsOfLockout({
            userId,
            attempts: result.attempts,
            lockMinutes: result.lockMinutes!,
            ip: meta.ip,
          });
        }
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
    getLogger().error({ err, userId }, "vault.lockout.recordFailure.error");
    throw err;
  }
}

/**
 * Reset lockout state after successful unlock.
 * Wrapped in try/catch — failure must never block a successful unlock.
 */
export async function resetLockout(userId: string): Promise<void> {
  try {
    // withBypassRls required: called outside tenant RLS context (post-auth side effect)
    await withBypassRls(prisma, async () =>
      prisma.user.update({
        where: { id: userId },
        data: {
          failedUnlockAttempts: 0,
          lastFailedUnlockAt: null,
          accountLockedUntil: null,
        },
      }),
    BYPASS_PURPOSE.AUTH_FLOW);
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
