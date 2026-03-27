export const SA_TOKEN_PREFIX = "sa_";

export const SA_TOKEN_SCOPE = {
  PASSWORDS_READ: "passwords:read",
  PASSWORDS_WRITE: "passwords:write",
  PASSWORDS_LIST: "passwords:list",
  TAGS_READ: "tags:read",
  VAULT_STATUS: "vault:status",
  FOLDERS_READ: "folders:read",
  FOLDERS_WRITE: "folders:write",
  TEAM_PASSWORDS_READ: "team:passwords:read",
  TEAM_PASSWORDS_WRITE: "team:passwords:write",
} as const;

export type SaTokenScope =
  (typeof SA_TOKEN_SCOPE)[keyof typeof SA_TOKEN_SCOPE];

export const SA_TOKEN_SCOPES = Object.values(SA_TOKEN_SCOPE);

/** Scopes that must never be issued on a service account token */
export const SA_TOKEN_FORBIDDEN_SCOPES = [
  "vault:unlock",
  "vault:setup",
  "vault:reset",
] as const;

export const MAX_SERVICE_ACCOUNTS_PER_TENANT = 50;

export const MAX_SA_TOKENS_PER_ACCOUNT = 5;

/** Maximum SA token expiry: 365 days */
export const MAX_SA_TOKEN_EXPIRY_DAYS = 365;

/** Default SA token expiry: 90 days */
export const DEFAULT_SA_TOKEN_EXPIRY_DAYS = 90;

/** Throttle interval for lastUsedAt updates (ms) */
export const SA_TOKEN_LAST_USED_THROTTLE_MS = 5 * 60 * 1000;
