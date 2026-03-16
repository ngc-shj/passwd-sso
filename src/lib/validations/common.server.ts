// Server-only constants — do NOT import this file from client components.
// These values are kept separate to avoid leaking server configuration
// into the client bundle.

// ─── KDF Parameters ──────────────────────────────────────────
export const KDF_PBKDF2_ITERATIONS_MIN = 600_000;
export const KDF_PBKDF2_ITERATIONS_MAX = 10_000_000;
export const KDF_ARGON2_ITERATIONS_MIN = 1;
export const KDF_ARGON2_ITERATIONS_MAX = 100;
export const KDF_ARGON2_MEMORY_MIN = 16_384;       // 16 MiB in KiB
export const KDF_ARGON2_MEMORY_MAX = 4_194_304;    // 4 GiB in KiB
export const KDF_ARGON2_PARALLELISM_MIN = 1;
export const KDF_ARGON2_PARALLELISM_MAX = 16;

// ─── Session & Auth ───────────────────────────────────────────
export const PASSKEY_SESSION_MAX_AGE_SECONDS = 28_800; // 8 hours
export const MAX_CONCURRENT_SESSIONS_MIN = 1;
export const MAX_CONCURRENT_SESSIONS_MAX = 100;
export const SESSION_IDLE_TIMEOUT_MIN = 1;
export const SESSION_IDLE_TIMEOUT_MAX = 1440;          // 24 hours in minutes
export const VAULT_AUTO_LOCK_MIN = 1;
export const VAULT_AUTO_LOCK_MAX = 1440;

// ─── Audit Log ────────────────────────────────────────────────
export const AUDIT_LOG_MAX_RANGE_DAYS = 90;
export const AUDIT_LOG_BATCH_SIZE = 500;
export const AUDIT_LOG_MAX_ROWS = 100_000;
export const METADATA_MAX_BYTES = 10_240;      // 10 KB
export const USER_AGENT_MAX_LENGTH = 512;      // matches @db.VarChar(512)

// ─── Rate Limits ─────────────────────────────────────────────
export const CSP_REPORT_RATE_MAX = 60;
export const HIBP_RATE_MAX = 30;

// ─── Watchtower ───────────────────────────────────────────────
export const BREACH_COUNT_MAX = 10_000;

// ─── Admin ────────────────────────────────────────────────────
export const MASTER_KEY_VERSION_MIN = 1;
export const MASTER_KEY_VERSION_MAX = 100;

// ─── Vault Reset ─────────────────────────────────────────────
export const MAX_PENDING_RESETS = 3;

// ─── Pagination ───────────────────────────────────────────────
export const HISTORY_PAGE_SIZE = 20;
export const NOTIFICATION_PAGE_MIN = 1;
export const NOTIFICATION_PAGE_DEFAULT = 20;
export const NOTIFICATION_PAGE_MAX = 50;

// ─── SCIM Pagination ─────────────────────────────────────────
export const SCIM_PAGE_COUNT_MIN = 1;
export const SCIM_PAGE_COUNT_MAX = 200;
export const SCIM_PAGE_COUNT_DEFAULT = 100;
