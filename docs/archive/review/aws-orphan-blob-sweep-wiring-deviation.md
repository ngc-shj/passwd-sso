# Coding Deviation Log: aws-orphan-blob-sweep-wiring

## D1 — The C5 `name_prefix` precondition cannot fire

A `name_prefix` over 20 characters makes the provider reject the sibling rule
`-audit-anchor-publisher-role-task-definition` (44 characters, 64 limit) during validation, before
any precondition is evaluated. A `terraform test` `expect_failures` run therefore errors instead of
matching. The bound is checked in vitest (`blob-sweep-wiring.test.ts`, both sides of 20), and
`terraform test` has an allow run at exactly 20 characters (`c5_name_prefix_at_bound_plans`).
Whether the precondition stays is a code-review decision.

## D2 — Null-safe conditions written as conditionals

Precondition 4 and the grace validation use `x == null ? false : …` rather than `x != null && …`:
`required_version` is `>= 1.5`, and short-circuit evaluation of `&&` is only guaranteed from
Terraform 1.12.

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
branch's migrations. The other 85 gates pass.
