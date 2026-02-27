export const TEAM_PERMISSION = {
  TEAM_DELETE: "team:delete",
  TEAM_UPDATE: "team:update",
  MEMBER_INVITE: "member:invite",
  MEMBER_REMOVE: "member:remove",
  MEMBER_CHANGE_ROLE: "member:changeRole",
  PASSWORD_CREATE: "password:create",
  PASSWORD_READ: "password:read",
  PASSWORD_UPDATE: "password:update",
  PASSWORD_DELETE: "password:delete",
  TAG_MANAGE: "tag:manage",
  SCIM_MANAGE: "scim:manage",
} as const;

export type TeamPermissionValue =
  (typeof TEAM_PERMISSION)[keyof typeof TEAM_PERMISSION];
