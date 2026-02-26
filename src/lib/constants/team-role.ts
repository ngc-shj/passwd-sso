import type { TeamRole } from "@prisma/client";

export const TEAM_ROLE = {
  OWNER: "OWNER",
  ADMIN: "ADMIN",
  MEMBER: "MEMBER",
  VIEWER: "VIEWER",
} as const satisfies Record<TeamRole, TeamRole>;

export type TeamRoleValue = TeamRole;

export const TEAM_ROLE_VALUES = [
  TEAM_ROLE.OWNER,
  TEAM_ROLE.ADMIN,
  TEAM_ROLE.MEMBER,
  TEAM_ROLE.VIEWER,
] as const satisfies readonly [TeamRole, ...TeamRole[]];

export const TEAM_INVITE_ROLE_VALUES = [
  TEAM_ROLE.ADMIN,
  TEAM_ROLE.MEMBER,
  TEAM_ROLE.VIEWER,
] as const satisfies readonly [TeamRole, ...TeamRole[]];

export const INVITE_ROLE_VALUES = TEAM_INVITE_ROLE_VALUES;
