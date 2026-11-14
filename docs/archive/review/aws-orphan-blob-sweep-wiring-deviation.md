# Coding Deviation Log: aws-orphan-blob-sweep-wiring

## D1 — The C5 `name_prefix` precondition cannot be isolated by `expect_failures`

A `name_prefix` over 20 characters also makes the provider reject the sibling rule
`-audit-anchor-publisher-role-task-definition` (44 characters, 64 limit). The precondition does
fire: a scratch-copy run at `env = "prod-12345"` (21 characters, no `expect_failures`) reported
both diagnostics — the provider's `"name" cannot be longer than 64 characters` on
`aws_cloudwatch_event_rule.audit_anchor_publisher_role_task_definition[0]`, and `Resource
precondition failed` with this precondition's message. With `expect_failures` naming the rule, the
precondition's failure is absorbed and the provider error remains, so the run errors. The bound is
therefore checked in vitest (`blob-sweep-wiring.test.ts`, both sides of 20), and `terraform test`
has an allow run at exactly 20 characters (`c5_name_prefix_at_bound_plans`). The precondition stays
(round 1, F5): it names the cause in its own words next to the provider's error.

## D2 — Null-safe conditions written as conditionals

Precondition 4 and the grace validation use `x == null ? false : …` rather than `x != null && …`:
`required_version` is `>= 1.5`, and short-circuit evaluation of `&&` is only guaranteed from
Terraform 1.12. The `>= 1.5` floor itself is unverified by CI, which pins
Terraform 1.15.8; the conditional form is chosen so that it does not depend on short-circuiting,
not because an older version was run.

## D3 — "Each precondition fails with its own message"

`terraform test` does not expose a failed precondition's message in its JSON output. The contract
is held by (a) a vitest evaluation that each `p<N>_*_fails` run's variables make exactly
precondition N false and every `_plans` run makes all true, and (b) red-proofs: removing
precondition N fails its run with "Missing expected failure".

## D4 — More default-plan changes than the plan listed

The C5 rename also replaces `aws_cloudwatch_event_target …_sns[0]` (its `rule` forces
replacement) and updates `aws_sns_topic_policy.alarms[0]` in place (it references the rule ARN).
On a stack where the 66-character rule was never applied, the rule is created, not replaced. The
manual test (M1) lists these.

## D5 — The acknowledgement names `db_stored: 0`

The variable description, the precondition message and the docs all name the exact
`--count-db-blobs` output the operator must see.

## D6 — `audit-anchor-wiring.test.ts` anchors (R19)

Two red fixtures anchored on the trust policy's `Condition` line, which the new retention role now
shares. They anchor on the publisher role block's head instead.

## D7 — C6 helpers

Besides the exported `countDbStoredAttachments`, two bypass-asserting transaction functions
(`countAttachmentRows`, `readSmallAttachmentPage`) follow `sweep.ts`'s member-set convention; the
`sweep-bypass-source` / `sweep-bypass-assert` member lists include them. Both pass
`BYPASS_GRANT.RETENTION_BLOB_ORPHAN_SWEEP` directly (check-bypass-rls reads the call site). A page
size below 1 is refused.

## D8 — Not changed

`envs/dev/terraform.tfvars.example` is not in the plan's stale-doc list and was left as is.

## D9 — Step 2-5 self R-check

- Security: no findings.
- Functionality:
  - R42: the anchor-bucket guard in `audit-anchor-wiring.test.ts` checked `ecs_task` only; it now
    derives every role but the publisher's from the code, with a red fixture granting the anchors
    bucket to `ecs_retention_gc_task` (it would pass the old guard).
  - R1: `--count-db-blobs` rebuilt the worker's pool without its `error` listener, so an idle
    client error would crash with the full driver message. `createRetentionGcPool` (worker
    `index.ts`) is now the one constructor for the worker and the subcommand.
  - R2: the `application_name` literal is no longer copied into the CLI. The integration setup's
    list of worker names keeps its literals, as it does for every worker.
