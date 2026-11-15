import type { Prisma } from "@prisma/client";
import { actorDepartedSinceAdmission, readTenantRows } from "@/lib/team/tenant-departure-read";

type MembershipTenantKey = {
  userId: string;
  tenantId: string;
  admittedAt: Date | null;
  createdAt: Date;
};

/**
 * The memberships without the leftovers: rows whose user left the member's
 * tenant at or after their admission (actorDepartedSinceAdmission). A leftover
 * grants no team authority (getTeamMembership), so readers that list teams or
 * recipients across tenants omit it too. Each (tenant, user) pair is matched
 * on its own tenant row: a user who left tenant T1 stays listed in a T2 team
 * where they are a guest.
 *
 * Reads through readTenantRows grouped by tenant, so `tx` must be able to read
 * those tenants' rows (a bypass context for cross-tenant lists).
 */
export async function withoutLeftoverMemberships<M extends MembershipTenantKey>(
  tx: Pick<Prisma.TransactionClient, "tenantMember" | "tenantMemberDeparture">,
  memberships: readonly M[],
): Promise<M[]> {
  const userIdsByTenant = new Map<string, Set<string>>();
  for (const m of memberships) {
    const userIds = userIdsByTenant.get(m.tenantId) ?? new Set<string>();
    userIds.add(m.userId);
    userIdsByTenant.set(m.tenantId, userIds);
  }
  // One interactive transaction is one connection: read the tenants in turn.
  const rowsByTenant = new Map<string, Awaited<ReturnType<typeof readTenantRows>>>();
  for (const [tenantId, userIds] of userIdsByTenant) {
    rowsByTenant.set(tenantId, await readTenantRows(tx, tenantId, [...userIds]));
  }
  return memberships.filter(
    (m) =>
      !actorDepartedSinceAdmission(
        rowsByTenant.get(m.tenantId)?.get(m.userId),
        m.admittedAt ?? m.createdAt,
      ),
  );
}
