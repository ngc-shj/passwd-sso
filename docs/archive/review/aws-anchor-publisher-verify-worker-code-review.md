# Code Review: aws-anchor-publisher-verify-worker
Date: 2026-10-24
Review round: 1

## Changes from Previous Round
Initial review (incremental on top of the Phase 2 self-check, whose findings were fixed in the
"bound failures before the count, deny replication writes" commit). Local-LLM seeds were empty
(diff too large); all three experts reviewed the full diff.

## Functionality Findings
- F1 Minor — a retryable failure whose retry window is closed logs nothing distinct (scheduler).
- F2 Minor — `MISSING_PRIOR_CADENCE_PUBLICATION` written on every attempt, including rolled-back ones; docs say once.
- F3 Minor — `lock_held` never retried; a holder that dies without publishing costs the day.
- F4 Minor — dead-letter reason `anchor_publisher_emit_failed` missing from alerts.md; [Adjacent] no AWS metric filter on `audit-dead-letter`.
- F5 Minor — SIGTERM during boot races `shutdown()` against `ensureDeploymentIdMatch` (spurious `boot_failed`).
- F6 Minor — `terraform.tfvars.example` says `DEPLOYMENT_ID` is never rotated.

## Security Findings
- S-1 Minor — any DB-connecting role can hold the advisory lock; `lock_held` not retried, not alarmed; runbook overclaims (converges with F3).
- S-2 Minor — IAM role mutation and `RunTask` `taskRoleArn` override routes to the publisher role unalarmed; trust policy lacks `aws:SourceAccount`; "only task that reads these" overclaims.
- S-3 Minor — marker compared by equality while the fallback uses `>=`; an older boundary republishes and regresses the marker.
- S-4 Minor — verify worker prints raw error objects to CloudWatch instead of `errorLogFields`.

## Testing Findings
- T-1 Major — publisher SIGTERM/boot sequencing in the script untested (only `scheduler.stop()`).
- T-2 Major — `ci-integration.yml` paths omit `package.json`, `package-lock.json` and the workflow file; an SDK bump never runs the MinIO suites.
- T-3 Major — dev MinIO regenerates its KMS key per start while `/data` persists in an anonymous volume (verified: `docker inspect` shows a volume mount on `/data`).
- T-4 Minor — `ANCHOR_TEST_S3_ENDPOINT` undocumented; pre-pr's integration step probes Postgres only.
- T-5 Minor — retry-stop boundary (`<=`) unpinned.
- T-6 Minor — scheduler log lines and the throwing-`runCadence` retry unasserted.
- T-7 Minor — "bounded as a whole" indistinguishable from per-destination.
- T-8 Minor — smoke-map "fifth task" case tests a rename.
- T-9 Minor — advisory lock key and setting keys re-typed in tests.
- T-10 Minor — `check-terraform-test-count` refusal branches untested.

## Adjacent Findings
- F4 (functionality → security/ops): no CloudWatch metric filter matches `audit-dead-letter`; folded into SF-8.

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
R1–R57 checked; fired: R29 (F2, F6), R38 (F3). Others OK or N/A (full statuses in the expert output).

### Security expert
R1–R57 + RS1–RS6 checked; fired: R3/R17 (S-4), R38/R48/R56 (S-3), R42/R49 (S-1, S-2), R51 (folded into S-2). RS1–RS6 OK/N/A.

### Testing expert
R1–R57 + RT1–RT11 checked; fired: R16 (T-3, T-4), R33 (T-2), RT3 (T-9), RT5 (T-1), RT7 (T-5, T-8, T-10), RT11 (T-3).

## Environment Verification Report
- E1 (no AWS): every AWS behaviour — ECS deploys, IAM/bucket-policy evaluation, Object Lock on real
  S3, trail/EventBridge, alarms — is `blocked-deferred`, linked to the plan's E1 entry, listed with
  commands in `aws-anchor-publisher-verify-worker-manual-test.md` (M1–M8); Terraform `fmt`,
  `validate`, module `terraform test` are `verified-local` (D10).
- E2 (MinIO): Object Lock retention and refusal without Object Lock `verified-local`
  (`npm run test:integration` S3 suites with `ANCHOR_TEST_S3_ENDPOINT`); CI runs the same via the
  MinIO step (`verified-CI` pending the PR run).

## Resolution Status
### Round 1
All 20 findings fixed in one commit ("review(1)"); each behavioural fix red-proved on a scratchpad copy (25 mutations, each observed failing). Details in deviation D12.
- F3 / S-1: `lock_held` retryable within the window and the per-process bound; alarmed; holder query verified against the dev DB (`classid`, `objid`, `objsubid = 1`) — `audit-anchor-scheduler.ts` `isRetryable`, `monitoring.tf` failure log types, alerts.md.
- S-3: monotonic marker; later marker → `stale_boundary` skip (not healthy); unreadable marker → `failed` before_upload — `audit-anchor-publisher.ts` `isBoundaryPublished`.
- F1: `retries_exhausted` carries `reason: count | window_closed`.
- F2: missing-prior row only from a publishing run.
- F5 / T-1: boot and signal wiring extracted to `src/workers/audit-anchor-publisher-lifecycle.ts`, nine cases; a signal during boot exits 0, never `boot_failed`.
- S-4: verify worker prints `errorLogFields` only (its own precondition messages kept as `detail`).
- S-2: trust policy `aws:SourceAccount`; EventBridge rule on `RunTask`/`StartTask` overriding to the publisher role; wording narrowed; IAM role-mutation events remain unalarmed (EventBridge receives IAM only in us-east-1; this stack has no such provider) — residual recorded in alerts.md, threat model, manual test, D12.
- F4: dead-letter reason documented; metric filter + alarm on the publisher's `audit-dead-letter` lines.
- F6: `DEPLOYMENT_ID` wording in `terraform.tfvars.example`.
- T-2: `ci-integration.yml` paths include `package.json`, `package-lock.json`, the workflow.
- T-3: MinIO `/data` on tmpfs; verified in the container (`/proc/mounts`: tmpfs) and both S3 suites pass across a restart.
- T-4: pre-pr probes MinIO and exports `ANCHOR_TEST_S3_ENDPOINT`; dev docs list it. CLAUDE.md not edited (needs approval; the pre-pr probe and docs cover it).
- T-5…T-10: tests added as specified.
