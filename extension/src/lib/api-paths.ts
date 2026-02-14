export const EXT_API_PATH = {
  EXTENSION_TOKEN: "/api/extension/token",
  EXTENSION_TOKEN_REFRESH: "/api/extension/token/refresh",
  PASSWORDS: "/api/passwords",
  VAULT_UNLOCK_DATA: "/api/vault/unlock/data",
} as const;

export const extApiPath = {
  passwordById: (entryId: string) => `${EXT_API_PATH.PASSWORDS}/${entryId}`,
} as const;
