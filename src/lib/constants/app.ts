/**
 * Application display name.
 *
 * Configurable via `NEXT_PUBLIC_APP_NAME` environment variable.
 * Falls back to "passwd-sso" when unset.
 */
export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "passwd-sso";

/**
 * Nil UUID (RFC 4122 §4.1.7).
 *
 * Used as:
 * - userId placeholder for system-initiated audit events (no human actor)
 * - Fallback tenant_id in RLS policy evaluation (avoids PostgreSQL UUID parse errors)
 * - Sentinel for anonymous / non-existent user lookups
 */
export const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Sentinel UUIDs for audit_logs.userId when no real user is associated.
 * Pair with actorType: ANONYMOUS or SYSTEM respectively.
 *
 * These are NOT users.id values — after the audit-path-unification migration,
 * audit_logs.userId has no FK constraint on users.id.
 *
 * Format: UUIDv4 structural (version=4, variant=10xx) so they satisfy
 * PostgreSQL's UUID type and UUID_RE.test(). They are NOT RFC 4122 random
 * UUIDv4 — the random field is zeroed for predictability. A proper uuid(4)
 * generator will never emit these values (collision probability: 2^-122).
 */
export const ANONYMOUS_ACTOR_ID = "00000000-0000-4000-8000-000000000000" as const;
export const SYSTEM_ACTOR_ID = "00000000-0000-4000-8000-000000000001" as const;

/** Set of all sentinel actor IDs, for filter exclusion in human audit log views. */
export const SENTINEL_ACTOR_IDS: ReadonlySet<string> = new Set([
  ANONYMOUS_ACTOR_ID,
  SYSTEM_ACTOR_ID,
]);