- Testing:
  - RT10/RT7 (Major): the three variable validations had no deny side. `blob-sweep-wiring.test.ts`
    now evaluates each condition through hcl-subset on both sides of every bound, with the grace
    bounds read from the env schema itself, so a drift on either side fails (red-proved by moving
    the HCL bound and, separately, the schema bound). hcl-subset gains `floor()`.
  - RT7: the count check's "a run passed twice" branch and hcl-subset `one()`'s list branches are
    pinned by direct tests.
  - RT3: `sweep-bypass-assert.test.ts` imports `MAX_OBJECT_REF_BYTES` instead of 1034.
  - R29: the count-db-blobs integration test seeds three tenants (one per row); its header and
    the plan's C6 acceptance say so.

## D10 — Local pre-PR: one environmental failure

`Static: rls-cross-tenant SQL parse` fails locally only: it runs against the shared dev database,
which carries the `share_creator_admitted` body of the parallel #1035 branch (seven bypass
tables), while this branch's verify SQL pins the five of `main`. CI builds the database from this
branch's migrations. `Test` also fails locally only: the six `backup-db.test.mjs` Group B cells
need a real `pg_restore`, which resolves from the main checkout but not from a git worktree; the
other 22515 unit tests pass. Every other gate passes.

## D11 — Code review round 1 fixes

- **S-1.** `aws_iam_role_policy.ecs_s3_access` (the app's Get/Put/Delete on `<bucket>/*`) now
  exists only with `attachments_blob_backend = "s3"`; on the `db` default no task holds bucket
  rights. The outbox worker gets **no task role** rather than a new empty one: `ecs_task`'s only
  policy was `ecs_s3_access`; ECS Exec is the migrate role's, logs and secrets go through the
  execution role, no KMS policy exists, and the worker's three deliverers (webhook, SIEM HEC,
  S3-compatible PUT) sign with each destination's own configured credentials, never the task's.
  That is the verify worker's pattern ("No task_role_arn"). `terraform test`: defaults assert
  `ecs_s3_access` length 0 and the outbox `task_role_arn == null`; `s3_report` asserts the app
  policy's role and exact statement. Manual test M1 lists the outbox task-definition replacement
  and the `ecs_s3_access[0]` delete; M3 the app role's policy and the outbox's missing role.
- **S-4.** Preconditions 1 and 2 are shared locals (`attachment_backend_bucket_ready`,
  `attachment_backend_sse_ready`) evaluated on both the app and the retention task definitions,
  with the same messages. The `p1_*`/`p2_*` fail runs name both resources in `expect_failures`
  (an app precondition failing unnamed would error the run); vitest pins which object each
  `*_fails` run must name and that the app's copies agree with the retention task's.
- **F1.** Every change goes through `scripts/deploy.sh` with the variables in `$TF_VAR_FILE`
  (it applies `-var-file="$TF_VAR_FILE" -var app_image=<digest>`); previews are
  `terraform plan -var-file="$TF_VAR_FILE" -var "app_image=$RUNNING"`, `RUNNING` read from the
  app service's current task definition. deployment.md (preview, Rollout 1 and 5, Rollback,
  restore) and the manual test (setup, M1, M2, rollback) say so.
- **T1/T2/T5.** New runs: the `max()` pair (`db_backup_retention_days = 14`,
  `backup_retention_days = 7`, grace 1209600000 plans / 1209599999 fails),
  `p3_delete_on_db_fails`, and `expect_failures = [var.x]` runs for grace below min, grace at
  min, a non-integer grace and backend `"S3"` (25 runs, `blob_sweep.runs.json` updated). The
  vitest bound-sync test stays.
