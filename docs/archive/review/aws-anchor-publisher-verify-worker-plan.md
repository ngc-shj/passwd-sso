# Plan: aws-anchor-publisher-verify-worker

Issue: `#940`. Branch `feat/aws-anchor-publisher-verify-worker`, base `origin/main` 022ca4eac.
Revision 2 — after plan-review round 1 (`aws-anchor-publisher-verify-worker-review.md`). It
replaces `aws-anchor-publisher-and-scram-verifier-plan.md`, whose `#941` half shipped in `#945`.

User decisions: the audit-chain verify worker is included and connects as `passwd_app`;
`@aws-sdk/client-s3` becomes a dependency, statically imported so esbuild bundles it; the
publisher runs as a long-lived ECS service with the replacement problems fixed in code; the
anchors bucket always has Object Lock; one PR.

## Project context

- Type: `mixed` (workers, Terraform, Dockerfile, CI, docs). Tests: unit + real-PostgreSQL
  integration + CI.
- Verification environment constraints:
  - E1 — no AWS environment runs. Terraform is gated by a new CI job (`fmt -check`,
    `init -backend=false`, `validate`); nothing is planned or applied. ECS deployment
    behaviour, IAM evaluation, bucket-policy conditions and Object Lock on real S3 are
    `blocked-deferred` to the next AWS bootstrap and listed with their checks in
    `aws-anchor-publisher-verify-worker-manual-test.md`. Everything in the publisher's own
    behaviour is tested locally.
  - E2 — MinIO stands in for S3, in CI too (a service container). Whether this MinIO
    release honours `If-None-Match: *` and Object Lock retention headers is checked first in
    Phase 2; a gap is recorded and the affected check moves to the manual test.

## Objective

Make external audit anchoring happen on AWS, correctly, and run the audit-chain verifier there.
Today production requires `AUDIT_ANCHOR_PUBLISHER_ENABLED=true` but no task publishes; a task
would crash at module load, could not write to S3, and would double-publish, skip or shift a
day across replacement, timer drift, a failed boot run or a slow upload. No deployment runs the
verifier.

## Contracts

### C1 — the publisher stands alone
- Its module graph does not reach `@/lib/prisma` (measured: only `@/lib/audit/audit` pulls it
  in). Audit emits go through a helper in `src/workers/audit-anchor-publisher.ts`: its own
  transaction under the existing `BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX` (`["auditOutbox"]`),
  payload from `buildOutboxPayload`, row written with `tx.auditOutbox.createMany` — no
  `RETURNING`, so the role's `INSERT` on `audit_outbox` suffices (`create()` would need
  `SELECT`). `tenantId` is fixed to `SYSTEM_TENANT_ID` inside the helper. It never throws:
  `auditLogger` emits the structured line as `logAuditAsync` does, and a failed write goes to
  `deadLetterLogger`. Emits that ran inside the publish transaction move after it.
  `AUDIT_ANCHOR_PUBLISH` is unchanged. The bypass gate's allowances for the publisher file
  gain the `AUDIT_WRITE` purpose if they lack it.
- Env: `DATABASE_URL` optional; production requires `AUDIT_ANCHOR_PUBLISHER_DATABASE_URL`, the
  signing key and the tag secret — requirements that move out of the app's schema (C5);
  `AUDIT_ANCHOR_PUBLISHER_ENABLED` parses `"false"` as false (today `z.coerce.boolean`).

### C2 — cadence correctness
- `runCadence(boundary)` publishes the boundary it is given; the scheduler computes it.
- Scheduler, extracted into an importable function with an injected clock and timer: at boot
  it awaits one run for the current boundary, then arms a `setTimeout` to the next boundary
  computed from the wall clock, and re-arms the same way after each run (no `setInterval`).
  SIGTERM stops arming and waits for an in-flight run before disconnecting.
- Inside the transaction: blocking `pg_advisory_xact_lock`, then the idempotency read of
  `system_settings.audit_anchor_last_published_boundary` (before the missing-prior safety
  net); equal → `skipped_already_published`. When the key is absent, it is derived from
  `MAX(last_published_at) >= boundary` so an upgraded install does not republish today.
  A publish writes it with the manifest pointer, through Prisma `upsert`.
- A failed run pauses at most until the next boundary.
- The publish transaction has an explicit timeout; the S3 client's request and connection
  timeouts are below it. The task's `stopTimeout` exceeds both.
- ECS: `deployment_maximum_percent = 100`, `deployment_minimum_healthy_percent = 0`,
  `desired_count = min(1, var.worker_desired_count)`.
- The first publish on a fresh install still reports `MISSING_PRIOR_CADENCE_PUBLICATION`;
  stated in the docs.

### C3 — S3 destination
- `@aws-sdk/client-s3`, a pinned dependency, imported statically by `s3-destination.ts` and
  bundled into the publisher. `OptionalModuleName` keeps it for `s3-blob-store.ts`.
