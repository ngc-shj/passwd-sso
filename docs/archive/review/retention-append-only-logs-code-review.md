# Code Review: retention-append-only-logs (SC7)
Date: 2026-06-18
Review rounds: plan (1) + code (1), converged.

## Plan review — clean
The #571 deferral note ("needs schema cutoff columns") was wrong — all 3 tables already have a timestamp + tenant_id + id PK, so SC7 reuses the SC3 PER_TENANT_AGE kind with no schema cutoff column. Plan OK; per-table individual retention fields (user-confirmed).

## Code review — SC7 OK (no findings)
All 8 focus areas verified clean:
- auditAction parameterization: sweepPerTenantAge emits AUDIT_ACTION[entry.auditAction]; both SC3 history entries got HISTORY_RETENTION_PURGED, the 3 SC7 log entries use LOG_RETENTION_PURGED; unit test asserts both independently (non-vacuous).
- `as unknown as` cast (tenant.findMany computed-select): sound — Prisma returns exactly { id, [col] }; the cast narrows the inference-widened ~50-model union; `col` is an ORM key only, never raw SQL.
- S1: table + cutoffColumn allowlist-validated (boot + sweep); tenantRetentionColumn is a closed literal union (ORM key only). directory_sync_logs correctly uses started_at (no created_at).
- R14: 3 leaf tables SELECT+DELETE, no inbound FK, no over-grant.
- R12: LOG_RETENTION_PURGED in all sites + MAINTENANCE group + separate enum migration; coverage tests pass.
- registry.test count → 5 PER_TENANT_AGE; DMMF block auto-covers the 3 new entries (created_at/started_at/created_at).
- 3 additive nullable Tenant columns.

One low note (no fix): T1 makeTx test-helper type widened to Record<string,...> (accepts any key) — acceptable given the integration test exercises the real DB path and the assertions catch wrong values.

## Design note
SC7 is the cleanest follow-up — it reuses SC3's PER_TENANT_AGE kind with zero new sweep logic. The only additions: 3 Tenant retention columns, a `tenantRetentionColumn` union widening, an `auditAction` field parameterizing the audit action (HISTORY vs LOG), a new LOG_RETENTION_PURGED action, 3 registry entries, and grants.

## Verification
- Unit: 91 worker tests (incl. auditAction parameterization for both HISTORY and LOG). tsc clean for SC7 files.
- Integration (real DB, share_access_logs representative): trim-old/keep-recent; NULL-retention skip; worker-role least-privilege. directory_sync_logs/notifications share the identical codepath (DMMF + unit covered).
- Full worker suite + audit coverage pass; lint clean; pre-pr.sh 36/36; migrations applied to dev DB, grants verified via information_schema.

## Verdict
Converged. Per-tenant per-table retention for share_access_logs / directory_sync_logs / notifications, reusing PER_TENANT_AGE. Policy API/UI for the 3 retention fields is a documented follow-up. Only SC6 remains.
