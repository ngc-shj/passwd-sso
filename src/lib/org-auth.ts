/**
 * Organization authorization helpers (RBAC).
 *
 * Permissions are derived from OrgRole:
 *   OWNER  — full control
 *   ADMIN  — manage members, passwords, tags (cannot delete org)
 *   MEMBER — create passwords, manage own, manage tags
 *   VIEWER — read-only access to passwords
 */

import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/api-error-codes";
import { TEAM_PERMISSION, TEAM_ROLE } from "@/lib/constants";
import type { OrgRole } from "@prisma/client";

// ─── Permission Definitions ─────────────────────────────────────

export type OrgPermission =
  (typeof TEAM_PERMISSION)[keyof typeof TEAM_PERMISSION];

const ROLE_PERMISSIONS: Record<OrgRole, Set<OrgPermission>> = {
  [TEAM_ROLE.OWNER]: new Set([
    TEAM_PERMISSION.ORG_DELETE,
    TEAM_PERMISSION.ORG_UPDATE,
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
    TEAM_PERMISSION.ORG_UPDATE,
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
export function hasOrgPermission(
  role: OrgRole,
  permission: OrgPermission
): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

/** Role hierarchy for comparison (higher = more privileged). */
const ROLE_LEVEL: Record<OrgRole, number> = {
  [TEAM_ROLE.OWNER]: 4,
  [TEAM_ROLE.ADMIN]: 3,
  [TEAM_ROLE.MEMBER]: 2,
  [TEAM_ROLE.VIEWER]: 1,
};

/** Check if actorRole is strictly higher than targetRole. */
export function isRoleAbove(actorRole: OrgRole, targetRole: OrgRole): boolean {
  return ROLE_LEVEL[actorRole] > ROLE_LEVEL[targetRole];
}

/**
 * Get the membership record for a user in an org.
 * Returns null if the user is not a member (or is deactivated).
 *
 * Uses findFirst instead of findUnique because Prisma's findUnique
 * cannot include non-unique-index fields (deactivatedAt) in the where clause.
 * The @@unique([orgId, userId]) constraint ensures at most one row per org+user.
 */
export async function getOrgMembership(userId: string, orgId: string) {
  return prisma.orgMember.findFirst({
    where: { orgId, userId, deactivatedAt: null },
  });
}

/**
 * Require that the user is a member of the org.
 * Returns the membership record, or throws a structured error.
 */
export async function requireOrgMember(userId: string, orgId: string) {
  const membership = await getOrgMembership(userId, orgId);
  if (!membership) {
    // Hide org existence from non-members
    throw new OrgAuthError(API_ERROR.NOT_FOUND, 404);
  }
  return membership;
}

/**
 * Require that the user has a specific permission in the org.
 * Returns the membership record, or throws a structured error.
 */
export async function requireOrgPermission(
  userId: string,
  orgId: string,
  permission: OrgPermission
) {
  const membership = await requireOrgMember(userId, orgId);
  if (!hasOrgPermission(membership.role, permission)) {
    throw new OrgAuthError(API_ERROR.FORBIDDEN, 403);
  }
  return membership;
}

// ─── Error Class ────────────────────────────────────────────────

export class OrgAuthError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "OrgAuthError";
    this.status = status;
  }
}