- `S3Destination` takes client options (endpoint, path style, credentials) defaulting to `{}`.
- Every PUT sends `IfNoneMatch: "*"`. A 412 is a failure (`ANCHOR_KEY_EXISTS`), alerted, not a
  success: an anchor is never replaced. Recovery documented.
- Anchors bucket: Object Lock always on, default retention COMPLIANCE 2557 days; versioning;
  SSE-S3 (anchors are signed and tag-pseudonymised, and a deletable CMK could make locked
  evidence unreadable); a bucket policy denying a PUT without `s3:if-none-match`, a lock mode
  other than COMPLIANCE, or a retention above the default plus a margin.
- Existing anchors bucket: whether `object_lock_enabled` forces replacement in the provider
  in use is read from its schema in Phase 2; the docs give the procedure for the answer —
  never one that empties or recreates a bucket holding versions.
- Supply chain: the license allowlist, `check-crypto-auth-deps-classified.mjs` (SigV4 signing
  with task credentials) and `npm audit --omit=dev` (the only CVE gate for code esbuild
  inlines, which Trivy cannot see) are each run and their outcome recorded.

### C4 — bundles, the smoke, and the image
- Member set: the ECS task `command` entries plus `worker-policy-manifest.json` entrypoints —
  outbox, retention-GC, verify, publisher. The Dockerfile bundles and `COPY`s all four;
  `npm run worker:audit-anchor-publisher` added.
- `check-worker-bundle-smoke.sh`: extracts every esbuild invocation writing `dist/`; fails
  unless the member set, the esbuild set and the `COPY` set are equal; boots each bundle with
  `env -i` plus only the env names its task definition gives it (pinned to `ecs.tf` by a parser
  test that refuses HCL it does not model), from an empty temp cwd, and requires each bundle's
  positive marker (`env validation passed`; for the publisher also `destinations ready`).
  Override `WORKER_BUNDLE_SMOKE_DOCKERFILE` for fixtures.
- `container-scan` runs each of the four bundles inside the built image with
  `--validate-env-only` and its task env — the only check that sees what the runner stage
  ships.
- The verify worker gains `--validate-env-only` (URL present and parseable, numeric settings
  finite and positive) and an interruptible sleep.

### C5 — AWS wiring
- Task definitions, services, log groups, outputs for the publisher and the verify worker.
  Publisher: env `AUDIT_ANCHOR_PUBLISHER_ENABLED`, bucket, prefix; secrets
  `AUDIT_ANCHOR_PUBLISHER_DATABASE_URL`, signing key, tag secret, `DEPLOYMENT_ID`. Verify
  worker: `AUDIT_CHAIN_VERIFY_DATABASE_URL` from the app secret's `DATABASE_URL`.
- The app task no longer receives the signing key or the tag secret (C1 moved the requirement).
- Task roles: the publisher's own, carrying only `s3:PutObject` and `s3:PutObjectRetention` on
  `bucket/<prefix>/*`; the verify worker, the outbox worker and the retention-GC worker get
  none (none calls AWS); the shared role keeps only what the app uses.
- `enable_s3_audit_anchors` is validated true (the app already refuses to boot without a
  destination; the GitHub destination has no wiring — SC2).
- Monitoring: publisher down alarm sized past a deploy's zero-task gap; a published-absence
  alarm (~25 h); log metric filters on the publisher's failure lines, each given a `_logType`
  (`cadence_error` lacks one) and including `ANCHOR_KEY_EXISTS`; verify-worker heartbeat
  filters (`erroredTenantCount > 0`, `failedTenantCount > 0`, absence); both log groups in
  `rls_bypass_report_log_groups`; an EventBridge alarm on ECS `ExecuteCommand`.
- ECS Exec logging `NONE`, explicit: the bootstrap's operator shell holds role passwords; the
  remaining audit is CloudTrail `ExecuteCommand`, alarmed above.
- `scripts/deploy.sh` advances and rolls back six services.
- `DEPLOYMENT_ID`: a new app-secret key; reuse a stored value only for a successor of the same
  deployment whose predecessor is gone — a clone or restored copy generates a new one and
  follows the rotation runbook.
- CI: a terraform job (pinned `setup-terraform`); the app path filter includes
  `infra/terraform/*.tf` and `infra/terraform/README*.md`; a MinIO service in
  `ci-integration.yml`.

### C6 — docs
`docs/setup/aws/en.md`, `infra/terraform/README.md` and `README.ja.md` (key tables incl.
`VERIFIER_PEPPER_KEY`, `SMTP_USER`, `SMTP_PASS`, `DEPLOYMENT_ID`, and the ja table's missing
`AUDIT_ANCHOR_PUBLISHER_DATABASE_URL`), `docs/operations/deployment.md` (DEPLOYMENT_ID, bucket
procedure, first-publish report), `docs/operations/alerts.md`,
`docs/security/audit-anchor-verification.md` (one version per key; `LastModified` against the
boundary), `CLAUDE.md` (`worker:*`). The verify worker's `passwd_app` surplus stated fully
(reads every table, not only unused writes).

