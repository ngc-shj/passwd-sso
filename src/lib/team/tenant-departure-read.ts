import type { Prisma, TenantRole } from "@prisma/client";

// Pure on purpose: the audit-outbox worker bundle (CJS) loads this module, so it
// must not import @/lib/prisma or any other value that pulls the Prisma runtime.

export type LockedTenantRow = {
  /** False when the user has no membership row in the tenant. */
  hasRow: boolean;
  /** The tenant role as of the lock (null without a row). */
  role: TenantRole | null;
  deactivatedAt: Date | null;
  /** When a SCIM DELETE removed the user's membership (tenant_member_departures). */
  departedAt: Date | null;
};

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
