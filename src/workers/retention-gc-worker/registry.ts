/**
 * Declarative retention-GC registry.
 *
 * Each entry describes one table's GC rule. Adding a new table = one new registry
 * row. No per-table bespoke logic; the engine in sweep.ts drives all entries.
 *
 * Two entry kinds:
 *   EXPIRY        — batch-bounded key-driven DELETE WHERE cutoff < now()
 *   PER_TENANT_FN — per-tenant retention via a SECURITY DEFINER function
 */

import type { PredicateClause } from "./predicate";

export type RetentionEntryKind = "EXPIRY" | "EXPIRY_GUARDED" | "PER_TENANT_FN";

/**
 * Closed set of "no live dependents" guards. Each maps to a fixed SQL fragment
 * defined in sweep.ts (GUARD_SQL) — NOT registry data — so the guard's
 * NOT EXISTS subqueries stay compile-time literals and never widen the S1
 * SQL-injection containment boundary.
 */
export type GuardName = "MCP_TOKEN_FAMILY_DEAD";

export interface ExpiryEntry {
  kind: "EXPIRY";
  /** Physical table name (^[a-z_]+$, i.e. @@map value from schema.prisma). */
  table: string;
  /** Column compared to now() for expiry (^[a-z_]+$). */
  cutoffColumn: string;
  /**
   * Columns forming the row identity for batch-bounded delete.
   * ["id"] for id-keyed tables; ["identifier","token"] for verification_tokens
   * (composite PK, no id column).
   */
  keyColumns: string[];
  /** Optional structured AND-joined filter applied to both the SELECT subquery and
   * the LIMIT clause. Never a raw SQL string (S1). */
  predicate?: PredicateClause[];
  /**
   * Required `true` for every RLS-enabled table.
   *
   * The retention worker runs as a NOBYPASSRLS role with no app.tenant_id set.
   * Without bypass_rls, the existing RLS policies cast '' to uuid which throws
   * "invalid input syntax for type uuid" → the DELETE errors and 0 rows are ever
   * deleted. Setting this flag explicitly acknowledges the deliberate all-tenant
   * blast radius (S2/S10): the worker intentionally deletes expired rows across
   * ALL tenants — that is the correct behaviour for a background GC sweep.
   *
   * Omit ONLY for tables with no RLS and no tenant_id column (currently only
   * verification_tokens). The boot validator enforces this.
   */
  globalDelete?: true;
}

export interface PerTenantFnEntry {
  kind: "PER_TENANT_FN";
  /** Fixed to "audit_logs" — the only PER_TENANT_FN table currently registered. */
  table: "audit_logs";
  /** SECURITY DEFINER function that performs the actual DELETE. */
  fn: "audit_log_purge";
  /** Prisma model field name holding per-tenant retention days (null = skip tenant). */
  tenantRetentionColumn: "auditLogRetentionDays";
}

/**
 * An EXPIRY delete gated by a code-defined "no live dependents" guard.
 *
 * Used for parent tables with ON DELETE CASCADE to live dependents, where a
 * naive expiry delete would destroy still-valid children (e.g. deleting a
 * 1h-expired mcp_access_tokens row would cascade-destroy a live 7d refresh
 * token). The guard's NOT EXISTS subqueries (resolved from GuardName in
 * sweep.ts) hold the delete until the whole family is expendable; the FK
 * CASCADE then removes the dead children.
 */
export interface GuardedExpiryEntry {
  kind: "EXPIRY_GUARDED";
  table: string;
  cutoffColumn: string;
  keyColumns: string[];
  /** Closed enum selecting a fixed guard SQL fragment in sweep.ts — never raw SQL (S1). */
  guard: GuardName;
  globalDelete?: true;
}

export type RetentionEntry =
  | ExpiryEntry
  | GuardedExpiryEntry
  | PerTenantFnEntry;

/**
 * EXPIRY tables that are intentionally RLS-free (no RLS policy, no tenant_id),
 * and therefore legitimately omit `globalDelete`. This is the single source of
 * truth for the boot validator's exception list — keep it co-located with the
 * registry so the "which tables may skip globalDelete" fact cannot drift away
 * from the registry rows it governs.
 *
 * Adding a table here without a corresponding RLS-free schema is the failure
 * mode S14 tracks (derive from pg_policies as the eventual ground-truth check).
 */
