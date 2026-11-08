/**
 * Pure tenant-role hierarchy primitives. NO server-only deps — safe to
 * import from both client components and server code.
 *
 * Lives in its own file (vs. tenant-auth.ts) so client bundles consuming
 * isTenantRoleAbove don't pull in the prisma/pg dependency tree that
 * tenant-auth.ts brings via requireTenantPermission and friends.
 */

import type { TenantRole } from "@prisma/client";

/** Role hierarchy (10-stride for extensibility). */
const ROLE_LEVEL: Record<TenantRole, number> = {
  OWNER: 30,
  ADMIN: 20,
  MEMBER: 10,
};

/** Check if actorRole is strictly higher than targetRole. */
export function isTenantRoleAbove(
  actorRole: TenantRole,
  targetRole: TenantRole,
): boolean {
  return ROLE_LEVEL[actorRole] > ROLE_LEVEL[targetRole];
}

/**
 * Whether actorRole may revoke another member's passkey (#974): strictly
 * above, as for every other action on a member, and also OWNER on OWNER — a
 * passkey revoke deletes no data (the member signs in another way and registers
 * a new one), and without it an OWNER whose only passkey is compromised has no
 * recovery when there is nobody above them.
 */
export function canRevokeMemberPasskey(actorRole: TenantRole, targetRole: TenantRole): boolean {
  return isTenantRoleAbove(actorRole, targetRole) || (actorRole === "OWNER" && targetRole === "OWNER");
}
