// Pure team-role hierarchy primitives. NO server-only deps — safe from
// both client components and server code. Mirrors tenant-role-hierarchy.ts.

import type { TeamRole } from "@prisma/client";
import { TEAM_ROLE } from "@/lib/constants";

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
