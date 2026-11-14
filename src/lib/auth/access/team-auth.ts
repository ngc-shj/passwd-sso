/**
 * Team authorization helpers (RBAC).
 *
 * Permissions are derived from team role:
 *   OWNER  — full control
 *   ADMIN  — manage members, passwords, tags (cannot delete team)
 *   MEMBER — create passwords, manage own, manage tags
 *   VIEWER — read-only access to passwords
 */

import { prisma } from "@/lib/prisma";
import { API_ERROR, type ApiErrorCode } from "@/lib/http/api-error-codes";
import { TEAM_ROLE } from "@/lib/constants";
import { hasTeamPermission, type TeamPermission } from "@/lib/auth/access/team-permissions";
import { resolveUserTenantIdFromClient, withTeamTenantRls } from "@/lib/tenant-context";
import { withBypassRls } from "@/lib/tenant-rls";
import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import { withTeamIpRestriction, PolicyViolationError } from "@/lib/team/team-policy";
import type { Prisma, TeamRole } from "@prisma/client";
import type { NextRequest } from "next/server";

export {
  hasTeamPermission,
  canWriteTeamEntry,
  type TeamPermission,
} from "@/lib/auth/access/team-permissions";

/**
 * The user's role in the team as the transaction sees it now, or null when
 * they are not an active member. Call it after the transaction's locks:
 * requireTeamPermission ran before them, and a departure, removal or demotion
 * may have committed since.
 */
export async function activeTeamRole(
  tx: Pick<Prisma.TransactionClient, "teamMember">,
  teamId: string,
  userId: string,
): Promise<TeamRole | null> {
  const membership = await tx.teamMember.findFirst({
    where: { teamId, userId, deactivatedAt: null },
    select: { role: true },
  });
  return membership?.role ?? null;
}

/**
 * activeTeamRole plus when the membership began (admittedAt, or createdAt for
 * a row admitted before the column existed), for the departed-actor check
 * (actorDepartedSinceAdmission). The same COALESCE(admitted_at, created_at) is
 * inlined by the approve route (its read also needs keyDistributed) and by the
 * departed-member-access-backfill runbook; change them together.
 */
export async function activeTeamAdmission(
  tx: Pick<Prisma.TransactionClient, "teamMember">,
  teamId: string,
  userId: string,
): Promise<{ role: TeamRole; admittedAt: Date } | null> {
  const membership = await tx.teamMember.findFirst({
    where: { teamId, userId, deactivatedAt: null },
    select: { role: true, admittedAt: true, createdAt: true },
  });
  if (!membership) return null;
  return { role: membership.role, admittedAt: membership.admittedAt ?? membership.createdAt };
}

// Back-compat re-export — see team-role-hierarchy.ts for the pure module.
export { isRoleAbove } from "@/lib/auth/access/team-role-hierarchy";

// Re-export isTeamAdminRole from constants for backward compatibility
export { isTeamAdminRole } from "@/lib/constants";

/**
 * Get the membership record for a user in a team.
 * Returns null if the user is not a member (or is deactivated).
 *
 * Uses findFirst instead of findUnique because Prisma's findUnique
 * cannot include non-unique-index fields (deactivatedAt) in the where clause.
 * The @@unique([teamId, userId]) constraint ensures at most one row per team+user.
 */
async function getTeamMembershipInRlsContext(userId: string, teamId: string) {
  return prisma.teamMember.findFirst({
    where: { teamId: teamId, userId, deactivatedAt: null },
  });
}

export async function getTeamMembership(userId: string, teamId: string) {
  return withTeamTenantRls(teamId, async () =>
    getTeamMembershipInRlsContext(userId, teamId),
  );
}

/**
 * Require that the user is a member of the team.
 * When request is provided, also enforces the team IP restriction policy.
 * Returns the membership record, or throws a structured error.
 */
export async function requireTeamMember(userId: string, teamId: string, request?: NextRequest) {
  const membership = await getTeamMembership(userId, teamId);
  if (!membership) {
    // Hide team existence from non-members
    throw new TeamAuthError(API_ERROR.NOT_FOUND, 404);
  }
  if (request) {
    try {
      await withTeamIpRestriction(teamId, request, userId);
    } catch (e) {
      if (e instanceof PolicyViolationError) {
        throw new TeamAuthError(API_ERROR.FORBIDDEN, 403);
      }
      throw e;
    }
  }
  return membership;
}

/**
 * Require that the user has a specific permission in the team.
 * When request is provided, also enforces the team IP restriction policy.
 * Returns the membership record, or throws a structured error.
 */
export async function requireTeamPermission(
  userId: string,
  teamId: string,
  permission: TeamPermission,
  request?: NextRequest
) {
  const membership = await requireTeamMember(userId, teamId, request);
  if (!hasTeamPermission(membership.role, permission)) {
    throw new TeamAuthError(API_ERROR.FORBIDDEN, 403);
  }
  return membership;
}

/**
 * Single source of truth for the admin-team membership row passed from
 * `getAdminTeamMemberships` to admin shell components (`AdminShell`,
 * `AdminSidebar`, `AdminScopeSelector`). Centralizing here avoids
 * triplicating the `{ team: { id, name, slug, tenantName, isCrossTenant } }`
 * interface in each consumer.
 */
export type AdminTeamMembership = Awaited<
  ReturnType<typeof getAdminTeamMemberships>
>[number];

/**
 * Get all team memberships where the user holds an ADMIN or OWNER role.
 * Uses withBypassRls to query across tenants since this is called from a
 * layout that does not yet know the tenant context.
 */
export async function getAdminTeamMemberships(userId: string) {
  return withBypassRls(prisma, async (tx) => {
    const userTenantId = await resolveUserTenantIdFromClient(prisma, userId);
    const memberships = await tx.teamMember.findMany({
      where: {
        userId,
        role: { in: [TEAM_ROLE.ADMIN, TEAM_ROLE.OWNER] },
        deactivatedAt: null,
      },
      include: {
        team: {
          select: {
            id: true,
            name: true,
            slug: true,
            tenant: { select: { id: true, name: true } },
          },
        },
      },
    });

    return memberships.map((membership) => ({
      ...membership,
      team: {
        id: membership.team.id,
        name: membership.team.name,
        slug: membership.team.slug,
        tenantName: membership.team.tenant.name,
        isCrossTenant: membership.team.tenant.id !== userTenantId,
      },
    }));
  }, BYPASS_GRANT.TEAM_ADMIN_MEMBERSHIP_LOOKUP);
}

// ─── Error Class ────────────────────────────────────────────────

export class TeamAuthError extends Error {
  override message: ApiErrorCode;
  status: number;

  constructor(code: ApiErrorCode, status: number) {
    super(code);
    this.message = code;
    this.name = "TeamAuthError";
    this.status = status;
  }
}
