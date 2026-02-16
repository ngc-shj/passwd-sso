export const API_PATH = {
  API_ROOT: "/api",
  AUTH_SESSION: "/api/auth/session",
  EXTENSION_TOKEN: "/api/extension/token",
  EXTENSION_TOKEN_REFRESH: "/api/extension/token/refresh",
  PASSWORDS: "/api/passwords",
  PASSWORDS_BULK_TRASH: "/api/passwords/bulk-trash",
  PASSWORDS_BULK_ARCHIVE: "/api/passwords/bulk-archive",
  PASSWORDS_BULK_RESTORE: "/api/passwords/bulk-restore",
  PASSWORDS_EMPTY_TRASH: "/api/passwords/empty-trash",
  PASSWORDS_GENERATE: "/api/passwords/generate",
  TAGS: "/api/tags",
  ORGS: "/api/orgs",
  ORGS_ARCHIVED: "/api/orgs/archived",
  ORGS_FAVORITES: "/api/orgs/favorites",
  ORGS_TRASH: "/api/orgs/trash",
  ORGS_INVITATIONS_ACCEPT: "/api/orgs/invitations/accept",
  AUDIT_LOGS: "/api/audit-logs",
  SHARE_LINKS: "/api/share-links",
  SHARE_LINKS_MINE: "/api/share-links/mine",
  AUDIT_LOGS_IMPORT: "/api/audit-logs/import",
  AUDIT_LOGS_EXPORT: "/api/audit-logs/export",
  VAULT_STATUS: "/api/vault/status",
  VAULT_SETUP: "/api/vault/setup",
  VAULT_UNLOCK_DATA: "/api/vault/unlock/data",
  VAULT_UNLOCK: "/api/vault/unlock",
  VAULT_CHANGE_PASSPHRASE: "/api/vault/change-passphrase",
  VAULT_RECOVERY_KEY_GENERATE: "/api/vault/recovery-key/generate",
  VAULT_RECOVERY_KEY_RECOVER: "/api/vault/recovery-key/recover",
  VAULT_RESET: "/api/vault/reset",
  EMERGENCY_ACCESS: "/api/emergency-access",
  EMERGENCY_ACCESS_ACCEPT: "/api/emergency-access/accept",
  EMERGENCY_ACCESS_REJECT: "/api/emergency-access/reject",
  EMERGENCY_PENDING_CONFIRMATIONS: "/api/emergency-access/pending-confirmations",
  WATCHTOWER_START: "/api/watchtower/start",
  WATCHTOWER_HIBP: "/api/watchtower/hibp",
  CSP_REPORT: "/api/csp-report",
  HEALTH_LIVE: "/api/health/live",
  HEALTH_READY: "/api/health/ready",
} as const;

export const apiPath = {
  emergencyConfirm: (grantId: string) => `/api/emergency-access/${grantId}/confirm`,
  emergencyGrantById: (grantId: string) => `${API_PATH.EMERGENCY_ACCESS}/${grantId}`,
  emergencyGrantAction: (grantId: string, action: string) =>
    `${API_PATH.EMERGENCY_ACCESS}/${grantId}/${action}`,
  emergencyGrantVault: (grantId: string) =>
    `${API_PATH.EMERGENCY_ACCESS}/${grantId}/vault`,
  emergencyGrantVaultEntries: (grantId: string) =>
    `${API_PATH.EMERGENCY_ACCESS}/${grantId}/vault/entries`,
  orgById: (orgId: string) => `${API_PATH.ORGS}/${orgId}`,
  orgMembers: (orgId: string) => `${API_PATH.ORGS}/${orgId}/members`,
  orgMemberById: (orgId: string, memberId: string) =>
    `${API_PATH.ORGS}/${orgId}/members/${memberId}`,
  orgInvitations: (orgId: string) => `${API_PATH.ORGS}/${orgId}/invitations`,
  orgInvitationById: (orgId: string, invitationId: string) =>
    `${API_PATH.ORGS}/${orgId}/invitations/${invitationId}`,
  orgPasswords: (orgId: string) => `${API_PATH.ORGS}/${orgId}/passwords`,
  orgPasswordById: (orgId: string, entryId: string) =>
    `${API_PATH.ORGS}/${orgId}/passwords/${entryId}`,
  orgPasswordFavorite: (orgId: string, entryId: string) =>
    `${API_PATH.ORGS}/${orgId}/passwords/${entryId}/favorite`,
  orgPasswordRestore: (orgId: string, entryId: string) =>
    `${API_PATH.ORGS}/${orgId}/passwords/${entryId}/restore`,
  orgPasswordAttachments: (orgId: string, entryId: string) =>
    `${API_PATH.ORGS}/${orgId}/passwords/${entryId}/attachments`,
  orgPasswordAttachmentById: (orgId: string, entryId: string, attachmentId: string) =>
    `${API_PATH.ORGS}/${orgId}/passwords/${entryId}/attachments/${attachmentId}`,
  orgTags: (orgId: string) => `${API_PATH.ORGS}/${orgId}/tags`,
  orgAuditLogs: (orgId: string) => `${API_PATH.ORGS}/${orgId}/audit-logs`,
  passwordById: (entryId: string) => `${API_PATH.PASSWORDS}/${entryId}`,
  passwordsBulkTrash: () => API_PATH.PASSWORDS_BULK_TRASH,
  passwordsBulkArchive: () => API_PATH.PASSWORDS_BULK_ARCHIVE,
  passwordsBulkRestore: () => API_PATH.PASSWORDS_BULK_RESTORE,
  passwordsEmptyTrash: () => API_PATH.PASSWORDS_EMPTY_TRASH,
  passwordRestore: (entryId: string) =>
    `${API_PATH.PASSWORDS}/${entryId}/restore`,
  passwordAttachments: (entryId: string) =>
    `${API_PATH.PASSWORDS}/${entryId}/attachments`,
  passwordAttachmentById: (entryId: string, attachmentId: string) =>
    `${API_PATH.PASSWORDS}/${entryId}/attachments/${attachmentId}`,
  shareLinkById: (shareId: string) => `${API_PATH.SHARE_LINKS}/${shareId}`,
  shareLinkAccessLogs: (shareId: string) =>
    `${API_PATH.SHARE_LINKS}/${shareId}/access-logs`,
} as const;
