export const API_KEY_PREFIX = "api_";

export const API_KEY_SCOPE = {
  PASSWORDS_READ: "passwords:read",
  PASSWORDS_WRITE: "passwords:write",
  TAGS_READ: "tags:read",
  VAULT_STATUS: "vault:status",
} as const;

export type ApiKeyScope = (typeof API_KEY_SCOPE)[keyof typeof API_KEY_SCOPE];

export const API_KEY_SCOPES = [
  API_KEY_SCOPE.PASSWORDS_READ,
  API_KEY_SCOPE.PASSWORDS_WRITE,
  API_KEY_SCOPE.TAGS_READ,
  API_KEY_SCOPE.VAULT_STATUS,
] as const;

/** Scopes that must never be issued on an API key */
export const API_KEY_FORBIDDEN_SCOPES = [
  "vault:unlock",
  "vault:setup",
  "vault:reset",
] as const;

export const MAX_API_KEYS_PER_USER = 10;

/** Maximum API key expiry: 365 days */
export const MAX_API_KEY_EXPIRY_DAYS = 365;

/** Default API key expiry: 90 days */
export const DEFAULT_API_KEY_EXPIRY_DAYS = 90;
