import { Prisma } from "@prisma/client";
import { pgErrorCode } from "@/lib/prisma/prisma-error";
import { advisoryXactLock } from "@/lib/tenant-rls";
import {
  type LockBudget,
  isTeamRotationConflict,
  withBoundedLockWait,
} from "@/lib/team/team-key-rotation-lock";

/**
 * Serialises a user's tenant membership with their memberships of that
 * tenant's teams (docs/archive/review/team-tenant-departure-plan.md).
 *
 * Lock order for every transaction that admits, departs or returns a user:
 * `tenant_members` rows (with an advisory lock per (tenant, user)) → `teams`
 * rows → `team_invitations` rows → `team_members` / `team_member_keys`.
 * A transaction locks its tenant rows in ONE call, before any team lock:
 * locking a second user's row after a team row closes a deadlock cycle with
 * a writer that holds that user's row and waits for the team.
 */

/** A writer gave up waiting for another transaction holding a tenant membership row. */
export class TenantMemberLockTimeoutError extends Error {
  constructor() {
    super("Tenant membership is being changed");
    this.name = "TenantMemberLockTimeoutError";
  }
}

export type LockedTenantRow = {
  /** False when the user has no membership row in the tenant. */
  hasRow: boolean;
  deactivatedAt: Date | null;
  /** When a SCIM DELETE removed the user's membership (tenant_member_departures). */
  departedAt: Date | null;
};

const LOCK_MODE = { share: "share", update: "update" } as const;
export type TenantRowLockMode = (typeof LOCK_MODE)[keyof typeof LOCK_MODE];

function advisoryKey(tenantId: string, userId: string): string {
  return `tenant-member:${tenantId}:${userId}`;
}

/**
 * Lock the users' tenant membership rows in `tenantId` (FOR SHARE to admit,
 * FOR UPDATE to depart, return or delete), in user-id order, after an
 * advisory lock per (tenant, user) — the advisory lock is what serialises a
 * user who has NO row yet with a writer about to create one (the
 * create-deactivated arms call lockTenantMemberCreation). Every wait is
 * bounded by `budget`.
 *
 * Returns one entry per requested user. The departure record is read after
 * the row lock; it is written only under the row's FOR UPDATE, so the row
 * lock orders it.
 *
 * MUST run inside an open transaction, under the tenant's RLS context.
 */
export async function lockTenantRows(
  tx: Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">,
  tenantId: string,
  userIds: readonly string[],
  mode: TenantRowLockMode,
  budget?: LockBudget,
): Promise<Map<string, LockedTenantRow>> {
  const ids = [...new Set(userIds)].sort();
  const result = new Map<string, LockedTenantRow>();
  if (ids.length === 0) return result;

  const timeoutError = () => new TenantMemberLockTimeoutError();
  for (const userId of ids) {
    await withBoundedLockWait(tx, () => advisoryXactLock(tx, advisoryKey(tenantId, userId)), {
      budget,
      timeoutError,
    });
  }

  const rows = await withBoundedLockWait(
    tx,
    () =>
      mode === LOCK_MODE.update
        ? tx.$queryRaw<{ user_id: string; deactivated_at: Date | null }[]>`
            SELECT user_id, deactivated_at FROM tenant_members
             WHERE tenant_id = ${tenantId}::uuid AND user_id = ANY(${ids}::uuid[])
             ORDER BY user_id FOR UPDATE`
        : tx.$queryRaw<{ user_id: string; deactivated_at: Date | null }[]>`
            SELECT user_id, deactivated_at FROM tenant_members
             WHERE tenant_id = ${tenantId}::uuid AND user_id = ANY(${ids}::uuid[])
             ORDER BY user_id FOR SHARE`,
    { budget, timeoutError },
  );
  const departures = await tx.$queryRaw<{ user_id: string; departed_at: Date }[]>`
    SELECT user_id, departed_at FROM tenant_member_departures
     WHERE tenant_id = ${tenantId}::uuid AND user_id = ANY(${ids}::uuid[])
  `;

  for (const userId of ids) result.set(userId, { hasRow: false, deactivatedAt: null, departedAt: null });
  for (const row of rows) {
    result.set(row.user_id, { hasRow: true, deactivatedAt: row.deactivated_at, departedAt: null });
  }
  for (const row of departures) {
    const entry = result.get(row.user_id);
    if (entry) result.set(row.user_id, { ...entry, departedAt: row.departed_at });
  }
  return result;
}

/**
 * The advisory half of lockTenantRows, for a writer about to INSERT a
 * user's tenant row as deactivated (SCIM POST `active=false`, directory-sync
 * create): an admission of that user as a guest holds the same lock, so it
 * either commits first (and the creation departs it) or reads the new row.
 */
export async function lockTenantMemberCreation(
  tx: Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">,
  tenantId: string,
  userId: string,
  budget?: LockBudget,
): Promise<void> {
  await withBoundedLockWait(tx, () => advisoryXactLock(tx, advisoryKey(tenantId, userId)), {
    budget,
    timeoutError: () => new TenantMemberLockTimeoutError(),
  });
}

/**
 * When the user left the tenant, as admission compares it with an
 * invitation's `created_at`: the row's deactivation, or the SCIM DELETE
 * record. An active row with a record is a re-creation; the record still
 * voids invitations issued before it.
 */
export function departedAt(row: LockedTenantRow | undefined): Date | null {
  if (!row) return null;
  const stamps = [row.deactivatedAt, row.departedAt].filter((d): d is Date => d !== null);
  if (stamps.length === 0) return null;
  return new Date(Math.max(...stamps.map((d) => d.getTime())));
}

/** "Departure after issue": departed at or after the invitation was created (equal refuses). */
export function departedSince(row: LockedTenantRow | undefined, issuedAt: Date): boolean {
  const departed = departedAt(row);
  return departed !== null && departed.getTime() >= issuedAt.getTime();
}

const DEADLOCK_DETECTED = "40P01";
const PRISMA_TX_EXPIRED = "P2028";

/**
 * The refusals a membership transaction raises against a concurrent one:
 * rotation conflicts, a tenant-row wait past the budget, a deadlock, or the
 * transaction expiring. Each rolled the transaction back and is safe to
 * retry, so routes answer 409 and directory sync fails the run.
 */
export function isMembershipLockConflict(e: unknown): boolean {
  if (isTeamRotationConflict(e) || e instanceof TenantMemberLockTimeoutError) return true;
  if (pgErrorCode(e) === DEADLOCK_DETECTED) return true;
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === PRISMA_TX_EXPIRED;
}
