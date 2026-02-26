import type { OrgRole } from "@prisma/client";

export const TEAM_ROLE = {
  OWNER: "OWNER",
  ADMIN: "ADMIN",
  MEMBER: "MEMBER",
  VIEWER: "VIEWER",
} as const satisfies Record<OrgRole, OrgRole>;

export type TeamRoleValue = OrgRole;

export const TEAM_ROLE_VALUES = [
  TEAM_ROLE.OWNER,
  TEAM_ROLE.ADMIN,
  TEAM_ROLE.MEMBER,
  TEAM_ROLE.VIEWER,
] as const satisfies readonly [OrgRole, ...OrgRole[]];

export const TEAM_INVITE_ROLE_VALUES = [
  TEAM_ROLE.ADMIN,
  TEAM_ROLE.MEMBER,
  TEAM_ROLE.VIEWER,
] as const satisfies readonly [OrgRole, ...OrgRole[]];

export const INVITE_ROLE_VALUES = TEAM_INVITE_ROLE_VALUES;
