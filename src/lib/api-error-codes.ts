/**
 * Centralized error codes for ALL API routes (including Emergency Access).
 * Imported by both server (API routes) and client (components).
 *
 * ## Usage rules
 *
 * ### Server side (API routes)
 * - Always return `{ error: API_ERROR.XXX }` — never raw English strings.
 * - For Zod validation failures: `{ error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() }`
 *
 * ### Client side (components)
 * - **EA UI** (grant-card, create-grant-dialog, invite/[token], [id]/vault):
 *   → `t(eaErrorToI18nKey(err?.error))` with `useTranslations("EmergencyAccess")`
 * - **Everything else**:
 *   → `tApi(apiErrorToI18nKey(err?.error))` with `useTranslations("ApiErrors")`
 * - If a specific domain needs overrides (e.g. `NOT_FOUND` → "shareNotFound"),
 *   pass `overrides` to `apiErrorToI18nKey(err?.error, { NOT_FOUND: "shareNotFound" })`.
 */
export const API_ERROR = {
  // ── Common ────────────────────────────────────────────────
  UNAUTHORIZED: "UNAUTHORIZED",
  RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED",
  INVALID_JSON: "INVALID_JSON",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  NOT_FOUND: "NOT_FOUND",
  FORBIDDEN: "FORBIDDEN",

  // ── Vault ─────────────────────────────────────────────────
  VAULT_ALREADY_SETUP: "VAULT_ALREADY_SETUP",
  VAULT_NOT_SETUP: "VAULT_NOT_SETUP",
  INVALID_PASSPHRASE: "INVALID_PASSPHRASE",
  VERIFIER_NOT_SET: "VERIFIER_NOT_SET",
  VERIFIER_VERSION_UNSUPPORTED: "VERIFIER_VERSION_UNSUPPORTED",
  USER_NOT_FOUND: "USER_NOT_FOUND",
  ACCOUNT_LOCKED: "ACCOUNT_LOCKED",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  INVALID_RECOVERY_KEY: "INVALID_RECOVERY_KEY",
  RECOVERY_KEY_NOT_SET: "RECOVERY_KEY_NOT_SET",
  VAULT_RESET_CONFIRMATION_MISMATCH: "VAULT_RESET_CONFIRMATION_MISMATCH",
  INVALID_ORIGIN: "INVALID_ORIGIN",

  // ── Tags ──────────────────────────────────────────────────
  TAG_ALREADY_EXISTS: "TAG_ALREADY_EXISTS",

  // ── Folders ─────────────────────────────────────────────────
  FOLDER_ALREADY_EXISTS: "FOLDER_ALREADY_EXISTS",
  FOLDER_MAX_DEPTH_EXCEEDED: "FOLDER_MAX_DEPTH_EXCEEDED",
  FOLDER_CIRCULAR_REFERENCE: "FOLDER_CIRCULAR_REFERENCE",
  FOLDER_NOT_FOUND: "FOLDER_NOT_FOUND",

  // ── History ─────────────────────────────────────────────────
  HISTORY_NOT_FOUND: "HISTORY_NOT_FOUND",

  // ── Passwords / Attachments ──────────────────────────────
  NOT_IN_TRASH: "NOT_IN_TRASH",
  ATTACHMENT_NOT_FOUND: "ATTACHMENT_NOT_FOUND",
  ATTACHMENT_LIMIT_EXCEEDED: "ATTACHMENT_LIMIT_EXCEEDED",
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  MISSING_REQUIRED_FIELDS: "MISSING_REQUIRED_FIELDS",
  EXTENSION_NOT_ALLOWED: "EXTENSION_NOT_ALLOWED",
  CONTENT_TYPE_NOT_ALLOWED: "CONTENT_TYPE_NOT_ALLOWED",
  INVALID_FORM_DATA: "INVALID_FORM_DATA",
  INVALID_IV_FORMAT: "INVALID_IV_FORMAT",
  INVALID_AUTH_TAG_FORMAT: "INVALID_AUTH_TAG_FORMAT",

  // ── Orgs ──────────────────────────────────────────────────
  SLUG_ALREADY_TAKEN: "SLUG_ALREADY_TAKEN",
  ORG_NOT_FOUND: "ORG_NOT_FOUND",
  MEMBER_NOT_FOUND: "MEMBER_NOT_FOUND",
  ALREADY_A_MEMBER: "ALREADY_A_MEMBER",
  OWNER_ONLY: "OWNER_ONLY",
  CANNOT_CHANGE_OWNER_ROLE: "CANNOT_CHANGE_OWNER_ROLE",
  CANNOT_CHANGE_HIGHER_ROLE: "CANNOT_CHANGE_HIGHER_ROLE",
  CANNOT_REMOVE_OWNER: "CANNOT_REMOVE_OWNER",
  CANNOT_REMOVE_HIGHER_ROLE: "CANNOT_REMOVE_HIGHER_ROLE",
  ONLY_OWN_ENTRIES: "ONLY_OWN_ENTRIES",
  DECRYPT_FAILED: "DECRYPT_FAILED",
  INVALID_DATE_RANGE: "INVALID_DATE_RANGE",

  // ── Org Invitations ───────────────────────────────────────
  TOKEN_REQUIRED: "TOKEN_REQUIRED",
  INVALID_INVITATION: "INVALID_INVITATION",
  INVITATION_ALREADY_USED: "INVITATION_ALREADY_USED",
  INVITATION_EXPIRED: "INVITATION_EXPIRED",
  INVITATION_WRONG_EMAIL: "INVITATION_WRONG_EMAIL",
  INVITATION_ALREADY_SENT: "INVITATION_ALREADY_SENT",
  INVITATION_NOT_FOUND: "INVITATION_NOT_FOUND",

  // ── Share Links ───────────────────────────────────────────
  ALREADY_REVOKED: "ALREADY_REVOKED",

  // ── Watchtower ────────────────────────────────────────────
  INVALID_PREFIX: "INVALID_PREFIX",
  UPSTREAM_ERROR: "UPSTREAM_ERROR",

  // ── Pagination ──────────────────────────────────────────────
  INVALID_CURSOR: "INVALID_CURSOR",

  // ── Audit ─────────────────────────────────────────────────
  INVALID_BODY: "INVALID_BODY",

  // ── Emergency Access ──────────────────────────────────────
  GRANT_NOT_PENDING: "GRANT_NOT_PENDING",
  CANNOT_GRANT_SELF: "CANNOT_GRANT_SELF",
  DUPLICATE_GRANT: "DUPLICATE_GRANT",
  INVALID_STATUS: "INVALID_STATUS",
  NOT_AUTHORIZED_FOR_GRANT: "NOT_AUTHORIZED_FOR_GRANT",
  NOT_ACTIVATED: "NOT_ACTIVATED",
  KEY_ESCROW_NOT_COMPLETED: "KEY_ESCROW_NOT_COMPLETED",
  INCOMPATIBLE_KEY_ALGORITHM: "INCOMPATIBLE_KEY_ALGORITHM",

  // ── Extension Token ─────────────────────────────────────
  EXTENSION_TOKEN_EXPIRED: "EXTENSION_TOKEN_EXPIRED",
  EXTENSION_TOKEN_REVOKED: "EXTENSION_TOKEN_REVOKED",
  EXTENSION_TOKEN_INVALID: "EXTENSION_TOKEN_INVALID",
  EXTENSION_TOKEN_SCOPE_INSUFFICIENT: "EXTENSION_TOKEN_SCOPE_INSUFFICIENT",
} as const;

