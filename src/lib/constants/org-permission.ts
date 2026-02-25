export const ORG_PERMISSION = {
  ORG_DELETE: "org:delete",
  ORG_UPDATE: "org:update",
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

export type OrgPermissionValue =
  (typeof ORG_PERMISSION)[keyof typeof ORG_PERMISSION];
