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
// Session policy min/max constants are in common.ts (shared with client).

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

// ─── Session Cache ──────────────────────────────────────────
// SESSION_CACHE_MAX kept until the in-process Map in src/lib/proxy/auth-gate.ts
// is removed by a later batch of the session-cache redesign. Delete then.
export const SESSION_CACHE_MAX = 500;
export const SESSION_CACHE_TTL_MS = 30_000;          // 30 s — positive cache ceiling
export const NEGATIVE_CACHE_TTL_MS = 5_000;          // 5 s — short-TTL negative cache (S-Req-6)
export const TOMBSTONE_TTL_MS = 5_000;               // 5 s — populate-after-invalidate guard
export const SESSION_CACHE_KEY_PREFIX = "sess:cache:";

// ─── Webhook Dispatcher ─────────────────────────────────────
export const WEBHOOK_CONCURRENCY = 5;

// ─── Rate Limit Window ──────────────────────────────────────
export const RATE_WINDOW_MS = 60_000;           // 1 minute

// ─── Tenant ─────────────────────────────────────────────────
export const MAX_TENANT_CLAIM_LENGTH = 255;
export const BOOTSTRAP_SLUG_HASH_LENGTH = 24;

// ─── IP Address ─────────────────────────────────────────────
export const IP_ADDRESS_MAX_LENGTH = 45;        // IPv6 max, matches @db.VarChar(45)

// ─── Directory Sync ─────────────────────────────────────────
export const DIRECTORY_SYNC_MAX_PAGES = 1000;
export const DIRECTORY_SYNC_SANITIZE_MAX_LENGTH = 1_000;
export const DIRECTORY_SYNC_ERROR_PREVIEW = 200;

// ─── SCIM Filter ────────────────────────────────────────────
export const SCIM_FILTER_MAX_LENGTH = 256;

// ─── Rate Limit In-Memory Store ─────────────────────────────
export const RATE_LIMIT_MAP_MAX_SIZE = 10_000;

// ─── Webhook Dispatcher ─────────────────────────────────────
export const WEBHOOK_MAX_RETRIES = 3;

// ─── Folder Depth ───────────────────────────────────────────
export const MAX_FOLDER_DEPTH = 5;

// ─── Recovery Key ───────────────────────────────────────────
export const RECOVERY_KEY_DATA_LENGTH = 52;

// ─── HIBP ───────────────────────────────────────────────────
export const HIBP_PREFIX_LENGTH = 5;            // k-anonymity protocol

// ─── Query Limits (non-validation, readability) ─────────────
export const SHARE_ACCESS_LOG_LIMIT = 50;
export const BREAKGLASS_USER_LIST_LIMIT = 200;
export const VAULT_RESET_HISTORY_LIMIT = 50;
export const TEAM_MEMBER_SEARCH_LIMIT = 10;
export const NOTIFICATION_BELL_LIMIT = 10;
export const PASSKEY_DUMMY_CREDENTIALS_MAX = 3;
export const PASSWORD_HISTORY_SNIPPET_LENGTH = 10;
