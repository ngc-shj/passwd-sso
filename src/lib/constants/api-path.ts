export const API_PATH = {
  EXTENSION_TOKEN: "/api/extension/token",
  VAULT_STATUS: "/api/vault/status",
  VAULT_SETUP: "/api/vault/setup",
  VAULT_UNLOCK_DATA: "/api/vault/unlock/data",
  VAULT_UNLOCK: "/api/vault/unlock",
  VAULT_CHANGE_PASSPHRASE: "/api/vault/change-passphrase",
  EMERGENCY_PENDING_CONFIRMATIONS: "/api/emergency-access/pending-confirmations",
} as const;

export const apiPath = {
  emergencyConfirm: (grantId: string) => `/api/emergency-access/${grantId}/confirm`,
} as const;
