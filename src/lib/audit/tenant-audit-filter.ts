// Filter shared by the tenant audit-log list and download routes, so the two
// cannot drift apart on what a filter selects.

import { AUDIT_SCOPE } from "@/lib/constants";
import type { ACTOR_TYPE } from "@/lib/constants/audit/audit";
import type { Prisma } from "@prisma/client";

export interface TenantAuditWhereInput {
  tenantId: string;
  scope: string | null;
  teamId: string | null;
  actorType?: (typeof ACTOR_TYPE)[keyof typeof ACTOR_TYPE];
  userId?: string;
}

/**
 * The scope and team a request's parameters actually select: an unknown scope
 * is not applied, and a team is not applied under scope "TENANT". The download
 * records exactly these in its audit row.
 */
export function appliedTenantAuditFilters(
  scope: string | null,
  teamId: string | null,
): { scope?: typeof AUDIT_SCOPE.TENANT | typeof AUDIT_SCOPE.TEAM; teamId?: string } {
  const appliedScope = scope === AUDIT_SCOPE.TENANT || scope === AUDIT_SCOPE.TEAM ? scope : undefined;
  return {
    ...(appliedScope && { scope: appliedScope }),
    ...(teamId && appliedScope !== AUDIT_SCOPE.TENANT && { teamId }),
  };
}

/**
 * Builds the where clause: always tenant-bound; "TENANT" only, "TEAM" only
 * (optionally one team), or both (default). `userId` narrows to rows whose
 * actor id is that user (including agents acting as them).
 */
export function buildTenantAuditWhere({
  tenantId,
  scope,
  teamId,
  actorType,
  userId,
}: TenantAuditWhereInput): Prisma.AuditLogWhereInput {
  const applied = appliedTenantAuditFilters(scope, teamId);
  const where: Prisma.AuditLogWhereInput = {
    tenantId,
    scope: applied.scope ?? { in: [AUDIT_SCOPE.TENANT, AUDIT_SCOPE.TEAM] },
    ...(applied.teamId && { teamId: applied.teamId }),
  };

  if (actorType) where.actorType = actorType;
  if (userId) where.userId = userId;
  return where;
}

/**
 * True when no team is requested or the team belongs to the tenant. A false
 * answer must be a 400 before any log query (prevents a cross-tenant oracle).
 */
export async function validateTenantAuditTeam(
  tx: Prisma.TransactionClient,
  tenantId: string,
  teamId: string | null,
): Promise<boolean> {
  if (!teamId) return true;
  const team = await tx.team.findFirst({
    where: { id: teamId, tenantId },
    select: { id: true },
  });
  return team !== null;
}
