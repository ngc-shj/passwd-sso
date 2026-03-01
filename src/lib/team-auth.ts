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
import { API_ERROR } from "@/lib/api-error-codes";
import { TEAM_PERMISSION, TEAM_ROLE } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import type { TeamRole } from "@prisma/client";

// ─── Permission Definitions ─────────────────────────────────────

export type TeamPermission =
  (typeof TEAM_PERMISSION)[keyof typeof TEAM_PERMISSION];

const ROLE_PERMISSIONS: Record<TeamRole, Set<TeamPermission>> = {
  [TEAM_ROLE.OWNER]: new Set([
    TEAM_PERMISSION.TEAM_DELETE,
    TEAM_PERMISSION.TEAM_UPDATE,
    TEAM_PERMISSION.MEMBER_INVITE,
    TEAM_PERMISSION.MEMBER_REMOVE,
    TEAM_PERMISSION.MEMBER_CHANGE_ROLE,
    TEAM_PERMISSION.PASSWORD_CREATE,
    TEAM_PERMISSION.PASSWORD_READ,
    TEAM_PERMISSION.PASSWORD_UPDATE,
    TEAM_PERMISSION.PASSWORD_DELETE,
    TEAM_PERMISSION.TAG_MANAGE,
    TEAM_PERMISSION.SCIM_MANAGE,
  ]),
  [TEAM_ROLE.ADMIN]: new Set([
    TEAM_PERMISSION.TEAM_UPDATE,
    TEAM_PERMISSION.MEMBER_INVITE,
    TEAM_PERMISSION.MEMBER_REMOVE,
    TEAM_PERMISSION.MEMBER_CHANGE_ROLE,
    TEAM_PERMISSION.PASSWORD_CREATE,
    TEAM_PERMISSION.PASSWORD_READ,
    TEAM_PERMISSION.PASSWORD_UPDATE,
    TEAM_PERMISSION.PASSWORD_DELETE,
    TEAM_PERMISSION.TAG_MANAGE,
    TEAM_PERMISSION.SCIM_MANAGE,
  ]),
  [TEAM_ROLE.MEMBER]: new Set([
    TEAM_PERMISSION.PASSWORD_CREATE,
    TEAM_PERMISSION.PASSWORD_READ,
    TEAM_PERMISSION.PASSWORD_UPDATE,
    TEAM_PERMISSION.TAG_MANAGE,
  ]),
  [TEAM_ROLE.VIEWER]: new Set([TEAM_PERMISSION.PASSWORD_READ]),
};

// ─── Helpers ────────────────────────────────────────────────────

/** Check if a role has a specific permission. */
export function hasTeamPermission(
  role: TeamRole,
  permission: TeamPermission
): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

/** Role hierarchy for comparison (higher = more privileged). */
const ROLE_LEVEL: Record<TeamRole, number> = {
  [TEAM_ROLE.OWNER]: 4,
  [TEAM_ROLE.ADMIN]: 3,
  [TEAM_ROLE.MEMBER]: 2,
  [TEAM_ROLE.VIEWER]: 1,
};

/** Check if actorRole is strictly higher than targetRole. */
export function isRoleAbove(actorRole: TeamRole, targetRole: TeamRole): boolean {
  return ROLE_LEVEL[actorRole] > ROLE_LEVEL[targetRole];
}

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
 * Returns the membership record, or throws a structured error.
 */
export async function requireTeamMember(userId: string, teamId: string) {
  const membership = await getTeamMembership(userId, teamId);
  if (!membership) {
    // Hide team existence from non-members
    throw new TeamAuthError(API_ERROR.NOT_FOUND, 404);
  }
  return membership;
}

/**
 * Require that the user has a specific permission in the team.
 * Returns the membership record, or throws a structured error.
 */
export async function requireTeamPermission(
  userId: string,
  teamId: string,
  permission: TeamPermission
) {
  const membership = await requireTeamMember(userId, teamId);
  if (!hasTeamPermission(membership.role, permission)) {
    throw new TeamAuthError(API_ERROR.FORBIDDEN, 403);
  }
  return membership;
}

// ─── Error Class ────────────────────────────────────────────────

export class TeamAuthError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "TeamAuthError";
    this.status = status;
  }
}
