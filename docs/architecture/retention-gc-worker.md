# Retention GC Worker

The retention garbage-collection worker physically deletes expired and
past-retention rows across the database. It is a single generic process driven
by a declarative registry — one row per managed table — rather than per-table
bespoke jobs. It generalizes (and absorbed) the former DCR-cleanup worker.

- Worker entry: `scripts/retention-gc-worker.ts`
- Implementation: `src/workers/retention-gc-worker/` (`registry.ts`, `sweep.ts`, `index.ts`, `predicate.ts`, `sweep-blob-orphans.ts`, `options.ts`)
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

## Dedicated sweeps (outside the registry)

Two sweeps run after the registry loop on every tick, each in its own
try/catch, each **off by default**. Their counts appear in the heartbeat's
`perTable` under a fixed key; a failure or refusal records `-1` there and an
`retention-gc.entry_failed` / `retention-gc.blob_sweep_refused` log line.

| Key | Enable | Deletes | Audit |
|-----|--------|---------|-------|
| `team_member_keys` (rows) | `RETENTION_GC_TEAM_KEY_PRUNE_ENABLED=true` | old `TeamMemberKey` versions no entry, history row or mode-0 attachment of the team references, never the current version | `TEAM_MEMBER_KEY_PRUNED`, one per team |
| `attachment_objects` (objects) | `RETENTION_GC_BLOB_SWEEP_MODE=report\|delete` | external attachment objects no row references, past the grace period | none (counts are logged) |

**Team key prune** (`sweepTeamMemberKeys`): calls the SECURITY DEFINER
function `team_member_key_prune(p_batch)`, whose single statement decides and
deletes (one snapshot), bounded to `RETENTION_GC_BATCH_SIZE` (team, version)
pairs per tick. The worker role holds EXECUTE on it and no table grant; the
function refuses outside the RLS bypass, and while enforcement (`#921`) is off a
bypass whose grant omits `team_member_keys` is reported rather than refused.
Grant: `BYPASS_GRANT.RETENTION_TEAM_KEY_PRUNE`. Policy and the concurrency
argument: `docs/security/key-retention-policy.md` §1.

**Orphan-blob sweep** (`sweepOrphanBlobs`): only with an external
`BLOB_BACKEND`; the worker must receive the same `BLOB_*` values as the app
(the trash purge depends on that too). Per tick it lists up to
`RETENTION_GC_BLOB_SWEEP_MAX_OBJECTS` keys under the current prefix (pages of
1000, no transaction open), reads the matching `attachments` rows in a short
bypass transaction (`BYPASS_GRANT.RETENTION_BLOB_ORPHAN_SWEEP`), decides on the
tick's cumulative counts, then deletes outside any transaction. The listing
cursor lives in the process (`createWorker`) and resets when a pass completes,
on a listing error and on restart. Safety rails — the operator-created
deployment marker, the grace period, the breaker, `report` mode — and the
database-restore rule are in `docs/security/key-retention-policy.md` §4.

Create the marker once per bucket, from the owning deployment:

```bash
RETENTION_GC_BLOB_SWEEP_MODE=report DEPLOYMENT_ID=<uuid> BLOB_BACKEND=s3 ... \
  node dist/retention-gc-worker.js --init-blob-marker   # prints created | exists
```

It refuses (exit 1, nothing written) when the mode is `off`, `DEPLOYMENT_ID` is
missing or the backend is `db`. Where the worker's identity has no write access
to the bucket, run it with operator credentials.

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
| `RETENTION_GC_TEAM_KEY_PRUNE_ENABLED` | run the irreversible team key prune | `false` |
| `RETENTION_GC_BLOB_SWEEP_MODE` | orphan-blob sweep: `off` / `report` / `delete` (not `off` requires `DEPLOYMENT_ID`) | `off` |
| `RETENTION_GC_BLOB_ORPHAN_GRACE_MS` | minimum age of a deleted object (1 h – 35 days); **required** in `delete` mode, ≥ the DB backup / PITR window | 1 day in `report` mode |
| `RETENTION_GC_BLOB_SWEEP_MAX_OBJECTS` | keys listed per tick (100 – 1 000 000) | 10000 |
| `RETENTION_GC_BLOB_SWEEP_MAX_DELETES` | breaker: most deletions per tick (1 – 100 000) | 1000 |
| `RETENTION_GC_BLOB_SWEEP_MAX_DELETE_RATIO` | breaker: most unreferenced share of a tick's old objects above 20, (0, 1] | 0.5 |

For Docker, set `PASSWD_RETENTION_GC_WORKER_PASSWORD` (initdb wires it on first
boot); for existing clusters rotate with
`scripts/set-retention-gc-worker-password.sh`. Without the worker running,
expired/past-retention rows simply accumulate — the app keeps functioning.
