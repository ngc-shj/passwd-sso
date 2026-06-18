# Plan: retention-history-trim (SC3)

## Project context
- Service (Next.js + Prisma 7 + PostgreSQL, multi-tenant RLS, least-privilege roles) + retention-GC worker (engine + SC5/SC4/SC2 merged or in-flight).
- Test infra: unit + integration (real-DB) + CI.

## Objective
Auto-trim old password-entry history rows past a tenant-configured retention — `password_entry_histories` and `team_password_entry_histories` (column `changed_at`) — which #571 deferred (SC3). History accumulates as live entries are edited; the existing manual `purge-history` route is age-based per-tenant (`changed_at < now() - retentionDays`, default 90) but requires an operator to invoke it. This adds automatic per-tenant trimming.

(History of a *deleted* entry is already removed by the FK cascade — `*_histories.entry_id → entry ON DELETE CASCADE` — so SC2's trash purge handles that. SC3 trims history of LIVE entries.)

## Background facts (verified)
- `password_entry_histories.changed_at` / `team_password_entry_histories.changed_at` — the age column. Both have `tenant_id`, RLS-enabled, indexed `@@index([entryId, changedAt])` + `@@index([tenantId])`.
- Existing manual `purge-history` route: `changedAt < now() - retentionDays days`, scoped to the operator's tenant, default 90, min 1 max 3650 (src/app/api/maintenance/purge-history/route.ts).
- This is the SAME age-based per-tenant shape as `audit_logs` (PER_TENANT_FN), but history needs NO SECURITY DEFINER function — a plain DELETE suffices (history is not immutable like audit_logs).

## Policy decision
- **Tenant-configurable retention** (consistent with SC2 trashRetentionDays / audit auditLogRetentionDays): add `Tenant.historyRetentionDays Int?` (NULL = never auto-trim). Cutoff: `changed_at < now() - historyRetentionDays days`.

## Technical approach
Add a generic registry kind **`PER_TENANT_AGE`**: deletes rows older than a per-tenant retention, parameterized by `table` + `cutoffColumn` + `tenantRetentionColumn`. Unlike PER_TENANT_FN (audit_logs, which routes through a definer fn for immutability), PER_TENANT_AGE does a plain batch-bounded DELETE. Two entries (one per history table).

### Registry entry
```
interface PerTenantAgeEntry {
  kind: "PER_TENANT_AGE";
  table: string;                 // ^[a-z_]+$
  cutoffColumn: string;          // ^[a-z_]+$, e.g. "changed_at"
  tenantRetentionColumn: "historyRetentionDays";
}
```

## Contracts

### C1 — schema + migration — locked
- Add `Tenant.historyRetentionDays Int? @map("history_retention_days")` (mirror auditLogRetentionDays/trashRetentionDays). Additive nullable migration. Policy API/UI out of scope (follow-up).

### C2 — registry kind + entries + validator — locked
- Extend `RetentionEntryKind` with `"PER_TENANT_AGE"`; add `PerTenantAgeEntry`; add 2 entries (password_entry_histories, team_password_entry_histories with cutoffColumn "changed_at").
- **Validator (review F4 — MUST NOT FORGET)**: add an explicit `else if (entry.kind === "PER_TENANT_AGE")` branch to `validateRegistry` in index.ts running `assertIdentifier(entry.table)` + `assertIdentifier(entry.cutoffColumn)`. Without this branch the entry is silently skipped (no boot-time S1 check). No globalDelete field (the sweeper sets bypass_rls).
- **DMMF cross-check (review F1 — MUST NOT FORGET)**: the registry.test.ts DMMF loop currently only processes EXPIRY/EXPIRY_GUARDED/EXPIRY_AUDIT_PROVENANCE/PER_TENANT_TRASH — add a `PER_TENANT_AGE` block asserting table + cutoffColumn (changed_at) + tenant_id resolve to real physical columns. Update the registry count assertion (+2 PER_TENANT_AGE) (review F2).

### C3 — sweepPerTenantAge — locked
- `sweepPerTenantAge(tx, entry, batchSize): Promise<number>` (takes a `tx`, dispatched via workerPrisma.$transaction like sweepAuditLogs):
  - bypass_rls set first.
  - Enumerate tenants with `<tenantRetentionColumn> NOT NULL` (one query: `tenant.findMany`).
  - Per tenant: cutoff = now() - retention days; batch-bounded DELETE: `DELETE FROM <table> WHERE (id) IN (SELECT id FROM <table> WHERE tenant_id = $tenant AND <cutoffColumn> < $cutoff LIMIT $batch)`. (Both history tables have an `id` PK — verify.)
  - Sum deleted across tenants. Return total.
- Identifiers (table/cutoffColumn) allowlist-validated; tenant.id/cutoff/batch bound, not interpolated.
- **Decision (corrected per review F3): emit a per-tenant `HISTORY_RETENTION_PURGED` audit** — a NEW action, NOT the existing `HISTORY_PURGE`. Reason: `HISTORY_PURGE` lives in the tenant ADMIN audit group, but the worker's auto-trim is a maintenance operation; SC4/SC2 put their worker actions in the MAINTENANCE group (`CREDENTIAL_RETENTION_PURGED`, `TRASH_RETENTION_PURGED`). A dedicated `HISTORY_RETENTION_PURGED` in MAINTENANCE keeps the worker actions consistent AND distinguishes operator-triggered manual purge (HISTORY_PURGE) from automatic retention trim. Emit when count>0, under the tenant, with metadata { table, purgedCount, triggeredBy: "retention-gc-worker" }.

### C4 — sweepOnce dispatch — locked
- Add explicit `else if (entry.kind === "PER_TENANT_AGE")` → `workerPrisma.$transaction(tx => sweepPerTenantAge(tx, entry, batchSize))` (same shape as PER_TENANT_FN — it takes a tx).

### C5 — audit action — locked (corrected per review F3)
- Add a NEW `AUDIT_ACTION.HISTORY_RETENTION_PURGED` — const + AUDIT_ACTION_VALUES + **MAINTENANCE** group (consistent with TRASH_RETENTION_PURGED / CREDENTIAL_RETENTION_PURGED) + en/ja AuditLog.json (ja non-katakana) + Prisma AuditAction enum + a SEPARATE enum migration (R24). Do NOT reuse HISTORY_PURGE (that is the operator-manual action, in the ADMIN group).

### C6 — DB role grant — locked
- Grant `passwd_retention_gc_worker`: `SELECT, DELETE` on `password_entry_histories`, `team_password_entry_histories`. `SELECT` on tenants (already granted). No cascade concern (history rows are leaves — verify no inbound FK). Verify against live DB.

### C7 — tests — locked
- registry.test.ts: count assertion +2 PER_TENANT_AGE; DMMF cross-check covers the new kind.
- Unit (sweep-per-tenant-age.test.ts): tenant enumeration (NULL skipped), cutoff math, SQL shape (batch-bounded (id) IN, bound params), audit emit only when count>0.
- Integration (real DB): tenant historyRetentionDays=90 → history row with changed_at = now()-91d deleted, recent (now()-5d) kept; NULL-retention tenant untouched; role-grant positive + cannot-delete-other-table negative.

## Go/No-Go Gate
| ID | Subject | Status |
|----|---------|--------|
| C1 | Tenant.historyRetentionDays + migration | locked |
| C2 | PER_TENANT_AGE kind + 2 entries + validator | locked |
| C3 | sweepPerTenantAge (per-tenant batch DELETE) | locked |
| C4 | sweepOnce dispatch | locked |
| C5 | reuse HISTORY_PURGE audit | locked |
| C6 | DB role grant | locked |
| C7 | unit + integration tests | locked |

## Considerations
- **Why PER_TENANT_AGE not PER_TENANT_FN?** audit_logs uses a SECURITY DEFINER fn because audit_logs DELETE is revoked from the app role (immutability). History is mutable/trimmable — a plain DELETE with a direct grant is correct and simpler. PER_TENANT_AGE is the generic plain-DELETE-by-age kind.
- **Keep-last-N vs age**: this PR does age-based trim only (matches the existing manual route). A per-entry "keep last N versions" trim is a separate concern (not deferred here — out of scope, age-based covers the accumulation problem).
- Out of scope: policy API/UI for historyRetentionDays (follow-up); SC6/SC7.

## Scope contract
SC6/SC7 remain separate follow-ups. Policy API/UI for historyRetentionDays is a documented follow-up.
