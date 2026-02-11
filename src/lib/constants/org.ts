import type { OrgRole } from "@prisma/client";

export const ORG_ROLE = {
  OWNER: "OWNER",
  ADMIN: "ADMIN",
  MEMBER: "MEMBER",
  VIEWER: "VIEWER",
} as const satisfies Record<OrgRole, OrgRole>;

export type OrgRoleValue = OrgRole;

export const ORG_ROLE_VALUES = [
  ORG_ROLE.OWNER,
  ORG_ROLE.ADMIN,
  ORG_ROLE.MEMBER,
  ORG_ROLE.VIEWER,
] as const satisfies readonly [OrgRole, ...OrgRole[]];

export const INVITE_ROLE_VALUES = [
  ORG_ROLE.ADMIN,
  ORG_ROLE.MEMBER,
  ORG_ROLE.VIEWER,
] as const satisfies readonly [OrgRole, ...OrgRole[]];
