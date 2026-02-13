export const AUDIT_TARGET_TYPE = {
  ATTACHMENT: "Attachment",
} as const;

export type AuditTargetType =
  (typeof AUDIT_TARGET_TYPE)[keyof typeof AUDIT_TARGET_TYPE];
