# Plan Review: aws-orphan-blob-sweep-wiring

Date: 2026-11-14
Review round: 1

## Changes from Previous Round

Initial review. Two experts ran: functionality and testing combined, and security. The plan is
infrastructure-only and small.

## Functionality / Testing Findings

- **F1 [Major]** The precondition is dead: a `[0]` index in the local errors before it is
  evaluated (reproduced on Terraform 1.15.8). Use `one([*])`.
- **F2 [Major]** C1/C2 acceptance and the preconditions are untestable as planned (`validate` and
  `console` do not evaluate preconditions). Add a root `terraform test` with `mock_provider`.
- **F3 [Major]** No KMS permissions for the worker or app roles when `s3_kms_key_arn` is set.
- **F4 [Major]** A `DEPLOYMENT_ID` change leaves the marker mismatched, and the sweep refuses
  forever.
- **F5 [Major, adjacent]** The versioned bucket has no noncurrent expiration, so `DeleteObject`
  reclaims nothing. Grace sizing is undocumented.
- **F6 [Minor]** Wrong log name; no alarm.
- **F7 [Minor]** The grace variable lacks the schema bounds.
- **F8 [Minor]** The mode env is unconditional, contradicting acceptance 1; possible
  `environment = []` diff.
- **F9 [Minor]** The marker key literal is duplicated; `GetObject` is broader than needed.
- **F10 [Minor]** The mixed-backend rationale is imprecise, and the `s3`→`db` reversal is
  undocumented.
- **F11 [Minor]** Stale docs and an incomplete run-task command.

## Security Findings

- **S1 [Major]** SSE-KMS gives no KMS permissions (same as F3).
- **S2 [Major]** `GetObject` on `/*` is wider than needed: the worker reads only the marker.
- **S3 [Major]** The delete-mode grace is not tied to the database restore window.
- **S4 [Major]** Switching a populated stack to `s3` is guarded only by docs.
- **S5 [Minor]** State the forbidden permissions and the delete-marker recovery.
- **S6 [Minor]** No noncurrent lifecycle: deleted ciphertext is kept forever.
- **S7 [Minor]** The marker is readable through CloudFront.
- **S8 [Minor]** The trust policy is OK; record why no override detection is needed.
- **S9 [Minor]** The marker key is hard-coded; it needs a local plus a contract test.
- **S10 [Minor, adjacent]** `ignore_changes = [task_definition]`: changes take effect only after
  `deploy.sh`.

## Disposition (plan revision 2)

| Finding | Resolution in the plan |
|---|---|
| F1 | C1 bucket refs |
| F2 | C4 |
| F3, S1 | Precondition 2 plus SC3 |
| F4 | C3 runbook step |
| F5, S6 | C3 note plus SC4 |
| F6 | C3 names; SC5 |
| F7 | C1 validation |
| F8 | C1: env only when not `off`; C4 confirms no diff |
| F9, S2, S9 | C2 marker-only Get/Put, local plus contract test |
| F10 | Premise section rewritten |
| F11 | C3 stale-doc list plus output |
| S3 | Precondition 4 plus the C3 restore note |
| S4 | The acknowledgement variable |
| S5 | C2 forbidden actions plus the C3 recovery note |
| S7 | Accepted, documented |
| S8 | C2 comment |
| S10 | C3 rollout step 1 |

## Round 2 (plan revision 2)

One combined reviewer with a mocked-provider spike on Terraform 1.15.8.

- **N1 [Major]** `one()` interpolated into the C2 policy templates errors when no bucket exists,
  before precondition 1 can report. → C2 policy `count`; C1 guard-ordering rule.
- **N2 [Minor]** C4 needs mock ARN defaults, short names, no ACM, and `apply` for content
  asserts; the fixed count drifts. → C4 recipe; generalised count check; fallback dropped.
- **N3 [Major]** The `DEPLOYMENT_ID` marker re-init defeats the marker for clones sharing the
  bucket; the worker restart is missing. → C3 conditional step plus force-new-deployment.
- **N4 [Minor]** "No diff" is uncheckable under the mock. → omit the empty `environment` key;
  vitest default-equals-current.
- **N5 [Minor]** The run-task command is incomplete. → C3 rollout step 3.
- **N6 [Minor]** A null grace errors instead of reporting precondition 4. → `!= null` arm first.
- **N7 [Major]** Precondition 4 overstates restore safety: zero margin, unreachable above 35 d,
  counts AWS Backup when disabled. → C1 restated as a floor, `enable_backup`-gated window, C3
  restore procedure as the control, SC6.
