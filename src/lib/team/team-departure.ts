import type { Prisma } from "@prisma/client";
import type { TxOrPrisma } from "@/lib/prisma";

/**
 * Whether a team member has departed the team's tenant — the one predicate
 * every path that decides who holds a team key reads (authorization, key
 * serving, distribution, rotation).
 *
 * Departed = the user's membership row in the team's tenant is deactivated
 * (SCIM `active=false`, directory sync). It is read from tenant membership
 * at decision time rather than written onto the team membership, so it
 * applies to members who departed before this predicate existed, and
 * reactivating the tenant membership restores the team membership as it
 * was. A user with NO row in the team's tenant has not departed: a member
 * invited from another tenant has none, and neither has a user who moved
 * out of a bootstrap tenant and kept its teams.
 *
 * Do not encode departure as `team_members.key_distributed = false`: that
 * is the "not yet distributed" state, which every OWNER/ADMIN browser's
 * background distribution hands the current key to.
 */

/** The users of `userIds` who have departed `tenantId`. */
export async function departedFromTenant(
  db: TxOrPrisma,
  tenantId: string,
  userIds: readonly string[],
): Promise<Set<string>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Set();
  const rows = await db.tenantMember.findMany({
    where: { tenantId, userId: { in: ids }, deactivatedAt: { not: null } },
    select: { userId: true },
  });
  return new Set(rows.map((row) => row.userId));
}

/** `${tenantId}:${userId}` for each (tenant, user) pair whose user has departed that tenant. */
export async function departedPairs(
  db: TxOrPrisma,
  pairs: readonly { tenantId: string; userId: string }[],
): Promise<Set<string>> {
  if (pairs.length === 0) return new Set();
  const rows = await db.tenantMember.findMany({
    where: {
      tenantId: { in: [...new Set(pairs.map((p) => p.tenantId))] },
      userId: { in: [...new Set(pairs.map((p) => p.userId))] },
      deactivatedAt: { not: null },
    },
    select: { tenantId: true, userId: true },
  });
  return new Set(rows.map((row) => departedPairKey(row)));
}

export function departedPairKey(pair: { tenantId: string; userId: string }): string {
  return `${pair.tenantId}:${pair.userId}`;
}

/**
 * Read the user's departure state in `tenantId` under `FOR SHARE` on their
 * tenant membership row, held until the transaction ends: a deactivation
 * committing concurrently either is seen here or waits for this
 * transaction. For a write that makes the user a key holder (confirm-key).
 */
export async function lockDepartureState(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  tenantId: string,
  userId: string,
): Promise<boolean> {
  const [row] = await tx.$queryRaw<{ departed: boolean }[]>`
    SELECT deactivated_at IS NOT NULL AS departed FROM tenant_members
     WHERE tenant_id = ${tenantId}::uuid AND user_id = ${userId}::uuid
       FOR SHARE
  `;
  return row?.departed ?? false;
}