- **T3.** The unit fake now reads the size comparison from the statement text and applies that
  operator, so `<=`→`<` and `>`→`>=` in `sweep.ts` fail a new at-bound unit cell. The
  integration test, which runs the real SQL, remains the authority: it seeds five rows in five
  tenants (ciphertext, a ref, a maximal ref of exactly `MAX_OBJECT_REF_BYTES`, a non-ref blob of
  exactly that size, a ref-shaped row one byte over) and expects `total +5, db_stored +3`.
- **T4.** The integration file spawns `scripts/retention-gc-worker.ts --count-db-blobs` with
  `RETENTION_GC_DATABASE_URL` set to the worker role's URL (`retentionGcConnectionString()`, a
  new export in `db-integration/helpers.ts`) and asserts exit 0, one stdout line with exactly
  `{level, msg, total, db_stored}`, and agreement with `countDbStoredAttachments` measured just
  before and after (which must be equal).
- **F4.** The S3, GCS and Azure stores encode the ref before the upload, so a key whose ref is
  over `MAX_OBJECT_REF_BYTES` is refused with nothing written; a 1024-byte key still uploads
  (store-mock unit tests in each store's test file).
- **T6.** The worker-schema parse also runs for `s3` + `delete` (grace 3024000000) and `s3` +
  `off` (no `DEPLOYMENT_ID`), both exit 0; the delete env with the grace removed exits 1 on
  `RETENTION_GC_BLOB_ORPHAN_GRACE_MS` (the deny control).
- **Docs (S-2, S-3, S-5, F2, F3).** The delete-marker recovery selects the latest delete marker's
  id mechanically and refuses unless exactly one comes back, and warns never to delete a
  `Versions[]` entry. The runbook's ownership check names the exceptions to the 1:1 premise
  (imported or explicitly named bucket) and asks for positive evidence (CloudTrail S3 data events
  or server access logs over a grace period); without it the marker is left alone. "Before a
  database restore" says how the mode takes effect (deploy, or scale to 0) and how to confirm
  the running task's mode. The release-image precondition and the waiter's failure path in
  `run_retention_once` are stated; uploads resume only after step 2 on a completed `deploy.sh`,
  and stay quiesced after a rolled-back one.


## D12 — Code review round 2 (testing) fixes

- **N1.** The keyset cursor query's size bound was unproven: the at-bound unit cell and the
  integration test both finished in one page. A unit cell with two at-bound blobs and a maximal
  ref at page size 1 expects `{ total: 3, dbStored: 2 }` and asserts three cursor queries ran
  (three bound values, `AND id >`); the integration test's first cell also runs
  `countDbStoredAttachments(prisma, 2)` and requires the default-page-size answer. Red-proved:
  `<` in the cursor query fails only the new unit cell; `<` in the first-page query fails the
  existing at-bound cell and the new one.
- **N2.** The unit fake's `sizeComparison` accepts only the exact predicate shape:
  `octet_length(encrypted_data)` directly after `WHERE` / `FILTER (WHERE`, one operator, then the
  bound as a bare `::int` followed by `)`, `AND id >` or `ORDER BY`. It throws otherwise, so
  `<= $bound::int - 1`, `> $bound::int - 1` and `WHERE NOT …` fail the unit tests (red-proved,
  each of the three, plus the cursor query's `- 1`).
- **N3.** The entrypoint cell seeds one database-stored row and one ref of its own and asserts
  `total > db_stored` (a field swap now fails on any table), asserts `run.error` is undefined
  before the status, and has a 90 s timeout above the child's 60 s.
- **N4.** `terraform test` runs `v_grace_above_max_fails` (3024000001) and
  `v_mode_unknown_fails` (`"purge"`), each `expect_failures = [var.x]`; 27 runs,
  `blob_sweep.runs.json` updated. Red-proved by removing the upper bound and by widening the enum.
- **N5.** `MAX_OBJECT_KEY_BYTES` is exported from `object-ref.ts` (it was private); the three
  store tests and `object-ref.test.ts` derive their maximal and over-the-bound keys from it, and
  one assertion pins its value (1024).
