# Retention GC Worker

The retention garbage-collection worker physically deletes expired and
past-retention rows across the database. It is a single generic process driven
by a declarative registry — one row per managed table — rather than per-table
bespoke jobs. It generalizes (and absorbed) the former DCR-cleanup worker.

- Worker entry: `scripts/retention-gc-worker.ts`
- Implementation: `src/workers/retention-gc-worker/` (`registry.ts`, `sweep.ts`, `index.ts`, `predicate.ts`)
- Run: `npm run worker:retention-gc` (dev) or the `retention-gc-worker` Docker service
- Full design rationale / inclusion-exclusion notes: `docs/archive/review/retention-gc-worker-plan.md`

## Why a single generic worker

The 18 managed tables do not need bespoke deletion logic — they differ only in
the table name, the cutoff column, and the SELECT predicate. So each is a
**declarative registry entry**, and the worker dispatches on the entry `kind`.
Adding a table is a registry row, not new code.

## Entry kinds

| Kind | Deletes when | Audit | Notes |
|------|-------------|-------|-------|
| `EXPIRY` | `cutoffColumn < now()` | none | Pure ephemeral rows (sessions, bridge/authorization codes, unclaimed DCR clients). |
| `EXPIRY_GUARDED` | expired **and** a "no live dependents" guard holds | none | Guard is a fixed SQL fragment keyed by a closed `GuardName` enum (e.g. `MCP_TOKEN_FAMILY_DEAD`). |
| `EXPIRY_AUDIT_PROVENANCE` | expired (optionally also guard) | **per-row provenance → audit, then delete, atomically** | For rows that carry forensic value (credentials, security records, grants). Captures provenance, emits the entry's `auditAction`, then deletes — in one transaction. An optional status-aware `guard` prevents deleting still-live rows (e.g. `EMERGENCY_GRANT_DEAD` keeps an ACCEPTED grant whose invite window has passed). |
| `PER_TENANT_FN` | per-tenant age via a `SECURITY DEFINER` function | function-emitted | `audit_logs` only — deletion goes through a privileged function so the worker role never holds direct DELETE on `audit_logs`. ≥30-day floor enforced. |
| `PER_TENANT_TRASH` | soft-deleted longer than the tenant's `trashRetentionDays` | `TRASH_RETENTION_PURGED` | `password_entries` / `team_password_entries`; the worker also deletes the external attachment blobs (best-effort, post-commit). |
| `PER_TENANT_AGE` | `cutoffColumn` older than the tenant's retention column | `HISTORY_*` / `LOG_RETENTION_PURGED` | Plain per-tenant age delete (history, share-access / directory-sync logs, notifications). |

## Per-tenant retention

Six nullable `Tenant` columns let an admin opt into automatic cleanup.
**`NULL` = never auto-delete** — the worker enumerates only tenants
`WHERE <column> IS NOT NULL`. Configured in the tenant policy API
(`/api/tenant/policy` GET/PATCH) and the retention settings card.

| Column | Governs | Floor |
|--------|---------|-------|
| `auditLogRetentionDays` | `audit_logs` (via the SECURITY DEFINER function) | ≥ 30 days (forensic) |
| `trashRetentionDays` | soft-deleted vault entries (personal + team) + attachment blobs | 1 day |
| `historyRetentionDays` | password-entry history (personal + team) | 1 day |
| `shareAccessLogRetentionDays` | `share_access_logs` | 1 day |
| `directorySyncLogRetentionDays` | `directory_sync_logs` (age basis: `started_at`) | 1 day |
| `notificationRetentionDays` | `notifications` | 1 day |

Bounds for the five non-audit columns: `RETENTION_DAYS_MIN=1` /
`RETENTION_DAYS_MAX=10*DAYS_PER_YEAR` (`src/lib/validations/common.ts`). The
audit-log floor of 30 days is its own stricter constant.

## Least privilege & RLS

The worker connects as **`passwd_retention_gc_worker`** (NOSUPERUSER,
NOBYPASSRLS), granted only the SELECT/DELETE it needs per table — never direct
DELETE on `audit_logs` (that goes through the SECURITY DEFINER function).

Because the role is NOBYPASSRLS, deleting across all tenants on an RLS-enabled
table requires setting `app.bypass_rls = on` in-transaction. Every RLS-enabled
registry entry must therefore declare **`globalDelete: true`**; the worker
boot-validates this (an RLS-enabled entry missing `globalDelete`, and not in
`RLS_FREE_EXPIRY_TABLES`, throws at startup) so a silent "0 rows deleted" cannot
slip through. `ON DELETE CASCADE` runs internally under the table owner, so the
role needs no DELETE grant on cascade children.

## SQL-injection containment (S1)

Registry-supplied identifiers (table, cutoff column, key/provenance columns) are
allowlist-validated against `^[a-z_]+$` via `assertIdentifier` before
interpolation. Predicates are structured (`PredicateClause[]`), not free-form
SQL. Guard fragments are compile-time literals keyed by the closed `GuardName`
enum — never registry data. Only `batchSize` and id lists are bound as
parameters.

## Operation

| Env var | Purpose | Default |
|---------|---------|---------|
| `RETENTION_GC_DATABASE_URL` | DB URL for the `passwd_retention_gc_worker` role (falls back to `DATABASE_URL`) | — |
| `RETENTION_GC_INTERVAL_MS` | sweep loop interval | (see `env-schema.ts`) |
| `RETENTION_GC_BATCH_SIZE` | rows per delete batch (1–10000) | 1000 |
| `RETENTION_GC_EMIT_HEARTBEAT_AUDIT` | emit a `RETENTION_GC_SWEEP` heartbeat audit event each cycle | — |

For Docker, set `PASSWD_RETENTION_GC_WORKER_PASSWORD` (initdb wires it on first
boot); for existing clusters rotate with
`scripts/set-retention-gc-worker-password.sh`. Without the worker running,
expired/past-retention rows simply accumulate — the app keeps functioning.
