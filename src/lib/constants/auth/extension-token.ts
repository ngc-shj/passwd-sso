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
  EXTENSION_TOKEN_SCOPE.PASSWORDS_WRITE,
  EXTENSION_TOKEN_SCOPE.VAULT_UNLOCK_DATA,
] as const satisfies readonly ExtensionTokenScope[];

/**
 * Default scopes minted for an iOS host-app token.
 *
 * The AutoFill extension does not receive its own token — the host iOS app
 * holds the single ExtensionToken (clientKind = IOS_APP) and brokers all
 * AutoFill provider requests through the app/extension shared keychain.
 * Scope set is intentionally identical to the browser-extension default so
 * the existing scope-checking logic on the API side keeps working unchanged.
 */
export const IOS_TOKEN_DEFAULT_SCOPES = [
  EXTENSION_TOKEN_SCOPE.PASSWORDS_READ,
  EXTENSION_TOKEN_SCOPE.PASSWORDS_WRITE,
  EXTENSION_TOKEN_SCOPE.VAULT_UNLOCK_DATA,
] as const satisfies readonly ExtensionTokenScope[];

/**
 * Maximum active (non-revoked, non-expired) tokens per user.
 * Independent throttle against token-issuance abuse; complements the
 * per-family absolute lifetime (tenant.extensionTokenAbsoluteTimeoutMinutes).
 */
export const EXTENSION_TOKEN_MAX_ACTIVE = 3;
