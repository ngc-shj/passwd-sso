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
import type { OrgRole } from "@prisma/client";

// ─── Permission Definitions ─────────────────────────────────────

export type OrgPermission =
  | "org:delete"
  | "org:update"
  | "member:invite"
  | "member:remove"
  | "member:changeRole"
  | "password:create"
  | "password:read"
  | "password:update"
  | "password:delete"
  | "tag:manage";

const ROLE_PERMISSIONS: Record<OrgRole, Set<OrgPermission>> = {
  OWNER: new Set([
    "org:delete",
    "org:update",
    "member:invite",
    "member:remove",
    "member:changeRole",
    "password:create",
    "password:read",
    "password:update",
    "password:delete",
    "tag:manage",
  ]),
  ADMIN: new Set([
    "org:update",
    "member:invite",
    "member:remove",
    "member:changeRole",
    "password:create",
    "password:read",
    "password:update",
    "password:delete",
    "tag:manage",
  ]),
  MEMBER: new Set([
    "password:create",
    "password:read",
    "password:update",
    "tag:manage",
  ]),
  VIEWER: new Set(["password:read"]),
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
  OWNER: 4,
  ADMIN: 3,
  MEMBER: 2,
  VIEWER: 1,
};

/** Check if actorRole is strictly higher than targetRole. */
export function isRoleAbove(actorRole: OrgRole, targetRole: OrgRole): boolean {
  return ROLE_LEVEL[actorRole] > ROLE_LEVEL[targetRole];
}

/**
 * Get the membership record for a user in an org.
 * Returns null if the user is not a member.
 */
export async function getOrgMembership(userId: string, orgId: string) {
  return prisma.orgMember.findUnique({
    where: { orgId_userId: { orgId, userId } },
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
    throw new OrgAuthError("Not found", 404);
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
    throw new OrgAuthError("Forbidden", 403);
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
