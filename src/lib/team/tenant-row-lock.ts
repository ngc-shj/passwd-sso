import { Prisma, type TenantRole } from "@prisma/client";
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
  /** The tenant role as of the lock (null without a row). */
  role: TenantRole | null;
  deactivatedAt: Date | null;
  /** When a SCIM DELETE removed the user's membership (tenant_member_departures). */
  departedAt: Date | null;
};

const LOCK_MODE = { share: "share", update: "update" } as const;
export type TenantRowLockMode = (typeof LOCK_MODE)[keyof typeof LOCK_MODE];

export function advisoryKey(tenantId: string, userId: string): string {
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
  // The database returns uuids in lowercase; callers may pass any case a uuid
  // validator accepts, so lock by the lowercase id and answer by the caller's.
  const ids = [...new Set(userIds.map((id) => id.toLowerCase()))].sort();
  const result = new Map<string, LockedTenantRow>();
  if (ids.length === 0) return result;

  const timeoutError = () => new TenantMemberLockTimeoutError();
  // Every user's advisory lock in ONE statement, in byte order of the key
  // (COLLATE "C": the same for every caller, whatever the database collation),
  // bounded as a whole by withBoundedLockWait's statement_timeout — not four
  // round trips per user against one deadline.
  const keys = ids.map((userId) => advisoryKey(tenantId, userId));
  await withBoundedLockWait(
    tx,
    // $executeRaw: the lock function returns void, which $queryRaw cannot read.
    () => tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(k)) FROM (SELECT k FROM unnest(${keys}::text[]) AS u(k) ORDER BY k COLLATE "C") AS ordered
    `,
    { budget, timeoutError },
  );

  const rows = await withBoundedLockWait(
    tx,
    () =>
      mode === LOCK_MODE.update
        ? tx.$queryRaw<{ user_id: string; role: TenantRole; deactivated_at: Date | null }[]>`
            SELECT user_id, role, deactivated_at FROM tenant_members
             WHERE tenant_id = ${tenantId}::uuid AND user_id = ANY(${ids}::uuid[])
             ORDER BY user_id FOR UPDATE`
        : tx.$queryRaw<{ user_id: string; role: TenantRole; deactivated_at: Date | null }[]>`
            SELECT user_id, role, deactivated_at FROM tenant_members
             WHERE tenant_id = ${tenantId}::uuid AND user_id = ANY(${ids}::uuid[])
             ORDER BY user_id FOR SHARE`,
    { budget, timeoutError },
  );
  const departures = await tx.$queryRaw<{ user_id: string; departed_at: Date }[]>`
    SELECT user_id, departed_at FROM tenant_member_departures
     WHERE tenant_id = ${tenantId}::uuid AND user_id = ANY(${ids}::uuid[])
  `;

  const byId = new Map<string, LockedTenantRow>(ids.map((id) => [id, { hasRow: false, role: null, deactivatedAt: null, departedAt: null }]));
  for (const row of rows) {
    byId.set(row.user_id, { hasRow: true, role: row.role, deactivatedAt: row.deactivated_at, departedAt: null });
  }
  for (const row of departures) {
    const entry = byId.get(row.user_id);
    if (entry) byId.set(row.user_id, { ...entry, departedAt: row.departed_at });
  }
  const absent: LockedTenantRow = { hasRow: false, role: null, deactivatedAt: null, departedAt: null };
  for (const userId of userIds) result.set(userId, byId.get(userId.toLowerCase()) ?? absent);
  return result;
}

/**
 * The users' tenant rows as lockTenantRows answers them, read WITHOUT a lock.
 * Safe for a decision only against old state (the leftover-recipient check):
 * a departure racing the read is caught by the caller's conditional write on
 * `deactivatedAt: null`, or by rotation's team lock. MUST run under the
 * tenant's RLS context: outside it the read sees no rows, which answers as a
 * guest (not departed).
 */
export async function readTenantRows(
  tx: Pick<Prisma.TransactionClient, "tenantMember" | "tenantMemberDeparture">,
  tenantId: string,
  userIds: readonly string[],
): Promise<Map<string, LockedTenantRow>> {
  const result = new Map<string, LockedTenantRow>();
  if (userIds.length === 0) return result;
  // The database returns uuids in lowercase; read and answer as lockTenantRows does.
  const ids = [...new Set(userIds.map((id) => id.toLowerCase()))];
  const rows = await tx.tenantMember.findMany({
    where: { tenantId, userId: { in: ids } },
    select: { userId: true, role: true, deactivatedAt: true },
  });
  const departures = await tx.tenantMemberDeparture.findMany({
    where: { tenantId, userId: { in: ids } },
    select: { userId: true, departedAt: true },
  });
  const rowById = new Map(rows.map((r) => [r.userId, r]));
  const departedById = new Map(departures.map((d) => [d.userId, d.departedAt]));
  for (const userId of userIds) {
    const row = rowById.get(userId.toLowerCase());
    result.set(userId, {
      hasRow: row !== undefined,
      role: row?.role ?? null,
      deactivatedAt: row?.deactivatedAt ?? null,
      departedAt: departedById.get(userId.toLowerCase()) ?? null,
    });
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
 *
 * Mirrored in SQL as GREATEST(tm.deactivated_at, d.departed_at) by
 * share_creator_admitted (migration 20261114000100) and the
 * departed-member-access-backfill runbook; change them together.
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

/**
 * "Departure after admission": the actor left the tenant at or after their
 * membership of the team began (`admittedAt`, COALESCE(admitted_at, created_at)).
 * A leftover membership row the departure missed grants no authority; a
 * departure record older than a later (re-)admission does not void it.
 */
export function actorDepartedSinceAdmission(row: LockedTenantRow | undefined, admittedAt: Date): boolean {
  const departed = departedAt(row);
  return departed !== null && departed.getTime() >= admittedAt.getTime();
}

const DEADLOCK_DETECTED = "40P01";
const PRISMA_TX_EXPIRED = "P2028";

/**
 * The refusals a membership transaction raises against a concurrent one:
 * rotation conflicts, a tenant-row wait past the budget, a deadlock, or the
 * transaction expiring. Each rolled the transaction back and is safe to
 * retry, so routes answer 409. (Directory sync reaches the lock through
 * team-departure.ts and fails on the thrown error, not through this helper.)
 */
export function isMembershipLockConflict(e: unknown): boolean {
  if (isTeamRotationConflict(e) || e instanceof TenantMemberLockTimeoutError) return true;
  if (pgErrorCode(e) === DEADLOCK_DETECTED) return true;
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === PRISMA_TX_EXPIRED;
}

/** The client-facing reason for a membership lock conflict (always a 409). */
export function membershipConflictMessage(e: unknown): string {
  return e instanceof TenantMemberLockTimeoutError
    ? "The user's membership is being changed; retry later"
    : "Team key rotation in progress; retry later";
}
