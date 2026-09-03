// Server-only constants — do NOT import this file from client components.
// These values are kept separate to avoid leaking server configuration
// into the client bundle.

import { z } from "zod";
import { MS_PER_SECOND, MS_PER_MINUTE } from "@/lib/constants/time";

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
// Session policy min/max constants are in common.ts (shared with client).

// ─── Audit Log ────────────────────────────────────────────────
// AUDIT_LOG_MAX_RANGE_DAYS lives in common.ts (client-shared — rendered in UI).
export const AUDIT_LOG_BATCH_SIZE = 500;
export const AUDIT_LOG_MAX_ROWS = 100_000;
export const METADATA_MAX_BYTES = 10_240;      // 10 KB
// Byte budget for the `reason` string retained inside the `_truncated`
// marker (audit.ts's truncateMetadata). Measured on the SERIALIZED marker
// (JSON.stringify escapes can expand a quote/control character up to
// sixfold), not the raw reason — the smaller of the two is the one that can
// actually be exceeded. Deliberately much narrower than METADATA_MAX_BYTES:
// the marker carries `_truncated`, `_originalSize` and this reason together,
// and all three must still fit under the outer budget.
export const TRUNCATED_REASON_MAX_BYTES = 500;
export const USER_AGENT_MAX_LENGTH = 512;      // matches @db.VarChar(512)
// Matches audit_logs.ip @db.VarChar(45) — the widest an IPv4-mapped IPv6
// address gets WITHOUT a zone id ("0000:…:ffff:255.255.255.255"). A zone id
// pushes past it, so such an address is truncated here rather than fitted; that
// is the column's decision, not this constant's, and the cap exists to make the
// truncation happen where it is visible.
//
// Bounding here rather than trusting the column: an over-length value raises
// 22001 in the outbox worker's insert, and unlike 22P02 that error does not
// echo the value, so the row cycles through max_attempts and the audit event
// behind it is lost silently. The column rejects; this truncates, which keeps
// the event.
//
// Deliberately NOT IP_ADDRESS_MAX_LENGTH below, which is the same number: that
// one bounds an operator-entered CIDR string in the tenant IP-restriction
// policy, where the input is validated as a CIDR and the length is a form
// constraint. This one is a column width on a write path with no validation in
// front of it. Same number today, different concepts — see
// AUDIT_CREDENTIAL_ID_MAX_LENGTH for the same call made once already.
export const AUDIT_IP_MAX_LENGTH = 45;
export const MAX_JSON_BODY_BYTES = 1_048_576;  // 1 MB default stream cap for parseBody
// Bound for WebAuthn credential ids recorded in audit metadata (e.g. the
// step-up reauth mismatch/unavailable events). Deliberately NOT
// USER_AGENT_MAX_LENGTH: that constant is a @db.VarChar(512) column width,
// this is an audit-metadata budget — same number today, different concept,
// and reusing one for the other would make them drift silently.
export const AUDIT_CREDENTIAL_ID_MAX_LENGTH = 512;
// base64url (RFC 4648 §5), no padding. One-or-more: an empty string is not a
// credential id, and `*` would let one through the charset check.
export const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

// PKCE code_challenge (RFC 7636 §4.2): base64url(SHA-256(verifier)), no
// padding — 32 raw bytes encode to exactly 43 chars. 64 is generous headroom
// for a future digest, not a real S256 challenge's length. SSoT for all three
// PKCE ingress points (mcp/authorize GET, mcp/authorize/consent POST,
// mobile/authorize GET), stated against the NARROWER of the two write
// destinations those routes feed — mobile_bridge_codes.code_challenge
// @db.VarChar(64) — so a value this schema accepts always fits it and, a
// fortiori, mcp_authorization_codes.code_challenge @db.VarChar(128).
export const PKCE_CODE_CHALLENGE_SCHEMA = z.string().min(43).max(64).regex(BASE64URL_RE);

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
export const SESSION_CACHE_TTL_MS = 30 * MS_PER_SECOND;          // 30 s — positive cache ceiling
export const NEGATIVE_CACHE_TTL_MS = 5 * MS_PER_SECOND;          // 5 s — short-TTL negative cache (S-Req-6)
// M1 invariant: tombstones MUST outlive any positive cache they need to
// suppress. When TOMBSTONE_TTL_MS < SESSION_CACHE_TTL_MS, a Redis tombstone
// write that lands later than the positive cache expiry (e.g. the tombstone
// hits a Redis blip and is rewritten on retry) creates a window where the
// stale positive entry is served — for up to (SESSION_CACHE_TTL_MS -
// TOMBSTONE_TTL_MS) seconds — even though the DB-side delete committed.
// Keep tombstone TTL >= positive cache TTL so the suppression strictly
// outlasts the data it is suppressing. Enforced by the
// "TOMBSTONE_TTL_MS >= SESSION_CACHE_TTL_MS" test in
// `src/lib/validations/common.server.test.ts` — CI fails if a future edit
// breaks the relationship.
export const TOMBSTONE_TTL_MS = 30 * MS_PER_SECOND;              // 30 s — populate-after-invalidate guard
export const SESSION_CACHE_KEY_PREFIX = "sess:cache:";

// ─── Webhook Dispatcher ─────────────────────────────────────
export const WEBHOOK_CONCURRENCY = 5;

// ─── Rate Limit Window ──────────────────────────────────────
export const RATE_WINDOW_MS = MS_PER_MINUTE;           // 1 minute