export const RLS_FREE_EXPIRY_TABLES: ReadonlySet<string> = new Set([
  "verification_tokens",
]);

/**
 * The retention-GC registry — one row per managed table.
 *
 * Scope: only tables that are (a) key-targetable, (b) free of ON DELETE CASCADE
 * to live dependents, and (c) provenance-free OR independently captured in
 * audit_logs. See docs/archive/review/retention-gc-worker-plan.md §Registry for
 * the full inclusion/exclusion rationale.
 *
 * Table names are physical @@map names from schema.prisma.
 */
export const RETENTION_REGISTRY: readonly RetentionEntry[] = [
  {
    // DCR (Dynamic Client Registration) MCP clients — unclaimed registrations
    // expire automatically; is_dcr=true + tenant_id IS NULL identifies them.
    // globalDelete: true — mcp_clients is RLS-enabled (tenant-scoped policy).
    // Absorbs the former dcr-cleanup-worker (FR5).
    kind: "EXPIRY",
    table: "mcp_clients",
    cutoffColumn: "dcr_expires_at",
    keyColumns: ["id"],
    predicate: [
      { column: "is_dcr", op: "=", value: true },
      { column: "tenant_id", op: "IS NULL" },
    ],
    globalDelete: true,
  },
  {
    // Auth.js sessions — expires column; no longer needed once past expiry.
    // globalDelete: true — sessions is RLS-enabled (tenant-scoped policy).
    kind: "EXPIRY",
    table: "sessions",
    cutoffColumn: "expires",
    keyColumns: ["id"],
    globalDelete: true,
  },
  {
    // Auth.js verification tokens (email magic-link / passkey challenge).
    // Composite primary key (identifier, token) — no id column.
    // globalDelete NOT set — this table has no RLS policy and no tenant_id column;
    // bypass_rls is not needed and would be a no-op. This is the sole RLS-free
    // EXPIRY table in the registry (boot validator enforces the exception).
    kind: "EXPIRY",
    table: "verification_tokens",
    cutoffColumn: "expires",
    keyColumns: ["identifier", "token"],
    // globalDelete intentionally omitted — no RLS, no tenant_id.
  },
  {
    // Browser extension bridge codes — single-use, short-lived.
    // globalDelete: true — extension_bridge_codes is RLS-enabled.
    kind: "EXPIRY",
    table: "extension_bridge_codes",
    cutoffColumn: "expires_at",
    keyColumns: ["id"],
    globalDelete: true,
  },
  {
    // Mobile app bridge codes — single-use, short-lived.
    // globalDelete: true — mobile_bridge_codes is RLS-enabled.
    kind: "EXPIRY",
    table: "mobile_bridge_codes",
    cutoffColumn: "expires_at",
    keyColumns: ["id"],
    globalDelete: true,
  },
  {
    // MCP OAuth 2.1 authorization codes — consumed at exchange, expire quickly.
    // globalDelete: true — mcp_authorization_codes is RLS-enabled.
    kind: "EXPIRY",
    table: "mcp_authorization_codes",
    cutoffColumn: "expires_at",
    keyColumns: ["id"],
    globalDelete: true,
  },
  {
    // MCP OAuth access tokens (1h TTL) — parent of the rotation family.
    // ON DELETE CASCADE to mcp_refresh_tokens (7d) + delegation_sessions; a naive
    // expiry delete would destroy still-valid children (SC5). The MCP_TOKEN_FAMILY_DEAD
    // guard holds the delete until no live refresh token or delegation session
    // references this access token; the cascade then removes the dead children.
    // globalDelete: true — mcp_access_tokens is RLS-enabled.
    kind: "EXPIRY_GUARDED",
    table: "mcp_access_tokens",
    cutoffColumn: "expires_at",
    keyColumns: ["id"],
    guard: "MCP_TOKEN_FAMILY_DEAD",
    globalDelete: true,
  },
  {
    // Per-tenant audit log retention via the SECURITY DEFINER function.
    // NULL auditLogRetentionDays → tenant skipped (no implicit deletion).
    // Clamped to max(retention, AUDIT_LOG_RETENTION_MIN) in sweep.ts (S4 floor).
    kind: "PER_TENANT_FN",
    table: "audit_logs",
    fn: "audit_log_purge",
    tenantRetentionColumn: "auditLogRetentionDays",
  },
] as const;
