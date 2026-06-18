# Plan: retention-append-only-logs (SC7)

## Project context
- Service (Next.js + Prisma 7 + PostgreSQL, multi-tenant RLS, least-privilege roles) + retention-GC worker (engine + SC5/SC4/SC2/SC3 merged/in-flight). SC3 added the generic `PER_TENANT_AGE` kind (plain per-tenant age-based DELETE).

## Objective
Add per-tenant retention to the three append-only log tables #571 deferred (SC7): `share_access_logs`, `directory_sync_logs`, `notifications`. The #571 note said these "need schema cutoff columns" — but verified: ALL THREE already have a timestamp column + `tenant_id` + `id` PK. So SC7 needs NO schema cutoff column; each is a straightforward `PER_TENANT_AGE` entry (the kind SC3 created).

## Background facts (verified)
| Table | timestamp (cutoff) | tenant_id | id PK | RLS |
|-------|--------------------|-----------|-------|-----|
| `share_access_logs` | `created_at` | yes | yes | yes |
| `directory_sync_logs` | `started_at` | yes | yes | yes |
| `notifications` | `created_at` | yes | yes | yes |

## Policy decision (user-confirmed)
- **Per-table individual retention fields** (consistent with prior SCs): add `Tenant.shareAccessLogRetentionDays`, `directorySyncLogRetentionDays`, `notificationRetentionDays` (all `Int?`, NULL = never auto-delete). This lets a tenant tune each independently (notifications short, audit-style logs longer).

## Technical approach
Reuse the SC3 `PER_TENANT_AGE` kind. Widen its `tenantRetentionColumn` type from the literal `"historyRetentionDays"` to a union of all per-tenant-age retention columns. Add 3 registry entries.

### Type change
```
// registry.ts — widen PerTenantAgeEntry.tenantRetentionColumn:
tenantRetentionColumn:
  | "historyRetentionDays"
  | "shareAccessLogRetentionDays"
  | "directorySyncLogRetentionDays"
  | "notificationRetentionDays";
```
sweepPerTenantAge already reads `tenant[entry.tenantRetentionColumn]` and `where: { [entry.tenantRetentionColumn]: { not: null } }` generically — no sweep logic change needed.

## Contracts

### C1 — schema + migration — locked
- Add 3 `Int?` columns to Tenant: `shareAccessLogRetentionDays @map("share_access_log_retention_days")`, `directorySyncLogRetentionDays @map("directory_sync_log_retention_days")`, `notificationRetentionDays @map("notification_retention_days")`. One additive migration (3 ADD COLUMN IF NOT EXISTS). Policy API/UI out of scope (follow-up).

### C2 — registry entries + type widening — locked
- Widen `PerTenantAgeEntry.tenantRetentionColumn` union (C2 type above).
- Add 3 PER_TENANT_AGE entries: share_access_logs/created_at/shareAccessLogRetentionDays; directory_sync_logs/started_at/directorySyncLogRetentionDays; notifications/created_at/notificationRetentionDays.
- The validator's PER_TENANT_AGE branch (from SC3) already assertIdentifier's table+cutoffColumn — covers these. DMMF cross-check (from SC3) already iterates all PER_TENANT_AGE entries — covers these.

### C3 — sweep — locked
- NO change to sweepPerTenantAge (already generic over table/cutoffColumn/tenantRetentionColumn).

### C4 — DB role grant — locked
- Grant `passwd_retention_gc_worker` `SELECT, DELETE` on `share_access_logs`, `directory_sync_logs`, `notifications`. Verify leaf (no inbound FK) — directory_sync_logs may FK TO a sync config (outbound, fine); confirm nothing cascades INTO these. Verify against live DB.

### C5 — audit action — locked
- **Decision: reuse the SC3 `HISTORY_RETENTION_PURGED`? No — these aren't history.** Add a generic `AUDIT_ACTION.LOG_RETENTION_PURGED` (MAINTENANCE group) for append-only-log trims, OR emit per-table with a `table` metadata field under one action. **Decision: one new `LOG_RETENTION_PURGED` action** (const + VALUES + MAINTENANCE group + en/ja + Prisma enum + separate enum migration) — the metadata.table distinguishes which log. Keeps the audit-action set from exploding one-per-table.
- **Sweep emit change**: sweepPerTenantAge currently hardcodes `action: HISTORY_RETENTION_PURGED`. Parameterize the audit action per entry: add an optional `auditAction` field to PerTenantAgeEntry (default HISTORY_RETENTION_PURGED for the SC3 history entries; LOG_RETENTION_PURGED for the SC7 log entries). This is a small, contained change to the existing sweepPerTenantAge.

### C6 — tests — locked
- registry.test: count assertion (+3 PER_TENANT_AGE → now 5 total); the existing DMMF PER_TENANT_AGE block auto-covers the 3 new entries (cutoffColumn varies: created_at/started_at/created_at).
- Unit: extend sweep-per-tenant-age.test.ts to assert the auditAction parameterization (a LOG_RETENTION_PURGED entry emits that action, not HISTORY_RETENTION_PURGED).
- Integration (real DB): one representative (share_access_logs) — old row trimmed, recent kept, NULL-retention skip, role-grant positive+negative. The other two share the identical PER_TENANT_AGE codepath (DMMF + unit cover them).

## Go/No-Go Gate
| ID | Subject | Status |
|----|---------|--------|
| C1 | 3 Tenant retention columns + migration | locked |
| C2 | widen tenantRetentionColumn union + 3 entries | locked |
| C3 | no sweep logic change (generic) | locked |
| C4 | DB role grant (3 tables) | locked |
| C5 | LOG_RETENTION_PURGED action + auditAction parameterization | locked |
| C6 | tests | locked |

## Considerations
- **directory_sync_logs cutoff = started_at** (not created_at — it has no created_at; started_at is the run start). Correct age basis for a sync-run log.
- **notifications**: user-facing, not an audit log — but auto-deleting old read/dismissed notifications past a tenant retention is reasonable cleanup. (The cutoff is created_at regardless of read state; a tenant that wants to keep notifications sets NULL.)
- Out of scope: policy API/UI for the 3 new fields (follow-up); SC6.

## Scope contract
SC6 remains a separate follow-up. Policy API/UI for the 3 retention fields is a documented follow-up.
