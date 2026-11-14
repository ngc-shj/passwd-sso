# Code Review: aws-orphan-blob-sweep-wiring
Date: 2026-11-14
Review round: 2

## Changes from Previous Round

Initial review. No seed findings (the local LLM was unavailable); each expert reviewed the full
diff.

## Functionality Findings

- **F1 [Major]** The rollout's standalone `terraform apply` and the manual test's M1 plan used
  the tfvars `app_image` (a tag), while `deploy.sh` applies the deployed digest: every task
  definition showed replaced, and `-var` settings were reverted by `deploy.sh`.
- **F2 [Minor]** `run_retention_once` ignored a waiter failure; an image older than this release
  starts a second worker loop on an unknown flag.
- **F3 [Minor]** No step lifted the upload quiesce, nor covered `deploy.sh`'s own rollback.
- **F4 [Minor]** `encodeObjectRef`'s bound threw after the upload.
- **F5 [Minor]** D1 overstated that the C5 precondition cannot fire.

## Security Findings

- **S-1 [Major]** `ecs_s3_access` was not gated on the backend switch: on `db` stacks the app and
  the outbox worker held Get/Put/Delete on every attachment object, and the outbox worker never
  uses the bucket.
- **S-2 [Minor]** The delete-marker recovery relied on a hand-copied version id.
- **S-3 [Minor]** The bucket-ownership check named tools that cannot see same-account sharing.
- **S-4 [Minor]** The `s3` acknowledgement and KMS preconditions sat only on the retention task
  definition.
- **S-5 [Minor]** The restore step omitted that a mode change takes effect only through
  `deploy.sh`.

## Testing Findings

- **T1 [Major]** Precondition 4's `max()` axis was untested (a mutation survived).
- **T2 [Major]** Precondition 3 was tested with `report` only (a mutation survived).
- **T3 [Major]** The SQL boundary at exactly `MAX_OBJECT_REF_BYTES` was untested.
- **T4 [Major]** The `--count-db-blobs` success output was never tested.
- **T5 [Minor]** The variable validations were evaluated only by hcl-subset.
- **T6 [Minor]** Only the `s3` + `report` env went through the worker schema.

## Adjacent Findings

None.

## Quality Warnings

None.

## Recurring Issue Check

### Functionality expert
R1–R3, R17–R19, R31, R33, R40–R42, R44, R48, R54, R55, R57 OK; R29/R49 → F5; R34/R50 → F1, F2;
R35 → manual test present; the rest N/A.

### Security expert
R1, R2, R14, R17, R18, R25, R33, R37, R38, R40–R44, R47, R48, R51, R54, R55, R57 OK;
R3/R34 → S-1; R31 → S-2, S-5; R49 → S-3; RS3, RS4 OK; RS1, RS2, RS5, RS6 N/A.

