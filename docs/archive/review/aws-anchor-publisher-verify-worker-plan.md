# Plan: aws-anchor-publisher-verify-worker

Issue: `#940`. Branch `feat/aws-anchor-publisher-verify-worker`, base `origin/main` 022ca4eac.
Revision 1 of this plan; it replaces `aws-anchor-publisher-and-scram-verifier-plan.md` (whose
`#941` half shipped in `#945`) and answers that plan's round-1 review
(`aws-anchor-publisher-and-scram-verifier-review.md`).

User decisions: the audit-chain verify worker is included and connects as `passwd_app`;
`@aws-sdk/client-s3` becomes a dependency, statically imported so esbuild bundles it; the
publisher runs as a long-lived ECS service with the replacement problems fixed in code (not a
scheduled task); the anchors bucket always has Object Lock.

## Project context

- Type: `mixed` (workers, Terraform, Dockerfile, docs). Tests: unit + real-PostgreSQL
  integration + CI.
- Verification environment constraints:
  - E1 — no AWS environment runs. Terraform is checked by `terraform fmt -check` and
    `terraform validate` (with `init -backend=false`), run locally and recorded; nothing is
    planned or applied. ECS behaviour (deployment percentages, task replacement, IAM
    evaluation, S3 Object Lock acceptance) is `blocked-deferred` to the next AWS bootstrap; the
    code paths they exercise are tested locally (cadence idempotency and catch-up against the
    dev DB, the S3 PUT against MinIO with Object Lock, the bundles booted with each task's exact
    env).
  - E2 — MinIO is the local S3. Whether the existing S3 destination integration test runs
    depends on a MinIO container; the plan makes it run in CI or records why not (Phase 2).

## Objective

Make external audit anchoring actually happen on AWS, and run the audit-chain verifier there.
Today production validation requires `AUDIT_ANCHOR_PUBLISHER_ENABLED=true`, but no task
publishes; and if one did, it would crash at module load, could not reach S3 (no SDK in the
image, retention headers refused by a bucket without Object Lock, a missing IAM action), and
would double-publish or skip a day across task replacement. No deployment runs the verifier.

## Contracts

### C1 — the publisher stands alone
- The bundle's module graph does not reach `@/lib/prisma` (which builds the app pool at load
  and throws without `DATABASE_URL`). Audit emits go through the publisher's own pool: a helper
  opens its own transaction under a named bypass grant, builds the payload with
  `buildOutboxPayload` (`@/lib/audit/audit-payload`) and writes it with `enqueueAuditInTx`
  (`@/lib/audit/audit-outbox-in-tx`) — the prisma-free pair the operator CLI already uses.
  `passwd_anchor_publisher` already holds `INSERT` on `audit_outbox`; the grant used names
  `auditOutbox`. The structured log line `logAuditAsync` emits synchronously is kept as a
  `console` JSON line with `_logType`.
- Env: the publisher's schema makes `DATABASE_URL` optional and, under production, requires
  `AUDIT_ANCHOR_PUBLISHER_DATABASE_URL` — the refinement the outbox and retention-GC workers
  already have.
- Control class: fail-closed gate — the bundle smoke (C3) boots it with exactly the task's
  env, which has no `DATABASE_URL`.

### C2 — cadence under task replacement
- Idempotent per boundary: the publish transaction, after the advisory lock, reads
  `system_settings.audit_anchor_last_published_boundary`; equal to the current boundary →
  `skipped_already_published`, no upload. A successful publish writes it in the same
  transaction as the manifest pointer.
- Catch-up: at boot the publisher runs one cadence immediately, then aligns to the next
  boundary. Idempotency makes the boot run a no-op when the boundary is already published; a
  task replaced across a boundary publishes it on start. A boundary missed entirely (the task
  down longer than a cadence) stays missed; the next publish reports
  `MISSING_PRIOR_CADENCE_PUBLICATION` as today.
