/**
 * Centralized error codes for ALL API routes (including Emergency Access).
 * Imported by both server (API routes) and client (components).
 *
 * ## Usage rules
 *
 * ### Server side (API routes)
 * - Always return `{ error: API_ERROR.XXX }` — never raw English strings.
 * - For Zod validation failures: `zodValidationError(parsed.error)` from `@/lib/api-response`
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
  ACCESS_DENIED: "ACCESS_DENIED",
  INVALID_JSON: "INVALID_JSON",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  NOT_FOUND: "NOT_FOUND",
  FORBIDDEN: "FORBIDDEN",
  CONFLICT: "CONFLICT",

  // ── Vault ─────────────────────────────────────────────────
  VAULT_ALREADY_SETUP: "VAULT_ALREADY_SETUP",
  VAULT_NOT_SETUP: "VAULT_NOT_SETUP",
  INVALID_PASSPHRASE: "INVALID_PASSPHRASE",
  VERIFIER_NOT_SET: "VERIFIER_NOT_SET",
  USER_NOT_FOUND: "USER_NOT_FOUND",
  ACCOUNT_LOCKED: "ACCOUNT_LOCKED",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  INVALID_RECOVERY_KEY: "INVALID_RECOVERY_KEY",
  RECOVERY_KEY_NOT_SET: "RECOVERY_KEY_NOT_SET",
  VAULT_RESET_CONFIRMATION_MISMATCH: "VAULT_RESET_CONFIRMATION_MISMATCH",
  VAULT_RESET_TOKEN_EXPIRED: "VAULT_RESET_TOKEN_EXPIRED",
  VAULT_RESET_TOKEN_USED: "VAULT_RESET_TOKEN_USED",
  VAULT_RESET_NOT_APPROVED: "VAULT_RESET_NOT_APPROVED",
  RESET_NOT_APPROVABLE: "RESET_NOT_APPROVABLE",
  RESET_TARGET_EMAIL_CHANGED: "RESET_TARGET_EMAIL_CHANGED",
  FORBIDDEN_INSUFFICIENT_ROLE: "FORBIDDEN_INSUFFICIENT_ROLE",
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
  ATTACHMENT_MIGRATION_INCOMPLETE: "ATTACHMENT_MIGRATION_INCOMPLETE",
  LEGACY_MIGRATION_NOT_APPLICABLE: "LEGACY_MIGRATION_NOT_APPLICABLE",
  LEGACY_INTEGRITY_MISMATCH: "LEGACY_INTEGRITY_MISMATCH",
  ATTACHMENT_KEY_MANIFEST_MISMATCH: "ATTACHMENT_KEY_MANIFEST_MISMATCH",
  ATTACHMENT_INCONSISTENT_VERSION: "ATTACHMENT_INCONSISTENT_VERSION",
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  MISSING_REQUIRED_FIELDS: "MISSING_REQUIRED_FIELDS",
  EXTENSION_NOT_ALLOWED: "EXTENSION_NOT_ALLOWED",
  CONTENT_TYPE_NOT_ALLOWED: "CONTENT_TYPE_NOT_ALLOWED",
  INVALID_FORM_DATA: "INVALID_FORM_DATA",
  INVALID_FILENAME: "INVALID_FILENAME",
  INVALID_ENCRYPTION_FORMAT: "INVALID_ENCRYPTION_FORMAT",
  ITEM_KEY_REQUIRED: "ITEM_KEY_REQUIRED",
  ITEM_KEY_VERSION_DOWNGRADE: "ITEM_KEY_VERSION_DOWNGRADE",
  KEY_VERSION_WITHOUT_REENCRYPT: "KEY_VERSION_WITHOUT_REENCRYPT",

  // ── Teams ─────────────────────────────────────────────────
  SLUG_ALREADY_TAKEN: "SLUG_ALREADY_TAKEN",
  TEAM_NOT_FOUND: "TEAM_NOT_FOUND",
  MEMBER_NOT_FOUND: "MEMBER_NOT_FOUND",
  ALREADY_A_MEMBER: "ALREADY_A_MEMBER",
  OWNER_ONLY: "OWNER_ONLY",
  CANNOT_CHANGE_OWNER_ROLE: "CANNOT_CHANGE_OWNER_ROLE",
  CANNOT_CHANGE_HIGHER_ROLE: "CANNOT_CHANGE_HIGHER_ROLE",
  CANNOT_CHANGE_OWN_ROLE: "CANNOT_CHANGE_OWN_ROLE",
  CANNOT_REMOVE_OWNER: "CANNOT_REMOVE_OWNER",
  CANNOT_REMOVE_HIGHER_ROLE: "CANNOT_REMOVE_HIGHER_ROLE",
  KEY_NOT_DISTRIBUTED: "KEY_NOT_DISTRIBUTED",
  KEY_ALREADY_DISTRIBUTED: "KEY_ALREADY_DISTRIBUTED",
  MEMBER_KEY_NOT_FOUND: "MEMBER_KEY_NOT_FOUND",
  VAULT_NOT_READY: "VAULT_NOT_READY",
  TEAM_KEY_VERSION_MISMATCH: "TEAM_KEY_VERSION_MISMATCH",
  ENTRY_COUNT_MISMATCH: "ENTRY_COUNT_MISMATCH",
  ONLY_OWN_ENTRIES: "ONLY_OWN_ENTRIES",
  INVALID_DATE_RANGE: "INVALID_DATE_RANGE",
  // ── Team Invitations ───────────────────────────────────────
  TOKEN_REQUIRED: "TOKEN_REQUIRED",
  INVALID_INVITATION: "INVALID_INVITATION",
  INVITATION_ALREADY_USED: "INVITATION_ALREADY_USED",
  INVITATION_EXPIRED: "INVITATION_EXPIRED",
  INVITATION_WRONG_EMAIL: "INVITATION_WRONG_EMAIL",
  INVITATION_ALREADY_SENT: "INVITATION_ALREADY_SENT",
  INVITATION_NOT_FOUND: "INVITATION_NOT_FOUND",

  // ── Policy ───────────────────────────────────────────────
  SELF_LOCKOUT: "SELF_LOCKOUT",
  PIN_LENGTH_POLICY_NOT_SATISFIED: "PIN_LENGTH_POLICY_NOT_SATISFIED",
  POLICY_SHARING_DISABLED: "POLICY_SHARING_DISABLED",
  POLICY_EXPORT_DISABLED: "POLICY_EXPORT_DISABLED",
  POLICY_SHARE_PASSWORD_REQUIRED: "POLICY_SHARE_PASSWORD_REQUIRED",

  // ── Share Links ───────────────────────────────────────────
  ALREADY_REVOKED: "ALREADY_REVOKED",
  SHARE_PASSWORD_REQUIRED: "SHARE_PASSWORD_REQUIRED",
  SHARE_PASSWORD_INCORRECT: "SHARE_PASSWORD_INCORRECT",
  SHARE_GONE: "SHARE_GONE",

  // ── Send ────────────────────────────────────────────────
  SEND_TEXT_TOO_LARGE: "SEND_TEXT_TOO_LARGE",
  SEND_FILE_TOO_LARGE: "SEND_FILE_TOO_LARGE",
  SEND_FILE_TYPE_NOT_ALLOWED: "SEND_FILE_TYPE_NOT_ALLOWED",
  SEND_STORAGE_LIMIT_EXCEEDED: "SEND_STORAGE_LIMIT_EXCEEDED",

  // ── Watchtower ────────────────────────────────────────────
  INVALID_PREFIX: "INVALID_PREFIX",
  UPSTREAM_ERROR: "UPSTREAM_ERROR",

  // ── Pagination ──────────────────────────────────────────────
  INVALID_CURSOR: "INVALID_CURSOR",

  // ── Audit ─────────────────────────────────────────────────
  INVALID_BODY: "INVALID_BODY",
  AUDIT_CHAIN_SEED_NOT_FOUND: "AUDIT_CHAIN_SEED_NOT_FOUND",

  // ── Emergency Access ──────────────────────────────────────
  GRANT_NOT_PENDING: "GRANT_NOT_PENDING",
  GRANT_REVOKED: "GRANT_REVOKED",
  CANNOT_GRANT_SELF: "CANNOT_GRANT_SELF",
  DUPLICATE_GRANT: "DUPLICATE_GRANT",
  INVALID_STATUS: "INVALID_STATUS",
  NOT_AUTHORIZED_FOR_GRANT: "NOT_AUTHORIZED_FOR_GRANT",
  NOT_ACTIVATED: "NOT_ACTIVATED",
  EMERGENCY_RECOVERY_KEY_MISSING: "EMERGENCY_RECOVERY_KEY_MISSING",
  INCOMPATIBLE_KEY_ALGORITHM: "INCOMPATIBLE_KEY_ALGORITHM",

  // ── Sessions ───────────────────────────────────────────
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  CANNOT_REVOKE_CURRENT_SESSION: "CANNOT_REVOKE_CURRENT_SESSION",

  // ── WebAuthn / Passkey ──────────────────────────────────
  INVALID_CHALLENGE: "INVALID_CHALLENGE",

  // ── Extension Token ─────────────────────────────────────
  EXTENSION_TOKEN_EXPIRED: "EXTENSION_TOKEN_EXPIRED",
  EXTENSION_TOKEN_REVOKED: "EXTENSION_TOKEN_REVOKED",
  EXTENSION_TOKEN_INVALID: "EXTENSION_TOKEN_INVALID",
  EXTENSION_TOKEN_SESSION_EXPIRED: "EXTENSION_TOKEN_SESSION_EXPIRED",
  EXTENSION_TOKEN_SCOPE_INSUFFICIENT: "EXTENSION_TOKEN_SCOPE_INSUFFICIENT",
  EXTENSION_TOKEN_LEGACY_ISSUANCE_DEPRECATED: "EXTENSION_TOKEN_LEGACY_ISSUANCE_DEPRECATED",

  // ── Mobile (iOS) Token ──────────────────────────────────
  MOBILE_BRIDGE_CODE_INVALID: "MOBILE_BRIDGE_CODE_INVALID",
  MOBILE_PKCE_MISMATCH: "MOBILE_PKCE_MISMATCH",
  MOBILE_DEVICE_PUBKEY_MISMATCH: "MOBILE_DEVICE_PUBKEY_MISMATCH",
  MOBILE_TOKEN_BINDING_INVALID: "MOBILE_TOKEN_BINDING_INVALID",
  MOBILE_REFRESH_REUSE_DETECTED: "MOBILE_REFRESH_REUSE_DETECTED",
  MOBILE_REFRESH_TOKEN_REVOKED: "MOBILE_REFRESH_TOKEN_REVOKED",
  MOBILE_REFRESH_SESSION_EXPIRED: "MOBILE_REFRESH_SESSION_EXPIRED",

  // ── SCIM ──────────────────────────────────────────────────
  SCIM_TOKEN_INVALID: "SCIM_TOKEN_INVALID",
  SCIM_TOKEN_EXPIRED: "SCIM_TOKEN_EXPIRED",
  SCIM_TOKEN_REVOKED: "SCIM_TOKEN_REVOKED",
  SCIM_OWNER_PROTECTED: "SCIM_OWNER_PROTECTED",
  SCIM_MANAGED_MEMBER: "SCIM_MANAGED_MEMBER",
  SCIM_FILTER_INVALID: "SCIM_FILTER_INVALID",
  SCIM_UNSUPPORTED_OPERATION: "SCIM_UNSUPPORTED_OPERATION",
  SCIM_RESOURCE_EXISTS: "SCIM_RESOURCE_EXISTS",
  SCIM_TOKEN_LIMIT_EXCEEDED: "SCIM_TOKEN_LIMIT_EXCEEDED",

  // ── API Keys ───────────────────────────────────────────────
  API_KEY_LIMIT_EXCEEDED: "API_KEY_LIMIT_EXCEEDED",
  API_KEY_NOT_FOUND: "API_KEY_NOT_FOUND",
  API_KEY_ALREADY_REVOKED: "API_KEY_ALREADY_REVOKED",
  API_KEY_INVALID: "API_KEY_INVALID",
  API_KEY_SCOPE_INSUFFICIENT: "API_KEY_SCOPE_INSUFFICIENT",

  // ── Operator Tokens ──────────────────────────────────────
  OPERATOR_TOKEN_LIMIT_EXCEEDED: "OPERATOR_TOKEN_LIMIT_EXCEEDED",
  OPERATOR_TOKEN_NOT_FOUND: "OPERATOR_TOKEN_NOT_FOUND",
  OPERATOR_TOKEN_STALE_SESSION: "OPERATOR_TOKEN_STALE_SESSION",

  // ── Service Accounts ──────────────────────────────────────
  SA_LIMIT_EXCEEDED: "SA_LIMIT_EXCEEDED",
  SA_NOT_FOUND: "SA_NOT_FOUND",
  SA_INACTIVE: "SA_INACTIVE",
  SA_NAME_CONFLICT: "SA_NAME_CONFLICT",
  SA_INVALID_SCOPE: "SA_INVALID_SCOPE",
  SA_TOKEN_LIMIT_EXCEEDED: "SA_TOKEN_LIMIT_EXCEEDED",
  SA_TOKEN_NOT_FOUND: "SA_TOKEN_NOT_FOUND",
  SA_TOKEN_ALREADY_REVOKED: "SA_TOKEN_ALREADY_REVOKED",
  SA_ACCESS_REQUEST_EXPIRED: "SA_ACCESS_REQUEST_EXPIRED",

  // ── MCP Clients ──────────────────────────────────────────
  MCP_CLIENT_NAME_CONFLICT: "MCP_CLIENT_NAME_CONFLICT",
  MCP_CLIENT_LIMIT_EXCEEDED: "MCP_CLIENT_LIMIT_EXCEEDED",
  MCP_TOKEN_NOT_FOUND: "MCP_TOKEN_NOT_FOUND",
  MCP_TOKEN_SCOPE_INSUFFICIENT: "MCP_TOKEN_SCOPE_INSUFFICIENT",

  // ── Delegation ──────────────────────────────────────────
  DELEGATION_STORE_FAILED: "DELEGATION_STORE_FAILED",
  DELEGATION_ENTRIES_NOT_FOUND: "DELEGATION_ENTRIES_NOT_FOUND",

  // ── Tenant / Session ────────────────────────────────────
  NO_TENANT: "NO_TENANT",
  INVALID_SESSION: "INVALID_SESSION",
  SESSION_STEP_UP_REQUIRED: "SESSION_STEP_UP_REQUIRED",
  SESSION_INVALIDATE_FAILED: "SESSION_INVALIDATE_FAILED",
  FORBIDDEN_SELF_APPROVAL: "FORBIDDEN_SELF_APPROVAL",
  FORBIDDEN_CROSS_TENANT: "FORBIDDEN_CROSS_TENANT",
  ROTATION_NOT_EXECUTABLE: "ROTATION_NOT_EXECUTABLE",
  ROTATION_TARGET_VERSION_MISMATCH: "ROTATION_TARGET_VERSION_MISMATCH",
  QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
  INTERNAL_ERROR: "INTERNAL_ERROR",

  // ── API / Auth ──────────────────────────────────────────
  INVALID_REQUEST: "INVALID_REQUEST",
  AUTHENTICATION_FAILED: "AUTHENTICATION_FAILED",
  SYNC_FAILED: "SYNC_FAILED",
  KEY_VERSION_NOT_NEWER: "KEY_VERSION_NOT_NEWER",
  BLOB_HASH_MISMATCH: "BLOB_HASH_MISMATCH",
} as const;

export type ApiErrorCode = (typeof API_ERROR)[keyof typeof API_ERROR];

/**
 * Default HTTP status for each error code.
 *
 * `errorResponse(code)` (no status arg) reads from this map. Pass an explicit
 * status to override — needed only for genuine special cases (see exceptions
 * below). The vast majority of callsites should rely on the default.
 *
 * Why this exists: prior to this map, every callsite passed `(code, status)`
 * separately, which (a) duplicated information already implied by the code
 * and (b) allowed code/status mismatches to ship undetected — e.g. v1 API
 * returning `(UNAUTHORIZED, 403)` when 401 is the canonical UNAUTHORIZED
 * status. Centralizing the mapping makes the code → status invariant
 * compiler-enforced via `satisfies Record<ApiErrorCode, number>`.
 *
 * ## Documented exceptions (intentional explicit status)
 *
 * - `INVALID_ORIGIN` defaults to 403 (CSRF rejection). `vault/admin-reset`
 *   passes 500 explicitly because that route refuses Host-header fallback
 *   when APP_URL is unset (see CLAUDE.md "stricter route-level guard").
 *
 * No other production overrides remain. The historical `NOT_FOUND, 410`
 * (share-links race-condition) and `SA_NOT_FOUND, 409` (inactive state)
 * overrides were superseded by dedicated codes `SHARE_GONE` (default 410)
 * and `SA_INACTIVE` (default 409) — wire shape now matches semantic intent.
 *
 * ## Status semantics quick reference
 *
 * - 400 Bad Request: malformed input or violated input invariant
 * - 401 Unauthorized: authentication failure (missing/invalid credentials)
 * - 403 Forbidden: authenticated but lacks permission, or origin/policy denial
 * - 404 Not Found: resource (or precondition resource) does not exist
 * - 409 Conflict: state conflict — already exists, version mismatch, etc.
 * - 410 Gone: resource existed but is now permanently revoked/expired
 * - 413 Payload Too Large: request body exceeds size limit
 * - 422 Unprocessable Entity: tenant-quota / business-rule rejection
 * - 429 Too Many Requests: rate limit exceeded
 * - 500 Internal Server Error: unexpected server failure
 * - 502 Bad Gateway: upstream service returned an error
 * - 503 Service Unavailable: dependency (DB/Redis/upstream) unreachable
 */
