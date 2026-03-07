export const AUDIT_TARGET_TYPE = {
  USER: "User",
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
  TEAM: "Team",
  API_KEY: "ApiKey",
  WEBAUTHN_CREDENTIAL: "WebAuthnCredential",
  DIRECTORY_SYNC_CONFIG: "DirectorySyncConfig",
} as const;

export type AuditTargetType =
  (typeof AUDIT_TARGET_TYPE)[keyof typeof AUDIT_TARGET_TYPE];
