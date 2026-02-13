export const API_PATH = {
  EXTENSION_TOKEN: "/api/extension/token",
  SHARE_LINKS: "/api/share-links",
  SHARE_LINKS_MINE: "/api/share-links/mine",
  AUDIT_LOGS_EXPORT: "/api/audit-logs/export",
  VAULT_STATUS: "/api/vault/status",
  VAULT_SETUP: "/api/vault/setup",
  VAULT_UNLOCK_DATA: "/api/vault/unlock/data",
  VAULT_UNLOCK: "/api/vault/unlock",
  VAULT_CHANGE_PASSPHRASE: "/api/vault/change-passphrase",
  EMERGENCY_PENDING_CONFIRMATIONS: "/api/emergency-access/pending-confirmations",
} as const;

export const apiPath = {
  emergencyConfirm: (grantId: string) => `/api/emergency-access/${grantId}/confirm`,
  shareLinkById: (shareId: string) => `${API_PATH.SHARE_LINKS}/${shareId}`,
  shareLinkAccessLogs: (shareId: string) =>
    `${API_PATH.SHARE_LINKS}/${shareId}/access-logs`,
} as const;
