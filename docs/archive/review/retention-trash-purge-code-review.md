# Code Review: retention-trash-purge (SC2)
Date: 2026-06-18
Review rounds: plan (1) + code (1), converged.

## Plan review — 5 findings, all fixed pre-implementation
- **F1 (high)**: my C4 dispatch claim was backwards (PER_TENANT_FN gets a `tx`, not workerPrisma). Corrected: PER_TENANT_TRASH is the *first* kind to take workerPrisma directly (post-commit blob delete owns its own tx).
- **F3 (high)**: C6 cascade-reach enumeration incomplete. Corrected: deleting an entry cascades to attachments + history + favorites + tag-join-tables + SetNull on password_shares — all pure-cascade → NO grant (R14 lesson); only entry tables need DELETE, attachments SELECT-only.
- **F4 (high)**: team-scope mismatch — `collectEntryAttachmentRefs` needs ONE teamId but per-tenant enumeration spans many teams. Corrected: group entry ids by team_id, call once per team.
- **S1 (verified not an issue)**: password_shares SetNull under auto-purge — confirmed the share-content route serves the share's OWN encryptedData snapshot (not via passwordEntryId) and is independently gated, so SetNull doesn't change access. No guard needed.
- **T1**: external-blob test must assert the F4 multi-team partition.

## Code review — SC2 OK (no findings)
All 9 focus areas verified clean against the staged diff:
- F4 multi-team grouping correct; unit test non-vacuous (2 interleaved teams → 2 partitioned calls).
- Blob-delete ordering: refs collected BEFORE the deleteMany cascade; deleteAttachmentBlobs AFTER tx commit.
- SQL: parameterized `$queryRaw` tagged templates (tenant.id/cutoff/batchSize bound); bypass_rls set first.
- Dispatch: sweepTrashEntry called directly with workerPrisma (no outer tx); per-entry error isolation preserved.
- R14: attachments SELECT-only, no over-grant; T2 integration test proves cascade works without child DELETE grant.
- R12: TRASH_RETENTION_PURGED in all sites + coverage tests pass.
- sweep-isolation.test.ts updated correctly for the non-$transaction trash dispatch — isolation still genuinely proven.
- Audit emitted only when count>0 (no noise).

Two non-blocking minor notes (no fix): N1 deletedCount = ids.length (equal under bypass_rls same-tx); N2 SetNull path untested but verified safe (S1).

## Verification
- Unit: 81 worker tests (incl. F4 multi-team partition). `tsc --noEmit` clean for SC2 files.
- Integration (real DB, DB backend): past-grace purge + cascade attachment removal; within-grace kept; non-trashed kept; NULL-retention tenant skipped; T2 worker-role negative grant (cannot direct-DELETE attachments, cascade works).
- Full suite 11395 pass; lint clean; `next build` green; `pre-pr.sh` 36/36; migrations applied to dev DB, grants verified via information_schema.
- Pre-existing tsc error in teams/.../empty-trash/route.test.ts:161 confirmed on the branch base, NOT in this diff, NOT a CI gate (pre-pr passes) — out of SC2 scope.

## Verification environment constraint
- **VC-blob (blocked-deferred)**: the real external-blob delete (S3/Azure/GCS) cannot run in CI (no bucket). Covered by the F4 multi-team unit test (mocked blob store, asserts the right refs/partition reach deleteAttachmentBlobs). The DB-backend cascade is integration-tested on the live DB.

## Verdict
Converged. Tenant-configurable trash retention (`trashRetentionDays`, NULL = never auto-purge) + worker-driven external-blob cleanup (reusing the empty-trash helpers), under least privilege. Policy API/UI for trashRetentionDays is a documented follow-up (this PR adds the column + worker only).