export type ApiErrorCode = (typeof API_ERROR)[keyof typeof API_ERROR];

/**
 * Maps every error code to an i18n key under the ApiErrors namespace.
 * `satisfies` ensures compile-time completeness — adding a new code to API_ERROR
 * without updating this map causes a TypeScript error.
 */
const API_ERROR_I18N: Record<ApiErrorCode, string> = {
  UNAUTHORIZED: "unauthorized",
  RATE_LIMIT_EXCEEDED: "rateLimitExceeded",
  INVALID_JSON: "invalidRequest",
  VALIDATION_ERROR: "validationError",
  NOT_FOUND: "notFound",
  FORBIDDEN: "forbidden",
  VAULT_ALREADY_SETUP: "vaultAlreadySetup",
  VAULT_NOT_SETUP: "vaultNotSetup",
  INVALID_PASSPHRASE: "invalidPassphrase",
  VERIFIER_NOT_SET: "verifierNotSet",
  VERIFIER_VERSION_UNSUPPORTED: "verifierVersionUnsupported",
  USER_NOT_FOUND: "userNotFound",
  ACCOUNT_LOCKED: "accountLocked",
  SERVICE_UNAVAILABLE: "serviceUnavailable",
  TAG_ALREADY_EXISTS: "tagAlreadyExists",
  FOLDER_ALREADY_EXISTS: "folderAlreadyExists",
  FOLDER_MAX_DEPTH_EXCEEDED: "folderMaxDepthExceeded",
  FOLDER_CIRCULAR_REFERENCE: "folderCircularReference",
  FOLDER_NOT_FOUND: "folderNotFound",
  HISTORY_NOT_FOUND: "historyNotFound",
  NOT_IN_TRASH: "notInTrash",
  ATTACHMENT_NOT_FOUND: "attachmentNotFound",
  ATTACHMENT_LIMIT_EXCEEDED: "attachmentLimitExceeded",
  FILE_TOO_LARGE: "fileTooLarge",
  PAYLOAD_TOO_LARGE: "fileTooLarge",
  MISSING_REQUIRED_FIELDS: "validationError",
  EXTENSION_NOT_ALLOWED: "extensionNotAllowed",
  CONTENT_TYPE_NOT_ALLOWED: "contentTypeNotAllowed",
  INVALID_FORM_DATA: "invalidFormData",
  INVALID_IV_FORMAT: "invalidRequest",
  INVALID_AUTH_TAG_FORMAT: "invalidRequest",
  SLUG_ALREADY_TAKEN: "slugAlreadyTaken",
  ORG_NOT_FOUND: "orgNotFound",
  MEMBER_NOT_FOUND: "memberNotFound",
  ALREADY_A_MEMBER: "alreadyAMember",
  OWNER_ONLY: "ownerOnly",
  CANNOT_CHANGE_OWNER_ROLE: "cannotChangeOwnerRole",
  CANNOT_CHANGE_HIGHER_ROLE: "cannotChangeHigherRole",
  CANNOT_REMOVE_OWNER: "cannotRemoveOwner",
  CANNOT_REMOVE_HIGHER_ROLE: "cannotRemoveHigherRole",
  ONLY_OWN_ENTRIES: "onlyOwnEntries",
  DECRYPT_FAILED: "decryptFailed",
  INVALID_DATE_RANGE: "invalidDateRange",
  TOKEN_REQUIRED: "invalidRequest",
  INVALID_INVITATION: "invalidInvitation",
  INVITATION_ALREADY_USED: "invitationAlreadyUsed",
  INVITATION_EXPIRED: "invitationExpired",
  INVITATION_WRONG_EMAIL: "invitationWrongEmail",
  INVITATION_ALREADY_SENT: "invitationAlreadySent",
  INVITATION_NOT_FOUND: "invitationNotFound",
  ALREADY_REVOKED: "alreadyRevoked",
  INVALID_PREFIX: "invalidRequest",
  UPSTREAM_ERROR: "upstreamError",
  INVALID_CURSOR: "invalidRequest",
  INVALID_BODY: "invalidRequest",
  // EA-only codes — generic fallback in non-EA contexts
  GRANT_NOT_PENDING: "unknownError",
  CANNOT_GRANT_SELF: "unknownError",
  DUPLICATE_GRANT: "unknownError",
  INVALID_STATUS: "unknownError",
  NOT_AUTHORIZED_FOR_GRANT: "unknownError",
  NOT_ACTIVATED: "unknownError",
  KEY_ESCROW_NOT_COMPLETED: "unknownError",
  INCOMPATIBLE_KEY_ALGORITHM: "unknownError",
  EXTENSION_TOKEN_EXPIRED: "extensionTokenExpired",
  EXTENSION_TOKEN_REVOKED: "extensionTokenRevoked",
  EXTENSION_TOKEN_INVALID: "extensionTokenInvalid",
  EXTENSION_TOKEN_SCOPE_INSUFFICIENT: "extensionTokenScopeInsufficient",
  INVALID_RECOVERY_KEY: "invalidRecoveryKey",
  RECOVERY_KEY_NOT_SET: "recoveryKeyNotSet",
  VAULT_RESET_CONFIRMATION_MISMATCH: "vaultResetConfirmationMismatch",
  INVALID_ORIGIN: "invalidOrigin",
} satisfies Record<ApiErrorCode, string>;