export const API_ERROR_STATUS = {
  // ── Common ────────────────────────────────────────────────
  UNAUTHORIZED: 401,
  RATE_LIMIT_EXCEEDED: 429,
  ACCESS_DENIED: 403,
  INVALID_JSON: 400,
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  CONFLICT: 409,

  // ── Vault ─────────────────────────────────────────────────
  VAULT_ALREADY_SETUP: 409,
  VAULT_NOT_SETUP: 404,
  INVALID_PASSPHRASE: 401,
  VERIFIER_NOT_SET: 409,
  USER_NOT_FOUND: 404,
  ACCOUNT_LOCKED: 403,
  SERVICE_UNAVAILABLE: 503,
  INVALID_RECOVERY_KEY: 401,
  RECOVERY_KEY_NOT_SET: 404,
  VAULT_RESET_CONFIRMATION_MISMATCH: 400,
  VAULT_RESET_TOKEN_EXPIRED: 410,
  VAULT_RESET_TOKEN_USED: 410,
  VAULT_RESET_NOT_APPROVED: 409,
  RESET_NOT_APPROVABLE: 409,
  RESET_TARGET_EMAIL_CHANGED: 409,
  FORBIDDEN_INSUFFICIENT_ROLE: 403,
  INVALID_ORIGIN: 403,

  // ── Tags / Folders ────────────────────────────────────────
  TAG_ALREADY_EXISTS: 409,
  FOLDER_ALREADY_EXISTS: 409,
  FOLDER_MAX_DEPTH_EXCEEDED: 400,
  FOLDER_CIRCULAR_REFERENCE: 400,
  FOLDER_NOT_FOUND: 404,

  // ── History ───────────────────────────────────────────────
  HISTORY_NOT_FOUND: 404,

  // ── Passwords / Attachments ───────────────────────────────
  NOT_IN_TRASH: 400,
  ATTACHMENT_NOT_FOUND: 404,
  ATTACHMENT_LIMIT_EXCEEDED: 400,
  ATTACHMENT_MIGRATION_INCOMPLETE: 409,
  LEGACY_MIGRATION_NOT_APPLICABLE: 409,
  LEGACY_INTEGRITY_MISMATCH: 409,
  ATTACHMENT_KEY_MANIFEST_MISMATCH: 409,
  ATTACHMENT_INCONSISTENT_VERSION: 409,
  FILE_TOO_LARGE: 400,
  PAYLOAD_TOO_LARGE: 413,
  MISSING_REQUIRED_FIELDS: 400,
  EXTENSION_NOT_ALLOWED: 400,
  CONTENT_TYPE_NOT_ALLOWED: 400,
  INVALID_FORM_DATA: 400,
  INVALID_FILENAME: 400,
  INVALID_ENCRYPTION_FORMAT: 400,
  ITEM_KEY_REQUIRED: 400,
  ITEM_KEY_VERSION_DOWNGRADE: 409,
  KEY_VERSION_WITHOUT_REENCRYPT: 409,

  // ── Teams ─────────────────────────────────────────────────
  SLUG_ALREADY_TAKEN: 409,
  TEAM_NOT_FOUND: 404,
  MEMBER_NOT_FOUND: 404,
  ALREADY_A_MEMBER: 409,
  OWNER_ONLY: 403,
  CANNOT_CHANGE_OWNER_ROLE: 403,
  CANNOT_CHANGE_HIGHER_ROLE: 403,
  CANNOT_CHANGE_OWN_ROLE: 400,
  CANNOT_REMOVE_OWNER: 403,
  CANNOT_REMOVE_HIGHER_ROLE: 403,
  KEY_NOT_DISTRIBUTED: 403,
  KEY_ALREADY_DISTRIBUTED: 409,
  MEMBER_KEY_NOT_FOUND: 404,
  VAULT_NOT_READY: 409,
  TEAM_KEY_VERSION_MISMATCH: 409,
  ENTRY_COUNT_MISMATCH: 400,
  ONLY_OWN_ENTRIES: 403,
  INVALID_DATE_RANGE: 400,

  // ── Team Invitations ──────────────────────────────────────
  TOKEN_REQUIRED: 400,
  INVALID_INVITATION: 404,
  INVITATION_ALREADY_USED: 410,
  INVITATION_EXPIRED: 410,
  INVITATION_WRONG_EMAIL: 403,
  INVITATION_ALREADY_SENT: 409,
  INVITATION_NOT_FOUND: 404,

  // ── Policy ────────────────────────────────────────────────
  SELF_LOCKOUT: 409,
  PIN_LENGTH_POLICY_NOT_SATISFIED: 400,
  POLICY_SHARING_DISABLED: 403,
  POLICY_EXPORT_DISABLED: 403,
  POLICY_SHARE_PASSWORD_REQUIRED: 403,

  // ── Share Links ───────────────────────────────────────────
  ALREADY_REVOKED: 409,
  SHARE_PASSWORD_REQUIRED: 401,
  SHARE_PASSWORD_INCORRECT: 403,
  SHARE_GONE: 410,

  // ── Send ──────────────────────────────────────────────────
  SEND_TEXT_TOO_LARGE: 400,
  SEND_FILE_TOO_LARGE: 400,
  SEND_FILE_TYPE_NOT_ALLOWED: 400,
  SEND_STORAGE_LIMIT_EXCEEDED: 400,

  // ── Watchtower ────────────────────────────────────────────
  INVALID_PREFIX: 400,
  UPSTREAM_ERROR: 502,

  // ── Pagination ────────────────────────────────────────────
  INVALID_CURSOR: 400,

  // ── Audit ─────────────────────────────────────────────────
  INVALID_BODY: 400,
  AUDIT_CHAIN_SEED_NOT_FOUND: 400,

  // ── Emergency Access ──────────────────────────────────────
  GRANT_NOT_PENDING: 400,
  GRANT_REVOKED: 403,
  CANNOT_GRANT_SELF: 400,
  DUPLICATE_GRANT: 409,
  INVALID_STATUS: 400,
  NOT_AUTHORIZED_FOR_GRANT: 403,
  NOT_ACTIVATED: 403,
  EMERGENCY_RECOVERY_KEY_MISSING: 400,
  INCOMPATIBLE_KEY_ALGORITHM: 400,

  // ── Sessions ──────────────────────────────────────────────
  SESSION_NOT_FOUND: 404,
  CANNOT_REVOKE_CURRENT_SESSION: 400,

  // ── WebAuthn / Passkey ────────────────────────────────────
  INVALID_CHALLENGE: 400,

  // ── Extension Token ───────────────────────────────────────
  EXTENSION_TOKEN_EXPIRED: 401,
  EXTENSION_TOKEN_REVOKED: 401,
  EXTENSION_TOKEN_INVALID: 401,
  EXTENSION_TOKEN_SESSION_EXPIRED: 401,
  EXTENSION_TOKEN_SCOPE_INSUFFICIENT: 403,
  EXTENSION_TOKEN_LEGACY_ISSUANCE_DEPRECATED: 410,

  // ── Mobile (iOS) Token ────────────────────────────────────
  MOBILE_BRIDGE_CODE_INVALID: 400,
  MOBILE_PKCE_MISMATCH: 400,
  MOBILE_DEVICE_PUBKEY_MISMATCH: 400,
  MOBILE_TOKEN_BINDING_INVALID: 401,
  MOBILE_REFRESH_REUSE_DETECTED: 401,
  MOBILE_REFRESH_TOKEN_REVOKED: 401,
  MOBILE_REFRESH_SESSION_EXPIRED: 401,

  // ── SCIM ──────────────────────────────────────────────────
  // SCIM responses use scimError() helper (not errorResponse), so these
  // defaults are never read. Listed here for satisfies completeness only.
  SCIM_TOKEN_INVALID: 401,
  SCIM_TOKEN_EXPIRED: 401,
  SCIM_TOKEN_REVOKED: 401,
  SCIM_OWNER_PROTECTED: 403,
  SCIM_MANAGED_MEMBER: 409,
  SCIM_FILTER_INVALID: 400,
  SCIM_UNSUPPORTED_OPERATION: 400,
  SCIM_RESOURCE_EXISTS: 409,
  SCIM_TOKEN_LIMIT_EXCEEDED: 409,

  // ── API Keys ──────────────────────────────────────────────
  API_KEY_LIMIT_EXCEEDED: 400,
  API_KEY_NOT_FOUND: 404,
  API_KEY_ALREADY_REVOKED: 400,
  API_KEY_INVALID: 401,
  API_KEY_SCOPE_INSUFFICIENT: 403,

  // ── Operator Tokens ───────────────────────────────────────
  OPERATOR_TOKEN_LIMIT_EXCEEDED: 409,
  OPERATOR_TOKEN_NOT_FOUND: 404,
  OPERATOR_TOKEN_STALE_SESSION: 401,

  // ── Service Accounts ──────────────────────────────────────
  SA_LIMIT_EXCEEDED: 409,
  SA_NOT_FOUND: 404,
  SA_INACTIVE: 409,
  SA_NAME_CONFLICT: 409,
  SA_INVALID_SCOPE: 400,
  SA_TOKEN_LIMIT_EXCEEDED: 409,
  SA_TOKEN_NOT_FOUND: 404,
  SA_TOKEN_ALREADY_REVOKED: 409,
  SA_ACCESS_REQUEST_EXPIRED: 410,

  // ── MCP Clients ───────────────────────────────────────────
  // 422 chosen over 409 for tenant-quota rejection; UI consumer at
  // mcp-client-card.tsx:242 explicitly checks `res.status === 422`.
  MCP_CLIENT_NAME_CONFLICT: 409,
  MCP_CLIENT_LIMIT_EXCEEDED: 422,
  MCP_TOKEN_NOT_FOUND: 404,
  MCP_TOKEN_SCOPE_INSUFFICIENT: 403,

  // ── Delegation ────────────────────────────────────────────
  DELEGATION_STORE_FAILED: 503,
  DELEGATION_ENTRIES_NOT_FOUND: 403,

  // ── Tenant / Session ──────────────────────────────────────
  NO_TENANT: 403,
  INVALID_SESSION: 400,
  SESSION_STEP_UP_REQUIRED: 403,
  SESSION_INVALIDATE_FAILED: 500,
  FORBIDDEN_SELF_APPROVAL: 403,
  FORBIDDEN_CROSS_TENANT: 403,
  ROTATION_NOT_EXECUTABLE: 409,
  ROTATION_TARGET_VERSION_MISMATCH: 400,
  QUOTA_EXCEEDED: 403,
  INTERNAL_ERROR: 500,

  // ── API / Auth ────────────────────────────────────────────
  INVALID_REQUEST: 400,
  AUTHENTICATION_FAILED: 401,
  SYNC_FAILED: 500,
  KEY_VERSION_NOT_NEWER: 400,
  BLOB_HASH_MISMATCH: 409,
} as const satisfies Record<ApiErrorCode, number>;

