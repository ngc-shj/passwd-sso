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
 * Note: previously this constant was documented as the audit `userId`
 * placeholder; that guidance was superseded in 2026-04 by
 * `ANONYMOUS_ACTOR_ID` / `SYSTEM_ACTOR_ID` (defined below). After the
 * 2026-04 cleanup there are no remaining audit-userId call sites for
 * `NIL_UUID`.
 *
 * Used as:
 * - **Primary**: RLS-bypass sentinel for the `app.tenant_id` GUC inside
 *   transactions that need to write across tenant boundaries (audit
 *   outbox, worker meta-events, integration test helpers). See
 *   `src/lib/audit-outbox.ts`, `src/lib/tenant-rls.ts`,
 *   `src/workers/audit-outbox-worker.ts`.
 * - **Secondary**: Timing-balanced no-match WHERE filter for
 *   anti-enumeration database probes (e.g., the dummy passkey lookup in
 *   `src/app/api/auth/passkey/options/email/route.ts`). The all-zero
 *   structural UUID guarantees no row matches while preserving the
 *   query's wall-clock cost. This relies on the invariant that
 *   `users.id` is generated via `gen_random_uuid()` (UUIDv4) and
 *   therefore can never equal `NIL_UUID` — structural impossibility,
 *   since UUIDv4 forces version nibble `4` and variant bits `10`, while
 *   `NIL_UUID` has both set to zero. The guarantee carries through
 *   `webAuthnCredential.userId` (and any other table) via the FK
 *   constraint to `users.id`.
 *
 * MUST NOT be used as an audit `userId` placeholder. Use
 * `ANONYMOUS_ACTOR_ID` / `SYSTEM_ACTOR_ID` (defined below) — those are
 * valid UUIDv4-structural sentinels and are listed in
 * `SENTINEL_ACTOR_IDS` for filter exclusion in human audit-log views.
 *
 * TODO(actorId-rename): rename audit_logs.userId column to actor_id
 * (and corresponding TS field). Tracked separately — out of scope for
 * the 2026-04 cleanup PR.
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

/**
 * Resolve an optional userId to a concrete string for audit logging.
 * - Pass `"anonymous"` for unauthenticated-actor events (share access, etc.)
 * - Pass `"system"` for worker/service-initiated events
 */
export function resolveAuditUserId(
  userId: string | null | undefined,
  fallback: "anonymous" | "system",
): string {
  if (userId) return userId;
  return fallback === "anonymous" ? ANONYMOUS_ACTOR_ID : SYSTEM_ACTOR_ID;
}