/**
 * Translate an error code to an i18n key (ApiErrors namespace).
 *
 * @param overrides - Partial map of code → i18n key. Checked before the
 *   default mapping. Use this when a domain needs a different message for
 *   a specific code (e.g. `{ NOT_FOUND: "shareNotFound" }`).
 */
export function apiErrorToI18nKey(
  error: unknown,
  overrides?: Partial<Record<ApiErrorCode, string>>,
): string {
  if (typeof error === "string") {
    const code = error as ApiErrorCode;
    if (overrides?.[code]) return overrides[code];
    if (error in API_ERROR_I18N) return API_ERROR_I18N[code];
  }
  return "unknownError";
}

// ── Emergency Access i18n mapping (EmergencyAccess namespace) ─────────

/**
 * Maps EA-relevant error codes to i18n keys under the EmergencyAccess namespace.
 * Non-EA codes fall back to "actionFailed".
 *
 * Separate from apiErrorToI18nKey because the target i18n namespace is different
 * ("EmergencyAccess" vs "ApiErrors") and the same codes map to different keys
 * (e.g. UNAUTHORIZED → "actionFailed" instead of "unauthorized").
 */
const EA_I18N: Record<string, string> = {
  UNAUTHORIZED: "actionFailed",
  RATE_LIMIT_EXCEEDED: "rateLimitExceeded",
  INVALID_JSON: "actionFailed",
  VALIDATION_ERROR: "actionFailed",
  NOT_FOUND: "grantNotFound",
  GRANT_NOT_PENDING: "grantNotPending",
  INVITATION_EXPIRED: "invitationExpired",
  INVITATION_ALREADY_USED: "invitationAlreadyUsed",
  INVITATION_WRONG_EMAIL: "notAuthorizedForGrant",
  CANNOT_GRANT_SELF: "cannotAccessOwnGrant",
  DUPLICATE_GRANT: "duplicateGrant",
  INVALID_STATUS: "invalidStatus",
  NOT_AUTHORIZED_FOR_GRANT: "notAuthorizedForGrant",
  NOT_ACTIVATED: "notActivated",
  KEY_ESCROW_NOT_COMPLETED: "keyEscrowNotCompleted",
  INCOMPATIBLE_KEY_ALGORITHM: "actionFailed",
};

/** Translate an error code to an i18n key (EmergencyAccess namespace). */
export function eaErrorToI18nKey(error: unknown): string {
  if (typeof error === "string" && error in EA_I18N) {
    return EA_I18N[error];
  }
  return "actionFailed";
}