// ─── Tenant ─────────────────────────────────────────────────
export const MAX_TENANT_CLAIM_LENGTH = 255;
export const BOOTSTRAP_SLUG_HASH_LENGTH = 24;

// ─── IP Address ─────────────────────────────────────────────
// Form bound on an operator-entered CIDR in the tenant IP-restriction policy.
// Distinct from AUDIT_IP_MAX_LENGTH above despite the shared value — that one
// is a column width on an unvalidated write path. See its note.
export const IP_ADDRESS_MAX_LENGTH = 45;        // IPv6 max, matches @db.VarChar(45)

// Column widths for the two OTHER tables that store a request IP. One constant
// per destination column, deliberately, rather than reusing AUDIT_IP_MAX_LENGTH:
// they are equal today and are three independent schema decisions, so sharing
// one would let a future widening of any single column go unnoticed at the other
// two write paths. Same reasoning as AUDIT_CREDENTIAL_ID_MAX_LENGTH's.
//
// The class these bound: `extractClientIp` performs NO length or format
// validation — `normalizeIp` trims and unwraps brackets and otherwise returns
// its input — so behind a trusted proxy an `X-Forwarded-For` segment reaches
// these columns verbatim.
//
// There is NO gate enumerating the write sites. One was written for this and
// withdrawn — three review rounds put seventeen findings on it, and its own
// self-test could be shown to survive six of seven clause mutations, so it read
// as completeness it did not provide. Until it is rebuilt (CF14), a new write
// to one of these columns is caught by review or not at all: slice it here.
export const SHARE_ACCESS_IP_MAX_LENGTH = 45;   // matches share_access_logs.ip @db.VarChar(45)
export const SESSION_IP_MAX_LENGTH = 45;        // matches sessions.ip_address @db.VarChar(45)

// The 64-wide half of the same class. These three columns were missed on the
// first derivation, which silently collapsed "length-bounded column" to
// "VarChar(45)" — the widths differ, the class does not. The member set below
// is a transcript of prisma/schema.prisma, taken column by column rather than
// from that reading.
export const EXTENSION_BRIDGE_CODE_IP_MAX_LENGTH = 64;      // extension_bridge_codes.ip @db.VarChar(64)
export const MOBILE_BRIDGE_CODE_IP_MAX_LENGTH = 64;         // mobile_bridge_codes.ip @db.VarChar(64)
export const EXTENSION_TOKEN_LAST_USED_IP_MAX_LENGTH = 64;  // extension_tokens.last_used_ip @db.VarChar(64)

// The two bridge-code tables store the user agent beside the IP, in a bounded
// column, and both writers passed it through raw as well. Same class, same
// remedy; kept per-column for the same reason the IP constants are.
// NOT applicable to extension_tokens.last_used_user_agent, which is @db.Text —
// the `512` at those two call sites is a self-imposed budget, not a column
// width, and tying it to a VarChar constant would be the value-equality-is-not-
// meaning-equality mistake AUDIT_CREDENTIAL_ID_MAX_LENGTH already records.
export const EXTENSION_BRIDGE_CODE_USER_AGENT_MAX_LENGTH = 512;  // @db.VarChar(512)
export const MOBILE_BRIDGE_CODE_USER_AGENT_MAX_LENGTH = 512;     // @db.VarChar(512)

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
/** Per-attempt HTTP fetch timeout for webhook delivery. */
export const WEBHOOK_FETCH_TIMEOUT_MS = 10 * MS_PER_SECOND;
/** Backoff between webhook delivery retry attempts (index = attempt just failed). */
export const WEBHOOK_RETRY_DELAYS_MS = [1 * MS_PER_SECOND, 5 * MS_PER_SECOND, 25 * MS_PER_SECOND];
/**
 * How many webhook_deliveries WORK ITEMS the durable delivery worker processes
 * concurrently per batch (distinct from WEBHOOK_CONCURRENCY, which parallelizes
 * the subscribers WITHIN a single work item).
 *
 * Pool interaction: peak connection DEMAND is WEBHOOK_DELIVERY_CONCURRENCY ×
 * WEBHOOK_CONCURRENCY (= 4 × 5 = 20) — each item fans out up to WEBHOOK_CONCURRENCY
 * subscribers in parallel, each opening its own short onSuccess/onFailure
 * transaction — which EXCEEDS the worker pg pool size (max: 5). This is safe, but
 * NOT because demand fits the pool: it is safe because every one of those
 * transactions is a short leaf (no async chain ever holds two connections at
 * once), so excess acquisitions queue briefly and drain, and the slow HTTP fetch
 * holds no connection at all. The lease bound (WEBHOOK_DELIVERY_BATCH_SIZE) is
 * dominated by that connection-less fetch wall-clock, so pool queueing does not
 * push it past the PROCESSING timeout. connectionTimeoutMillis on the pool turns
 * a genuine future hold-and-wait (e.g. a nested transaction added inside a
 * callback, or a raised concurrency constant) into a surfaced error instead of a
 * silent hang — revisit this reasoning if either concurrency constant or the
 * callback transaction shape changes.
 */
export const WEBHOOK_DELIVERY_CONCURRENCY = 4;
/** Consecutive delivery failures after which a webhook is auto-disabled. */
export const WEBHOOK_AUTO_DISABLE_THRESHOLD = 10;

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
export const PASSKEY_DUMMY_CREDENTIALS_MAX = 3;
export const PASSWORD_HISTORY_SNIPPET_LENGTH = 10;
