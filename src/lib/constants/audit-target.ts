export const AUDIT_TARGET_TYPE = {
  ATTACHMENT: "Attachment",
  EMERGENCY_ACCESS_GRANT: "EmergencyAccessGrant",
  FOLDER: "Folder",
  TEAM_FOLDER: "TeamFolder",
  TEAM_INVITATION: "TeamInvitation",
  TEAM_MEMBER: "TeamMember",
  TEAM_PASSWORD_ENTRY: "TeamPasswordEntry",
  PASSWORD_ENTRY: "PasswordEntry",
  PASSWORD_SHARE: "PasswordShare",
  SCIM_TOKEN: "ScimToken",
  SCIM_EXTERNAL_MAPPING: "ScimExternalMapping",
  SESSION: "Session",
} as const;

export type AuditTargetType =
  (typeof AUDIT_TARGET_TYPE)[keyof typeof AUDIT_TARGET_TYPE];
