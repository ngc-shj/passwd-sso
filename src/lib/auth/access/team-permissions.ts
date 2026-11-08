/**
 * Team role permissions, free of server imports so client components can apply
 * the same rules the routes enforce (team-auth.ts re-exports them).
 */

import { TEAM_PERMISSION, TEAM_ROLE } from "@/lib/constants";
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

/**
 * Whether `role` may write an existing entry's content or key material
 * (full-update PUT, history restore, attachment upload): PASSWORD_UPDATE, and
 * a MEMBER only on an entry they created.
 */
export function canWriteTeamEntry(
  role: TeamRole,
  createdById: string,
  userId: string,
): boolean {
  if (!hasTeamPermission(role, TEAM_PERMISSION.PASSWORD_UPDATE)) return false;
  return role !== TEAM_ROLE.MEMBER || createdById === userId;
}