## Testing strategy

- C1: unit — the helper mocked per action (five sites: published, paused, failed after
  rollback, missing-prior, deployment-id mismatch); integration as a new
  `passwd_anchor_publisher` `TestRole` — the helper writes a row (allow) and a grant not naming
  `auditOutbox` is refused (deny); the failure-after-rollback and missing-prior paths leave an
  outbox row; an esbuild metafile check, reusing the smoke's Dockerfile-extracted args, that
  `src/lib/prisma.ts` is not an input (red: re-import `logAuditAsync`); a publisher env test
  in the retention-GC pattern (production with only `DATABASE_URL` → refused naming the
  dedicated URL; dedicated → 0; non-production fallback → 0; `"false"` → disabled).
- C2: the scheduler with an injected clock — the boot run precedes any timer; a timer firing
  1 ms early still publishes its boundary; re-arm from the wall clock; SIGTERM waits for the
  in-flight run. Integration, as the publisher role, with the global rows
  (`audit_anchor_last_published_boundary`, `…previous_manifest`, `…deployment_id`)
  snapshotted and restored and a far-future boundary: two runs publish once; a boot run after
  an unpublished boundary publishes; the absent-marker derivation; a failure pauses only to the
  next boundary; a transaction timeout below the upload's duration fails without a marker.
  Existing publisher tests add the new key to cleanup and make their fake key-aware; the race
  test accepts `skipped_already_published`.
- C3: integration against MinIO (CI service; fail loudly when absent, never skip): bucket
  created with Object Lock; `S3Destination.upload` through its options; `GetObjectRetention`
  is COMPLIANCE at the expected date; a second PUT to the key gets 412 and the publisher
  reports `ANCHOR_KEY_EXISTS`; the same PUT to a bucket without Object Lock is refused (the
  test tells the two apart). The unit test mocks `@aws-sdk/client-s3`; the old
  `requireOptionalModule` contract test is rewritten.
- C4: the smoke self-test on fixture Dockerfiles — a missing `COPY`, a missing esbuild, a
  member in neither, a bundle exiting 0 without its marker, a bundle reading `DATABASE_URL`
  its task lacks (passed explicitly to prove `env -i`) — each red; the real tree green; per-test
  timeouts set from a measurement. The `ecs.tf` parser asserts four worker task definitions and
  fails on unmodelled `concat`/ternaries. Verify worker: `--validate-env-only` allow/deny per
  axis from a temp cwd; SIGTERM during the sleep exits within seconds (red: plain
  `setTimeout`).
- C5: the terraform CI job; static pins with red fixtures (publisher percentages,
  `desired_count`, anchors Object Lock, SSE-S3, no `DeleteObject` / no GET in the publisher
  role, no task role on the three workers); `deploy-rollback.test.mjs` with six services,
  failures at the fifth and sixth, and every output name the stubbed `terraform` was asked for
  present in `outputs.tf`; `pool-factory.metric-filter.test.ts` with the new log groups; a
  metric-filter test that each new pattern matches a line the code really emits on its failure
  path and not its success line; a parser test that every `valueFrom` key is in both README
  tables and that no non-publisher task names the signing key or tag secret.
- C6: every documented command run once and recorded; the manual-test file lists each E1
  deferral with its command and expected observation.

## Considerations & constraints

- SC1 — publisher and verify worker in `docker-compose.workers.yml` / `infra/k8s/` (issue filed
  with the PR).
- SC2 — GitHub release destination wiring.
- SC3 — a dedicated read-only role for the verify worker (issue filed with the PR).
- `worker-policy-manifest.json`: the publisher's single-owner claim corrected to the mechanism;
  symbols cited, not line numbers; the boundary write is a Prisma `upsert` the sweep-bounds
  check accepts.

## User operation scenarios

- First AWS bootstrap: generate `DEPLOYMENT_ID`; app secret gets it and the publisher URL;
  apply; deploy; six services; the publisher's boot run publishes immediately (reporting the
  missing prior cadence once); the verifier's heartbeat appears hourly.
- Deploy across a boundary: the old publisher drains and stops before the new one starts; the
  new one's boot run publishes the boundary if it is unpublished, otherwise does nothing.
- An S3 hiccup on a boot run: one failure, paused only until the next boundary.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | publisher stands alone (no `@/lib/prisma`, own non-throwing audit path, env) | pending |
| C2 | cadence correctness (explicit boundary, scheduler, idempotency, pause cap, timeouts, deploys) | pending |
| C3 | S3 destination (bundled SDK, no overwrite, Object Lock, SSE-S3, policy, supply chain) | pending |
| C4 | bundles, smoke, in-image boot | pending |
| C5 | AWS wiring (tasks, roles, app secrets, alarms, deploy, CI) | pending |
| C6 | docs | pending |