### Testing expert
R16, R19, R29, R33, R35, R44, R50 OK; R3 → T4; RT1, RT3, RT6, RT8, RT11 OK; RT5 → T3, T5;
RT7 → T1–T3; RT9 noted (fixture confirmed equal to `main`'s rendering); RT10 → T1–T3, T6.

## Environment Verification Report

- VE1 (operator plan/apply): `blocked-deferred` — Phase 1 VE1; the manual test M1–M5 carries it.
- VE2 (a sweep pass on a deployed stack): `blocked-deferred` — Phase 1 VE2.
- Local: mocked `terraform test` 25/25 with the run manifest; integration
  (`retention-gc-count-db-blobs`, `retention-gc-blob-orphans`) 9/9 — `verified-local`.

## Resolution Status

### S-1 [Major] App and outbox worker kept attachment-bucket rights
- Action: `ecs_s3_access` exists only for backend `s3`; the outbox worker runs with no task role
  (its only `ecs_task` policy was S3; ECS Exec, logs and secrets belong to other roles; its
  delivery targets sign with per-destination credentials). `terraform test` pins both sides,
  each red-proved.
- Modified file: `infra/terraform/iam.tf`, `infra/terraform/ecs.tf`, tests, docs, manual test.

### F1 [Major] Standalone apply/plan used the tfvars image
- Action: rollout, rollback and restore steps set variables in `$TF_VAR_FILE` and run
  `scripts/deploy.sh`; previews pass `-var app_image=$RUNNING`, read from the running task
  definition; M1 likewise.
- Modified file: `docs/operations/deployment.md`, manual test.

### T1, T2 [Major] Precondition axes
- Action: an RDS-window-over-Backup-window pair and `p3_delete_on_db_fails`; red-proved by the
  surviving mutations and by `min()`.
- Modified file: `infra/terraform/tests/blob_sweep.tftest.hcl`, `blob_sweep.runs.json`.

### T3 [Major] SQL boundary
- Action: the integration test seeds a maximal ref and an at-bound non-ref blob (deltas
  `total +5, db_stored +3`); the unit fake reads the comparison operators from the SQL, so `<=`→`<`
  and `>`→`>=` fail it.
- Modified file: count-db-blobs unit and integration tests.

### T4 [Major] Success output
- Action: the integration test spawns the entrypoint as the worker role and pins exit 0, one
  stdout line with exactly `{level, msg, total, db_stored}`, equal to the function's count.
- Modified file: `retention-gc-count-db-blobs.integration.test.ts`, `helpers.ts`
  (`retentionGcConnectionString`).

### Minors
- S-2: the delete-marker id is selected by query and refused unless exactly one.
- S-3: the 1:1 premise names its exceptions; evidence is CloudTrail data events or access logs.
- S-4: preconditions 1 and 2 also on the app task definition (a shared local), with deny runs.
- S-5: the restore step deploys and confirms the running mode.
- F2: image precondition stated; the waiter failure returns 1 with a stop-task hint.
- F3: uploads resume only after `db_stored: 0` on a completed deploy; a rolled-back deploy keeps
  them quiesced.
- F4: the three stores encode the ref before the upload; tests per store.
- F5: the precondition fires alongside the provider error (observed); D1 retitled, kept.
- T5: real `expect_failures = [var.x]` runs; D2 states the `>= 1.5` floor is unverified in CI.
- T6: `s3`+`delete` and `s3`+`off` parse; the delete env without a grace is refused.

## Round 2 (incremental: a0ac567cc..128fe7229)

All round-1 findings resolved (security, functionality and testing re-verified; sampled
mutations re-run).

### Security / Functionality (combined)
- **N1 [Minor]** The manual test's rollback still named a standalone apply, and omitted the
  outbox task definition and `ecs_s3_access` reversal.
- **N2 [Minor]** Scaling the retention service to 0 does not survive the next `deploy.sh`, which
  restarts it in the tfvars mode.
- **N3 [Minor]** An `s3`→`db` apply removes the app's bucket rights before the services move.

### Testing
- **N1 [Major]** The keyset cursor branch's size comparison was unproven (a mutation survived).
- **N2 [Minor]** The unit fake read only the operator token.
- **N3 [Minor]** The entrypoint cell could not detect a field swap when run alone; timeout and
  spawn-error handling.
- **N4 [Minor]** The grace maximum and the sweep-mode enum had no real Terraform run.
- **N5 [Minor]** Store tests hard-coded 1024/1025.

### Resolution Status (round 2)
- Sec/Func N1–N3: docs corrected (`deployment.md` rollback and restore; manual-test rollback).
- Testing N1: a three-row, page-size-1 unit cell that asserts the cursor query ran, and an
  integration call with page size 2 equal to the default; red-proved (`<` in the cursor query
  fails only the new cell).
- Testing N2: the fake accepts only the exact predicate shape and throws otherwise; three
  mutations fail it.
- Testing N3: the cell seeds a ciphertext row and a ref row and asserts `total > db_stored`;
  spawn error asserted first; 90 s cell timeout.
- Testing N4: `v_grace_above_max_fails`, `v_mode_unknown_fails` (27 runs); each red-proved.
- Testing N5: `MAX_OBJECT_KEY_BYTES` exported and used.

## Termination

Round 2's changes are tests and operator docs only, apart from exporting one constant; each
test change is red-proved and no security boundary is touched. No further round is run.
