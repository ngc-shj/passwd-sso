export const AUDIT_TARGET_TYPE = {
  ATTACHMENT: "Attachment",
  EMERGENCY_ACCESS_GRANT: "EmergencyAccessGrant",
  ORG_INVITATION: "OrgInvitation",
  ORG_MEMBER: "OrgMember",
  ORG_PASSWORD_ENTRY: "OrgPasswordEntry",
  PASSWORD_ENTRY: "PasswordEntry",
  PASSWORD_SHARE: "PasswordShare",
} as const;

export type AuditTargetType =
  (typeof AUDIT_TARGET_TYPE)[keyof typeof AUDIT_TARGET_TYPE];
