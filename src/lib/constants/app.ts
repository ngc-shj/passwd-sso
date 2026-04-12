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
