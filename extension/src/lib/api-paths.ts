export const EXT_API_PATH = {
  EXTENSION_TOKEN: "/api/extension/token",
  EXTENSION_TOKEN_REFRESH: "/api/extension/token/refresh",
  EXTENSION_TOKEN_EXCHANGE: "/api/extension/token/exchange",
  PASSWORDS: "/api/passwords",
  VAULT_UNLOCK_DATA: "/api/vault/unlock/data",
  TEAMS: "/api/teams",
} as const;

export const extApiPath = {
  passwordById: (entryId: string) => `${EXT_API_PATH.PASSWORDS}/${entryId}`,
  teamMemberKey: (teamId: string) => `${EXT_API_PATH.TEAMS}/${teamId}/member-key`,
  teamPasswords: (teamId: string) => `${EXT_API_PATH.TEAMS}/${teamId}/passwords`,
  teamPasswordById: (teamId: string, entryId: string) =>
    `${EXT_API_PATH.TEAMS}/${teamId}/passwords/${entryId}`,
} as const;