- ECS: the publisher service runs `deployment_maximum_percent = 100`,
  `deployment_minimum_healthy_percent = 0`, `desired_count = min(1, var.worker_desired_count)`.
  The advisory lock plus C2's idempotency cover any remaining overlap.
- `worker-policy-manifest.json`'s single-owner claim for the publisher is corrected to the
  mechanism above.

### C3 — bundles and the smoke that boots them
- Member set: `ls scripts/*-worker.ts scripts/*-publisher.ts` — outbox, retention-GC, verify,
  publisher. The Dockerfile bundles and `COPY`s all four; `npm run worker:audit-anchor-publisher`
  joins the `worker:*` scripts.
- `check-worker-bundle-smoke.sh` extracts every `npx esbuild scripts/… --outfile=dist/…` (not
  only `*-worker.ts`), and fails unless the filesystem member set, the esbuild set and the
  `COPY dist/*.js` set are equal. It boots each bundle from an empty temporary cwd (no `.env`)
  with exactly the env names its ECS task definition gives it (the map lives in the smoke and a
  test pins it to `ecs.tf`). A Dockerfile override (`WORKER_BUNDLE_SMOKE_DOCKERFILE`) makes the
  red proofs fixture-based.
- The publisher's `--validate-env-only` also constructs its destinations (so a missing SDK
  fails at boot, not at the first boundary). The verify worker gains `--validate-env-only`:
  a database URL (dedicated or fallback) present and parseable, numeric settings finite and
  positive.
- Control class: fail-closed gate (pre-pr + CI static job).

### C4 — S3 destination
- `@aws-sdk/client-s3` is a dependency, imported statically by `s3-destination.ts`, bundled into
  the publisher (it leaves `OptionalModuleName`; the blob stores keep loading theirs at runtime).
- The anchors bucket always has Object Lock (`object_lock_enabled = true`, decoupled from
  `enable_s3_object_lock`, which stays the attachments switch). It is a create-time attribute;
  for an existing anchors bucket the docs give the replacement procedure.
- The publisher's role gets `s3:PutObjectRetention` beside PUT/GET/LIST, no `DeleteObject`, and
  `kms:GenerateDataKey`/`kms:Decrypt` on `var.s3_kms_key_arn` when set.

### C5 — ECS (Terraform)
- Task definitions, services, log groups and outputs for `audit-anchor-publisher` and
  `audit-chain-verify-worker`, mirroring the existing workers except where C2 says otherwise.
- Publisher: environment `AUDIT_ANCHOR_PUBLISHER_ENABLED=true`, the S3 bucket; secrets
  `AUDIT_ANCHOR_PUBLISHER_DATABASE_URL`, `AUDIT_ANCHOR_SIGNING_KEY`, `AUDIT_ANCHOR_TAG_SECRET`,
  `DEPLOYMENT_ID`. Verify worker: secret `AUDIT_CHAIN_VERIFY_DATABASE_URL` from the app secret's
  `DATABASE_URL` key (`passwd_app`; it holds write privileges the read-only worker does not need
  — accepted, user decision; a dedicated read-only role is SC3).
- Task roles: the publisher gets its own role carrying only the anchor S3 policy (C4); the
  verify worker gets none. The anchor S3 policy leaves the shared task role — the app does not
  publish anchors, so this narrows it.
- `DEPLOYMENT_ID`: a new app-secret key, a UUID generated once; the docs check for an existing
  `system_settings.audit_anchor_deployment_id` first (restored or migrated data) and point to
  the rotation runbook's mismatch recovery.
- Monitoring: `RunningTaskCount` alarms for both; log metric filters and alarms for the
  publisher's `cadence_failed` / `upload_failed` (a running task that cannot publish is
  invisible to `RunningTaskCount`) and for the verify worker's heartbeat
  (`erroredTenantCount > 0`, `failedTenantCount > 0`, absence); both log groups join
  `rls_bypass_report_log_groups`.
