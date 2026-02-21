export const EXTENSION_TOKEN_SCOPE = {
  PASSWORDS_READ: "passwords:read",
  PASSWORDS_WRITE: "passwords:write",
  VAULT_UNLOCK_DATA: "vault:unlock-data",
} as const;

export type ExtensionTokenScope =
  (typeof EXTENSION_TOKEN_SCOPE)[keyof typeof EXTENSION_TOKEN_SCOPE];

export const EXTENSION_TOKEN_SCOPE_VALUES = [
  EXTENSION_TOKEN_SCOPE.PASSWORDS_READ,
  EXTENSION_TOKEN_SCOPE.PASSWORDS_WRITE,
  EXTENSION_TOKEN_SCOPE.VAULT_UNLOCK_DATA,
] as const satisfies readonly [ExtensionTokenScope, ...ExtensionTokenScope[]];

export const EXTENSION_TOKEN_DEFAULT_SCOPES = [
  EXTENSION_TOKEN_SCOPE.PASSWORDS_READ,
  EXTENSION_TOKEN_SCOPE.VAULT_UNLOCK_DATA,
] as const satisfies readonly ExtensionTokenScope[];

/** Token TTL in milliseconds (15 minutes) */
export const EXTENSION_TOKEN_TTL_MS = 15 * 60 * 1000;

/** Maximum active (non-revoked, non-expired) tokens per user */
export const EXTENSION_TOKEN_MAX_ACTIVE = 3;