- **N8 [Minor]** The acknowledgement guards one direction and one moment. → C3 quiesce, SQL
  check, rollback.
- **N9 [Major, adjacent]** An EventBridge rule name is 66 characters with the shipped tfvars. →
  C5.
- **N10 [Minor]** The `s3` worker env is never parsed by the worker schema; `hcl-subset` lacks
  `one()`. → C1 acceptance vitest.

Round-1 F3/S1, F5/S6, F6, F7, F9/S2/S9, F10, S5, S7, S8, S10 confirmed resolved.

## Recurring Issue Check

### Functionality / Testing expert
- R2 F9
- R3 F3, F11
- R14 checked
- R16 F8
- R29 F10
- R31 checked
- R32 checked
- R34 F3, F5
- R35 checked
- R41 F3, F4
- R42 checked (List, Get, Put-marker, Delete)
- R43 F9
- R49 checked
- R50 F2
- RT2 F2
- RT7 F2
- RT10 F2
- other R/RT N/A

### Security expert
- R2 S9
- R3 S1
- R14 S2
- R16 none
- R29 accurate
- R31 S3
- R32 manual test
- R34 S1
- R35 manual test
- R41 S1
- R42 code-derived
- R49 S2
- R50 S10
- R51 S7
- R52 S3
- R53 S3
- RS4 OK
- other N/A

## Round 3 (plan revision 3)

N1, N2, N5, N6, N7, N9, N10 resolved (N1, N6, N7, N9 executed under the mock). N3, N4, N8 partly
resolved; their remainders are R3-3, R3-2 and R3-1.

- **R3-1 [Major]** The post-rollout SQL check returns 0 under FORCE RLS on RDS (non-superuser
  master), has no discriminator column, and no remedy branch. → C6 worker subcommand
  `--count-db-blobs` (bypass grant, `decodeObjectRef`), used for the acknowledgement too.
- **R3-2 [Minor]** The app container always has an environment; "current" unpinned. → C1
  acceptance corrected; frozen fixture.
- **R3-3 [Minor]** A copy with its own copied bucket fits neither arm. → bucket-based predicate.
- **R3-4 [Minor]** A count derived from the file under test cannot catch a deleted run. →
  external `blob_sweep.runs.json` plus a name-set check and a vitest pin.
- **R3-5 [Minor]** `docs/setup/aws/en.md` missing from the stale-doc list. → added.
- **R3-6 [Minor]** No `name_prefix` bound. → validation `<= 20`; suffix sized to it.
- `expect_failures` runs must be `command = plan` (N2 note). → C4.

## Round 4 (plan revision 4, narrow: revision-4 changes only)

R3-1 resolved in principle, R3-2/R3-4/R3-5 resolved, R3-3 and R3-6 partly; `expect_failures`
note confirmed by execution.

- **N4-1 [Major]** `--count-db-blobs` would read every row's `encrypted_data` (up to 10 MB each)
  in one interactive transaction. → C6 bounded reads: `MAX_OBJECT_REF_BYTES` enforced by
  `encodeObjectRef`, SQL counts of oversized rows, keyset-paged decode of the rest.
- **N4-2 [Minor]** Grant and call site unnamed. → `RETENTION_BLOB_ORPHAN_SWEEP` via `inSweepTx`
  in `sweep.ts`.
- **N4-3 [Minor]** Absolute counts fail on the shared database. → deltas.
- **N4-4 [Minor]** The bucket comparison is never true inside the module. → 1:1 stated; the
  second arm is an out-of-module inventory.
- **N4-5 [Minor]** Fixture capture unstated. → default vars, first commit, no regenerate flag.
- **N4-6 [Minor]** Gate mode, record filter and CI filter unspecified. → C4.
- **N4-7 [Minor]** A cross-variable validation needs Terraform 1.9. → precondition on the C5
  rule.

## Stopping decision

Rounds 3 and 4 each found one Major, both inside surface the previous round added (C6 itself
answers R3-1), and the rest Minors on mechanism detail. Per the review-loop stopping rule the
remaining risk is implementation detail, which Phase 2 tests and Phase 3 review cover. The plan
is locked at revision 5; any further detail is recorded in the deviation log.
