# Code Review: retention-history-trim (SC3)
Date: 2026-06-18
Review rounds: plan (1) + code (1), converged.

## Plan review — 4 findings, all fixed pre-implementation
- **F4 (functional)**: validateRegistry would silent-skip PER_TENANT_AGE — added an explicit branch (assertIdentifier table+cutoffColumn).
- **F1 (test)**: registry.test DMMF loop didn't cover PER_TENANT_AGE — added a block asserting table+cutoffColumn(changed_at)+tenant_id resolve.
- **F2 (test)**: count assertion updated (+2 PER_TENANT_AGE).
- **F3 (consistency)**: do NOT reuse HISTORY_PURGE (operator-manual, ADMIN group). Added a dedicated `HISTORY_RETENTION_PURGED` in the MAINTENANCE group, consistent with SC4's CREDENTIAL_RETENTION_PURGED / SC2's TRASH_RETENTION_PURGED.

## Code review — SC3 OK (no findings)
All 10 focus areas verified clean: S1 SQL containment (table/cutoffColumn allowlist-validated boot+sweep; tenant.id/cutoff/batch bound; batch-bounded (id) IN); validator branch present; bypass_rls set first; R14 grant (2 leaf tables SELECT+DELETE, no over-grant); R12 audit coverage complete in MAINTENANCE group; dispatch correct (tx, per-entry isolation); registry DMMF cross-check non-vacuous; audit emitted only when deleted>0.

Two non-blocking observations (no fix): T-OBS1 (team_password_entry_histories DMMF-tested + unit-tested but not separately integration-tested — identical abstracted codepath to the personal table which IS integration-tested; accepted); T-OBS2 (test-helper NULL literal, test-internal only).

## Design note: PER_TENANT_AGE vs PER_TENANT_FN
audit_logs (PER_TENANT_FN) routes deletion through a SECURITY DEFINER function because audit_logs DELETE is revoked from the app role for immutability. History is mutable/trimmable, so PER_TENANT_AGE does a plain direct batch-bounded DELETE with a normal grant — simpler and correct. This is the generic plain-per-tenant-age-delete kind.

## Verification
- Unit: 4 sweep-per-tenant-age tests (enumeration NULL-skip, cutoff math, SQL shape, audit-only-when-deleted>0) + registry DMMF/count. tsc clean for SC3 files.
- Integration (real DB): trim-old/keep-recent; NULL-retention skip; worker-role least-privilege (can trim history, cannot delete audit_logs).
- Full worker suite + audit coverage pass; lint clean; pre-pr.sh 36/36; migrations applied to dev DB, grants verified via information_schema.
- Pre-existing unrelated tsc errors (tenant-admin-ttl / team-login / empty-trash test files, 40 on base) confirmed NOT in this diff and NOT a CI gate.

## Verdict
Converged. Tenant-configurable history auto-trim (`historyRetentionDays`, NULL = never), plain per-tenant age DELETE, least privilege, dedicated MAINTENANCE-group audit. Policy API/UI for historyRetentionDays is a documented follow-up. Age-based trim only (keep-last-N per-entry is out of scope).
