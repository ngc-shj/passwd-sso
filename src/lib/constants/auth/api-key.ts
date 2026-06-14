import { MS_PER_MINUTE, DAYS_PER_YEAR } from "../time";

export const API_KEY_PREFIX = "api_";

/** Throttle interval for lastUsedAt writes — parity with SA_TOKEN_LAST_USED_THROTTLE_MS */
export const API_KEY_LAST_USED_THROTTLE_MS = 5 * MS_PER_MINUTE;

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
export const MAX_API_KEY_EXPIRY_DAYS = DAYS_PER_YEAR;

/** Default API key expiry: 90 days */
export const DEFAULT_API_KEY_EXPIRY_DAYS = 90;