- `scripts/deploy.sh` advances and rolls back all six services.
- ECS Exec on the cluster: `logging = "NONE"` stated explicitly — the RDS bootstrap has the
  operator export role passwords in that shell (round-1 S-A2 of the `#941` plan).
- The verify worker's sleep is interruptible, so SIGTERM ends it without waiting for the tick.

### C6 — docs
- `docs/setup/aws/en.md` (service table, keys), `infra/terraform/README.md` and `README.ja.md`
  (the secret key table, including the keys tasks already name but the docs omit:
  `VERIFIER_PEPPER_KEY`, `AUDIT_ANCHOR_SIGNING_KEY`, `AUDIT_ANCHOR_TAG_SECRET`, `SMTP_USER`,
  `SMTP_PASS`, and `DEPLOYMENT_ID`), `docs/operations/deployment.md`, `docs/operations/alerts.md`,
  `CLAUDE.md` (`worker:*` list). "No ECS task consumes it yet" goes.

## Testing strategy

- C1: integration — the publisher's audit emit helper writes an outbox row as
  `passwd_anchor_publisher` (real role, its own grant); a unit check that the publisher's esbuild
  metafile has no `src/lib/prisma.ts` input (red proof: re-import `logAuditAsync`).
- C2: integration against the dev DB on a throwaway deployment/boundary key — two `runCadence`
  calls for one boundary publish once (`skipped_already_published` second); a boot-time run
  after a boundary publishes; a boot-time run for an already-published boundary is a no-op.
  Red proofs: remove the idempotency read; remove the boot run.
- C3: the smoke's self-test (fixture Dockerfiles): a `COPY` missing, an esbuild missing, a
  filesystem worker missing from both, a bundle needing `DATABASE_URL` its task lacks — each
  red; the real tree green. The env map pinned to `ecs.tf` by a parser test. Verify worker
  `--validate-env-only` env test with allow/deny per axis (no URL, dedicated, fallback, NaN
  tick), run from a temp cwd.
- C4: the S3 destination integration test against MinIO with Object Lock enabled on its bucket
  (real SDK, no mock); its unit test stops mocking the module loader.
- C5: `terraform fmt -check` and `terraform validate` run and recorded (E1); a static test that
  every `terraform output -raw X` in `deploy.sh` exists in `outputs.tf`; `deploy-rollback.test.mjs`
  with six services and a failure on the fifth and sixth; `pool-factory.metric-filter.test.ts`
  with the two new log groups; every `valueFrom` key a task names is listed in the README key
  table (parser test).
- C6: every documented command run once and recorded.

## Considerations & constraints

- SC1 — publisher and verify worker in `docker-compose.workers.yml` and `infra/k8s/` — follow-up
  issue filed with the PR.
- SC2 — the GitHub release destination has no task wiring (`enable_s3_audit_anchors = false`
  leaves the publisher without a destination; it exits fatally at boot, visibly).
- SC3 — a dedicated read-only role for the verify worker.
- The verify worker as `passwd_app` reads every tenant's chain under named grants, as the
  maintenance endpoint can; its write privileges go unused.

## User operation scenarios

- First AWS bootstrap: generate `DEPLOYMENT_ID`, put it and the publisher URL in the app
  secret, apply, deploy; six services; the publisher publishes at its first boundary, the
  verifier's heartbeat appears hourly.
- A deploy at 23:59 before a boundary: the old publisher stops before the new one starts; the
  new one's boot run publishes the boundary if the old one did not.
- An existing anchors bucket without Object Lock: the docs' replacement procedure.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | publisher stands alone (no `@/lib/prisma`, own audit path, env) | pending |
| C2 | cadence idempotency, boot catch-up, no-overlap deploys | pending |
| C3 | four bundles, smoke over them with each task's env | pending |
| C4 | S3 SDK bundled, Object Lock, IAM | pending |
| C5 | ECS tasks/services/roles/alarms/deploy | pending |
| C6 | docs | pending |