/**
 * Maps every error code to an i18n key under the ApiErrors namespace.
 * `satisfies` ensures compile-time completeness — adding a new code to API_ERROR
 * without updating this map causes a TypeScript error.
 */
const API_ERROR_I18N: Record<ApiErrorCode, string> = {
  UNAUTHORIZED: "unauthorized",
  RATE_LIMIT_EXCEEDED: "rateLimitExceeded",
  ACCESS_DENIED: "accessDenied",
  INVALID_JSON: "invalidRequest",
  VALIDATION_ERROR: "validationError",
  NOT_FOUND: "notFound",
  FORBIDDEN: "forbidden",
  CONFLICT: "conflict",
  VAULT_ALREADY_SETUP: "vaultAlreadySetup",
  VAULT_NOT_SETUP: "vaultNotSetup",
  INVALID_PASSPHRASE: "invalidPassphrase",
  VERIFIER_NOT_SET: "verifierNotSet",
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
  ATTACHMENT_MIGRATION_INCOMPLETE: "attachmentMigrationIncomplete",
  LEGACY_MIGRATION_NOT_APPLICABLE: "legacyMigrationNotApplicable",
  LEGACY_INTEGRITY_MISMATCH: "legacyIntegrityMismatch",
  ATTACHMENT_KEY_MANIFEST_MISMATCH: "attachmentKeyManifestMismatch",
  ATTACHMENT_INCONSISTENT_VERSION: "attachmentInconsistentVersion",
  FILE_TOO_LARGE: "fileTooLarge",
  PAYLOAD_TOO_LARGE: "payloadTooLarge",
  MISSING_REQUIRED_FIELDS: "validationError",
  EXTENSION_NOT_ALLOWED: "extensionNotAllowed",
  CONTENT_TYPE_NOT_ALLOWED: "contentTypeNotAllowed",
  INVALID_FORM_DATA: "invalidFormData",
  INVALID_FILENAME: "invalidFilename",
  INVALID_ENCRYPTION_FORMAT: "invalidEncryptionFormat",
  ITEM_KEY_REQUIRED: "itemKeyRequired",
  ITEM_KEY_VERSION_DOWNGRADE: "itemKeyVersionDowngrade",
  KEY_VERSION_WITHOUT_REENCRYPT: "keyVersionWithoutReencrypt",
  SLUG_ALREADY_TAKEN: "slugAlreadyTaken",
  TEAM_NOT_FOUND: "teamNotFound",
  MEMBER_NOT_FOUND: "memberNotFound",
  ALREADY_A_MEMBER: "alreadyAMember",
  OWNER_ONLY: "ownerOnly",
  CANNOT_CHANGE_OWNER_ROLE: "cannotChangeOwnerRole",
  CANNOT_CHANGE_HIGHER_ROLE: "cannotChangeHigherRole",
  CANNOT_CHANGE_OWN_ROLE: "cannotChangeOwnRole",
  CANNOT_REMOVE_OWNER: "cannotRemoveOwner",
  CANNOT_REMOVE_HIGHER_ROLE: "cannotRemoveHigherRole",
  KEY_NOT_DISTRIBUTED: "keyNotDistributed",
  KEY_ALREADY_DISTRIBUTED: "keyAlreadyDistributed",
  MEMBER_KEY_NOT_FOUND: "memberKeyNotFound",
  VAULT_NOT_READY: "vaultNotReady",
  TEAM_KEY_VERSION_MISMATCH: "teamKeyVersionMismatch",
  ENTRY_COUNT_MISMATCH: "entryCountMismatch",
  ONLY_OWN_ENTRIES: "onlyOwnEntries",
  INVALID_DATE_RANGE: "invalidDateRange",
  TOKEN_REQUIRED: "invalidRequest",
  INVALID_INVITATION: "invalidInvitation",
  INVITATION_ALREADY_USED: "invitationAlreadyUsed",
  INVITATION_EXPIRED: "invitationExpired",
  INVITATION_WRONG_EMAIL: "invitationWrongEmail",
  INVITATION_ALREADY_SENT: "invitationAlreadySent",
  INVITATION_NOT_FOUND: "invitationNotFound",
  SELF_LOCKOUT: "selfLockout",
  PIN_LENGTH_POLICY_NOT_SATISFIED: "pinLengthPolicyNotSatisfied",
  POLICY_SHARING_DISABLED: "policySharingDisabled",
  POLICY_EXPORT_DISABLED: "policyExportDisabled",
  POLICY_SHARE_PASSWORD_REQUIRED: "policySharePasswordRequired",
  ALREADY_REVOKED: "alreadyRevoked",
  SHARE_PASSWORD_REQUIRED: "sharePasswordRequired",
  SHARE_PASSWORD_INCORRECT: "sharePasswordIncorrect",
  SHARE_GONE: "shareGone",
  SEND_TEXT_TOO_LARGE: "sendTextTooLarge",
  SEND_FILE_TOO_LARGE: "sendFileTooLarge",
  SEND_FILE_TYPE_NOT_ALLOWED: "sendFileTypeNotAllowed",
  SEND_STORAGE_LIMIT_EXCEEDED: "sendStorageLimitExceeded",
  INVALID_PREFIX: "invalidRequest",
  UPSTREAM_ERROR: "upstreamError",
  INVALID_CURSOR: "invalidRequest",
  INVALID_BODY: "invalidRequest",
  // EA-only codes — generic fallback in non-EA contexts
  GRANT_NOT_PENDING: "unknownError",
  GRANT_REVOKED: "grantRevoked",
  CANNOT_GRANT_SELF: "unknownError",
  DUPLICATE_GRANT: "unknownError",
  INVALID_STATUS: "unknownError",
  NOT_AUTHORIZED_FOR_GRANT: "unknownError",
  NOT_ACTIVATED: "unknownError",
  EMERGENCY_RECOVERY_KEY_MISSING: "emergencyRecoveryKeyMissing",
  INCOMPATIBLE_KEY_ALGORITHM: "unknownError",
  SESSION_NOT_FOUND: "sessionNotFound",
  CANNOT_REVOKE_CURRENT_SESSION: "cannotRevokeCurrentSession",
  INVALID_CHALLENGE: "invalidChallenge",
  EXTENSION_TOKEN_EXPIRED: "extensionTokenExpired",
  EXTENSION_TOKEN_REVOKED: "extensionTokenRevoked",
  EXTENSION_TOKEN_INVALID: "extensionTokenInvalid",
  EXTENSION_TOKEN_SESSION_EXPIRED: "extensionTokenSessionExpired",
  EXTENSION_TOKEN_SCOPE_INSUFFICIENT: "extensionTokenScopeInsufficient",
  EXTENSION_TOKEN_LEGACY_ISSUANCE_DEPRECATED: "extensionTokenLegacyIssuanceDeprecated",
  // Mobile-specific failure codes — surfaced to native iOS clients only.
  MOBILE_BRIDGE_CODE_INVALID: "unauthorized",
  MOBILE_PKCE_MISMATCH: "unauthorized",
  MOBILE_DEVICE_PUBKEY_MISMATCH: "unauthorized",
  MOBILE_TOKEN_BINDING_INVALID: "mobileTokenBindingInvalid",
  MOBILE_REFRESH_REUSE_DETECTED: "mobileRefreshReuseDetected",
  MOBILE_REFRESH_TOKEN_REVOKED: "unauthorized",
  MOBILE_REFRESH_SESSION_EXPIRED: "mobileRefreshSessionExpired",
  AUDIT_CHAIN_SEED_NOT_FOUND: "auditChainSeedNotFound",
  INVALID_RECOVERY_KEY: "invalidRecoveryKey",
  RECOVERY_KEY_NOT_SET: "recoveryKeyNotSet",
  VAULT_RESET_CONFIRMATION_MISMATCH: "vaultResetConfirmationMismatch",
  VAULT_RESET_TOKEN_EXPIRED: "vaultResetTokenExpired",
  VAULT_RESET_TOKEN_USED: "vaultResetTokenUsed",
  VAULT_RESET_NOT_APPROVED: "vaultResetNotApproved",
  RESET_NOT_APPROVABLE: "resetNotApprovable",
  RESET_TARGET_EMAIL_CHANGED: "resetTargetEmailChanged",
  FORBIDDEN_INSUFFICIENT_ROLE: "forbiddenInsufficientRole",
  INVALID_ORIGIN: "invalidOrigin",
  SCIM_TOKEN_INVALID: "scimTokenInvalid",
  SCIM_TOKEN_EXPIRED: "scimTokenExpired",
  SCIM_TOKEN_REVOKED: "scimTokenRevoked",
  SCIM_OWNER_PROTECTED: "scimOwnerProtected",
  SCIM_MANAGED_MEMBER: "scimManagedMember",
  SCIM_FILTER_INVALID: "scimFilterInvalid",
  SCIM_UNSUPPORTED_OPERATION: "scimUnsupportedOperation",
  SCIM_RESOURCE_EXISTS: "scimResourceExists",
  SCIM_TOKEN_LIMIT_EXCEEDED: "scimTokenLimitExceeded",
  API_KEY_LIMIT_EXCEEDED: "apiKeyLimitExceeded",
  API_KEY_NOT_FOUND: "apiKeyNotFound",
  API_KEY_ALREADY_REVOKED: "apiKeyAlreadyRevoked",
  API_KEY_INVALID: "apiKeyInvalid",
  API_KEY_SCOPE_INSUFFICIENT: "apiKeyScopeInsufficient",
  OPERATOR_TOKEN_LIMIT_EXCEEDED: "operatorTokenLimitExceeded",
  OPERATOR_TOKEN_NOT_FOUND: "operatorTokenNotFound",
  OPERATOR_TOKEN_STALE_SESSION: "operatorTokenStaleSession",
  SA_LIMIT_EXCEEDED: "saLimitExceeded",
  SA_NOT_FOUND: "saNotFound",
  SA_INACTIVE: "saInactive",
  SA_NAME_CONFLICT: "saNameConflict",
  SA_INVALID_SCOPE: "saInvalidScope",
  SA_TOKEN_LIMIT_EXCEEDED: "saTokenLimitExceeded",
  SA_TOKEN_NOT_FOUND: "saTokenNotFound",
  SA_TOKEN_ALREADY_REVOKED: "saTokenAlreadyRevoked",
  SA_ACCESS_REQUEST_EXPIRED: "saAccessRequestExpired",
  MCP_CLIENT_NAME_CONFLICT: "mcpClientNameConflict",
  MCP_CLIENT_LIMIT_EXCEEDED: "mcpClientLimitExceeded",
  MCP_TOKEN_NOT_FOUND: "mcpTokenNotFound",
  MCP_TOKEN_SCOPE_INSUFFICIENT: "mcpTokenScopeInsufficient",
  DELEGATION_STORE_FAILED: "delegationStoreFailed",
  DELEGATION_ENTRIES_NOT_FOUND: "delegationEntriesNotFound",
  NO_TENANT: "noTenant",
  INVALID_SESSION: "invalidSession",
  SESSION_STEP_UP_REQUIRED: "sessionStepUpRequired",
  SESSION_INVALIDATE_FAILED: "sessionInvalidateFailed",
  FORBIDDEN_SELF_APPROVAL: "forbiddenSelfApproval",
  FORBIDDEN_CROSS_TENANT: "forbiddenCrossTenant",
  ROTATION_NOT_EXECUTABLE: "rotationNotExecutable",
  ROTATION_TARGET_VERSION_MISMATCH: "rotationTargetVersionMismatch",
  QUOTA_EXCEEDED: "quotaExceeded",
  INTERNAL_ERROR: "internalError",
  INVALID_REQUEST: "invalidRequest",
  AUTHENTICATION_FAILED: "authenticationFailed",
  SYNC_FAILED: "syncFailed",
  KEY_VERSION_NOT_NEWER: "keyVersionNotNewer",
  BLOB_HASH_MISMATCH: "blobHashMismatch",
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
  GRANT_REVOKED: "grantRevoked",
  INVITATION_EXPIRED: "invitationExpired",
  INVITATION_ALREADY_USED: "invitationAlreadyUsed",
  INVITATION_WRONG_EMAIL: "notAuthorizedForGrant",
  CANNOT_GRANT_SELF: "cannotAccessOwnGrant",
  DUPLICATE_GRANT: "duplicateGrant",
  INVALID_STATUS: "invalidStatus",
  NOT_AUTHORIZED_FOR_GRANT: "notAuthorizedForGrant",
  NOT_ACTIVATED: "notActivated",
  EMERGENCY_RECOVERY_KEY_MISSING: "emergencyRecoveryKeyMissing",
  INCOMPATIBLE_KEY_ALGORITHM: "actionFailed",
};

/** Translate an error code to an i18n key (EmergencyAccess namespace). */
export function eaErrorToI18nKey(error: unknown): string {
  if (typeof error === "string" && error in EA_I18N) {
    return EA_I18N[error];
  }
  return "actionFailed";
}
