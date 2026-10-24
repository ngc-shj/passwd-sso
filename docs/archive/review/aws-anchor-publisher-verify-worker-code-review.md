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

### Round 2
Findings: functionality N1 + security R2-1 (converged: a future marker suppresses every boundary
until its date), security R2-2 (role-override rule misses `RegisterTaskDefinition` of another
family and the bare role name), testing N-1 (real-timer upload-bound cases), N-2 (holder query
copied from alerts.md), N-3 (`count` precedence untested). All Minor; all fixed in "review(2)",
each red-proved (16 mutations). Details in D13.
- N1 / R2-1: a marker strictly later than the wall clock's current boundary fails closed
  (`CADENCE_FAILED:BOUNDARY_MARKER_AHEAD`, before the count, alarmed via `cadence_failed`);
  `stale_boundary` is alarmed. `PublisherConfig.now` added so the publisher runs on one clock;
  the integration cases that run again after a far-future publish pin it with `wallClockAt`.
- R2-2: second EventBridge rule on `RegisterTaskDefinition` naming the role for any family but the
  publisher's own (family referenced from the task definition); both rules match the ARN and the
  bare role name.
- N-1: fake timers; edge 0.5 + 0.5 = bound falls on the timeout side (the bound is armed first).
- N-2: the integration case runs the `sql` block read from alerts.md, with decoy locks so a
  weakened query returns extra rows.
- N-3: retries exhaust exactly as the window closes → `reason: "count"`.
- Accepted residual: a scheduler timer firing milliseconds early publishes boundary B while the
  wall clock is still before B; a second concurrent run inside those milliseconds would read the
  marker as ahead and alarm. The ECS service runs one task with stop-before-start deploys, and the
  scheduler arms the next run from the boundary, so no second run exists in that window — worst
  case one false alarm, no data effect.

### Round 3
Findings: security R3-1 (a publisher-family revision started directly, no override, unalarmed),
functionality N2 (`stale_boundary` docs name a cause that now raises `BOUNDARY_MARKER_AHEAD`), N3
(the accepted early-timer residual also writes `lastPublishedAt` before the boundary, so the next
day falsely reports a missing prior cadence), testing R-1 (`config.now` as the publish clock
unpinned), R-2 (two cases publish the next boundary under a clock a day behind), R-3 (decoys miss
`classid`). All Minor; fixed in "review(3)", red-proved. Details in D14.
- R3-1, closed by re-deriving the class rather than adding a route (R42 ①b: the member set had
  grown twice): a task holds the publisher role iff (a) an override names it — `role_override`;
  (b1) another family's task definition names it — `role_task_definition`; (b2) the publisher's
  own family runs outside the publisher service — native ECS Task State Change rule (cluster or
  `group` differs) plus a CloudTrail RunTask/StartTask rule naming the family, because `group` is a
  caller-supplied RunTask parameter and can be forged. A static test enumerates (a)/(b1)/(b2) plus
  the forged-group RunTask and requires each to be matched by exactly one rule and legitimate events
  by none (14 red fixtures). Residual: `UpdateService`/`CreateService` pointing the publisher service
  at a revision registered outside a deploy, and IAM mutations of the role.
- N3: the scheduler re-arms for the remainder when a timer fires before its deadline, so no run
  happens before its boundary; the round-2 accepted residual no longer exists.
- N2, R-1, R-2, R-3 as specified.

### Round 4
Findings: testing Q-1 (a looping scheduler hangs the suite), functionality N4 (re-arm delay
unbounded; >24.8 days overflows to 1 ms and busy-loops), N5 and security R4-1 (role routes in
other regions, and via AWS services that launch ECS tasks such as Batch). All Minor.
- Q-1: harness fire cap (50) — red-proved with the `<=` mutant.
- N4: `MAX_TIMER_DELAY_MS` cap — red-proved.
- N5 / R4-1: not another alarm. The role-route member set has expanded four times, which is the
  signal to change mechanism rather than add members: the preventive control for the class is
  `iam:PassRole` on the publisher role (operator-owned SCP / permission boundary). Docs narrowed
  to "direct ECS calls in this region" with the other routes as residual; the manual test checks
  who holds `iam:PassRole` and carries the `aws:SourceArn` trust binding as an optional,
  AWS-verified experiment. A follow-up issue records the PassRole control.

### Round 5
Findings: security R5-1 and functionality N6 (converged: the docs named `iam:PassRole` as the
control for the whole class, but the role-change routes — `UpdateAssumeRolePolicy`,
`DeleteRole` + `CreateRole` — need no PassRole), testing S-1 (the bounded-delay test compared
against the imported constant, so an off-by-one cap passes). All Minor.
- R5-1 / N6: the threat model, alerts.md and the manual test now name two controls — who holds
  `iam:PassRole` on the role (task-launch routes) and who holds IAM write actions on it
  (role-change routes) — and the manual test simulates both.
- S-1: `MAX_TIMER_DELAY_MS` pinned to `2 ** 31 - 1`.

### Round 6
Functionality: No findings. Testing: No findings. Security R6-1 (Minor): the role-write list
lacked `iam:DeleteRolePermissionsBoundary` and the managed-policy version route. Added in all three
docs; the role carries an inline policy only (`aws_iam_role_policy.ecs_audit_anchor_publisher_s3`),
stated alongside. Docs-only; confirmed by a security-only round 7.

### Round 7
Security: No findings (R6-1 resolved). Functionality and testing: No findings since round 6.
Review complete after 7 rounds; citation gate (`verify-references.sh --strict`) clean.
