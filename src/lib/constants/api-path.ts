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
  FOLDERS: "/api/folders",
  TAGS: "/api/tags",
  MAINTENANCE_PURGE_HISTORY: "/api/maintenance/purge-history",
  TEAMS: "/api/teams",
  TEAMS_ARCHIVED: "/api/teams/archived",
  TEAMS_FAVORITES: "/api/teams/favorites",
  TEAMS_TRASH: "/api/teams/trash",
  TEAMS_INVITATIONS_ACCEPT: "/api/teams/invitations/accept",
  TEAMS_PENDING_KEY_DISTRIBUTIONS: "/api/teams/pending-key-distributions",
  AUDIT_LOGS: "/api/audit-logs",
  SHARE_LINKS: "/api/share-links",
  SHARE_LINKS_MINE: "/api/share-links/mine",
  SENDS: "/api/sends",
  SENDS_FILE: "/api/sends/file",
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
  SESSIONS: "/api/sessions",
  SCIM_V2: "/api/scim/v2",
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
  teamById: (teamId: string) => `${API_PATH.TEAMS}/${teamId}`,
  teamMembers: (teamId: string) => `${API_PATH.TEAMS}/${teamId}/members`,
  teamMemberById: (teamId: string, memberId: string) =>
    `${API_PATH.TEAMS}/${teamId}/members/${memberId}`,
  teamInvitations: (teamId: string) => `${API_PATH.TEAMS}/${teamId}/invitations`,
  teamInvitationById: (teamId: string, invitationId: string) =>
    `${API_PATH.TEAMS}/${teamId}/invitations/${invitationId}`,
  teamPasswords: (teamId: string) => `${API_PATH.TEAMS}/${teamId}/passwords`,
  teamPasswordById: (teamId: string, entryId: string) =>
    `${API_PATH.TEAMS}/${teamId}/passwords/${entryId}`,
  teamPasswordFavorite: (teamId: string, entryId: string) =>
    `${API_PATH.TEAMS}/${teamId}/passwords/${entryId}/favorite`,
  teamPasswordRestore: (teamId: string, entryId: string) =>
    `${API_PATH.TEAMS}/${teamId}/passwords/${entryId}/restore`,
  teamPasswordAttachments: (teamId: string, entryId: string) =>
    `${API_PATH.TEAMS}/${teamId}/passwords/${entryId}/attachments`,
  teamPasswordAttachmentById: (teamId: string, entryId: string, attachmentId: string) =>
    `${API_PATH.TEAMS}/${teamId}/passwords/${entryId}/attachments/${attachmentId}`,
  teamMemberKey: (teamId: string) => `${API_PATH.TEAMS}/${teamId}/member-key`,
  teamMemberConfirmKey: (teamId: string, memberId: string) =>
    `${API_PATH.TEAMS}/${teamId}/members/${memberId}/confirm-key`,
  teamTags: (teamId: string) => `${API_PATH.TEAMS}/${teamId}/tags`,
  teamAuditLogs: (teamId: string) => `${API_PATH.TEAMS}/${teamId}/audit-logs`,
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
  sendById: (sendId: string) => `${API_PATH.SENDS}/${sendId}`,
  shareLinkById: (shareId: string) => `${API_PATH.SHARE_LINKS}/${shareId}`,
  shareLinkAccessLogs: (shareId: string) =>
    `${API_PATH.SHARE_LINKS}/${shareId}/access-logs`,
  folderById: (folderId: string) => `${API_PATH.FOLDERS}/${folderId}`,
  teamFolders: (teamId: string) => `${API_PATH.TEAMS}/${teamId}/folders`,
  teamFolderById: (teamId: string, folderId: string) =>
    `${API_PATH.TEAMS}/${teamId}/folders/${folderId}`,
  passwordHistory: (entryId: string) =>
    `${API_PATH.PASSWORDS}/${entryId}/history`,
  passwordHistoryRestore: (entryId: string, historyId: string) =>
    `${API_PATH.PASSWORDS}/${entryId}/history/${historyId}/restore`,
  teamPasswordHistory: (teamId: string, entryId: string) =>
    `${API_PATH.TEAMS}/${teamId}/passwords/${entryId}/history`,
  teamPasswordHistoryById: (teamId: string, entryId: string, historyId: string) =>
    `${API_PATH.TEAMS}/${teamId}/passwords/${entryId}/history/${historyId}`,
  teamPasswordHistoryRestore: (teamId: string, entryId: string, historyId: string) =>
    `${API_PATH.TEAMS}/${teamId}/passwords/${entryId}/history/${historyId}/restore`,
  sessionById: (sessionId: string) => `${API_PATH.SESSIONS}/${sessionId}`,
  teamScimTokens: (teamId: string) => `${API_PATH.TEAMS}/${teamId}/scim-tokens`,
  teamScimTokenById: (teamId: string, tokenId: string) =>
    `${API_PATH.TEAMS}/${teamId}/scim-tokens/${tokenId}`,
} as const;
