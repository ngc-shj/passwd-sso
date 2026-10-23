# Plan: aws-anchor-publisher-verify-worker

Issue: `#940`. Branch `feat/aws-anchor-publisher-verify-worker`, base `origin/main` 022ca4eac.
Revision 3 — after plan-review rounds 1–2 (`aws-anchor-publisher-verify-worker-review.md`). It
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
  `AUDIT_ANCHOR_PUBLISH` is unchanged; the publisher file has no `ALLOWED_PURPOSES` entry, so
  none is added (an entry would narrow it).
- Env: `DATABASE_URL` optional; production requires `AUDIT_ANCHOR_PUBLISHER_DATABASE_URL`, the
  signing key and the tag secret — requirements that move out of the app's schema and out of
  the app's boot-time key validation (`EnvKeyProvider.validateKeys`,
  `base-cloud-provider.validateKeys`, which load both keys whenever the publisher flag is on;
  the publisher reads its keys from its own env, not the key provider), with the `KeyName`
  contract in `boot-public-contract.d.txt` and the provider tests updated (C5);
  `AUDIT_ANCHOR_PUBLISHER_ENABLED` parses `"false"` as false (today `z.coerce.boolean`).

### C2 — cadence correctness
- `runCadence(boundary)` publishes the boundary it is given; the scheduler computes it. The
  boundary drives the idempotency marker, the artifact key and `anchoredAt`; the wall clock
  drives `lastPublishedAt`, the pause filter, the pause cap and the concurrent-success guard.
- Scheduler, extracted into an importable function with an injected clock and timer: at boot
  it awaits one run for the current boundary, then arms a `setTimeout` to the next boundary
  computed from the wall clock, and re-arms the same way after each run (no `setInterval`).
  SIGTERM stops arming and waits for an in-flight run before disconnecting.
- Two phases, the upload between them and outside any transaction:
  - A (one transaction, `lock_timeout` set, SQLSTATE 55P03 → `lock_held`, not a failure):
    `pg_advisory_xact_lock`; the idempotency read of
    `system_settings.audit_anchor_last_published_boundary` — equal → `skipped_already_published`
    (absent: derived from `MAX(last_published_at) >= boundary`, so an upgraded install does not
    republish today) — before the missing-prior safety net; a `pending` record for this
    boundary is reused if present, otherwise the manifest is built, signed and stored as
    `audit_anchor_pending_publication` (boundary, key, sha256, the artifact bytes).
  - Upload: bounded as a whole (attempts and backoff included) by an abort signal.
  - On 412 or 409: a read of the key (the role's only GET, scoped to the prefix); identical
    bytes to the pending record → our own earlier upload, continue; different → failure
    `ANCHOR_KEY_EXISTS`, alerted.
  - B (one transaction): marker, manifest pointer and `lastPublishedAt` written, pending
    cleared by an `upsert` to an empty value — the role holds INSERT/SELECT/UPDATE on
    `system_settings` (manifest-checked), not DELETE, and gains none.
  A crash between phases leaves the pending record; the next run (boot or boundary) re-uploads
  the same bytes, meets 412, finds them identical and completes B — the manifest chain cannot
  fork.
- A failed run pauses at most until the next boundary.
- The task's `stopTimeout` exceeds the upload bound and both transactions.
- ECS: `deployment_maximum_percent = 100`, `deployment_minimum_healthy_percent = 0`,
  `desired_count = min(1, var.worker_desired_count)`.
- The first publish on a fresh install with chain-enabled tenants reports
  `MISSING_PRIOR_CADENCE_PUBLICATION` once; with none it returns `skipped_no_tenants` daily.
  Both stated in the docs.

### C3 — S3 destination
- `@aws-sdk/client-s3`, a pinned dependency, imported statically by `s3-destination.ts` and
  bundled into the publisher. `OptionalModuleName` keeps it for `s3-blob-store.ts`.
- `S3Destination` takes client options (endpoint, path style, credentials) defaulting to `{}`.
- Every PUT sends `IfNoneMatch: "*"`; 412/409 handled as in C2. An anchor is never replaced.
  A key squatted by someone with PUT access (a compromised publisher) blocks that date until the
  signing key rotates (a new kid, new key names) — the documented recovery.
- Anchors bucket: Object Lock always on, default retention COMPLIANCE 2557 days; versioning;
  SSE-S3 (anchors are signed and tag-pseudonymised, and a deletable CMK could make locked
  evidence unreadable); a bucket policy, each statement pinned by a static test:
  `s3:PutObject` denied when `Null s3:if-none-match = true`; `s3:PutObject` denied when
  `StringNotEquals s3:object-lock-mode = COMPLIANCE` (this also denies a PUT without the header,
  so the upload must keep sending it — stated in the code); `s3:PutObject` and
  `s3:PutObjectRetention` denied when `NumericGreaterThan
  s3:object-lock-remaining-retention-days` exceeds the default plus a margin; `s3:PutObject`
  denied when `s3:x-amz-server-side-encryption` is present and not `AES256`.
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
- Task roles: the publisher's own, carrying only `s3:PutObject`, `s3:PutObjectRetention` and
  `s3:GetObject` (for C2's 412 check) on `bucket/<prefix>/*`; the verify worker gets none; the
  anchor policy leaves the shared role. The outbox and retention-GC workers keep the shared
  role: retention-GC deletes attachment blobs when `S3_ATTACHMENTS_BUCKET` is set and the outbox
  worker reads Secrets Manager under `KEY_PROVIDER=aws-sm` — splitting their roles is SC4.
- `enable_s3_audit_anchors` is validated true (the app already refuses to boot without a
  destination; the GitHub destination has no wiring — SC2).
- Monitoring: publisher down alarm sized past a deploy's zero-task gap; a healthy-cadence
  absence alarm (~25 h) on a `_logType` the publisher emits for `published`,
  `skipped_no_tenants` and `skipped_already_published` (not for paused, failed or `lock_held`); log metric filters on the publisher's failure lines, each given a `_logType`
  (`cadence_error` lacks one) and including `ANCHOR_KEY_EXISTS`; verify-worker heartbeat
  filters (`erroredTenantCount > 0`, `failedTenantCount > 0`, absence); both log groups in
  `rls_bypass_report_log_groups`; an EventBridge rule on CloudTrail's ECS `ExecuteCommand`.
- ECS Exec logging `NONE`, explicit: the bootstrap's operator shell holds role passwords; the
  remaining audit is CloudTrail `ExecuteCommand`. EventBridge receives that only from an
  account with a trail logging management events; Terraform defines none, so a trail is a
  documented prerequisite (or an organisation trail), checked in the manual test.
- `scripts/deploy.sh` advances and rolls back six services.
- `DEPLOYMENT_ID`: a new app-secret key; reuse a stored value only for a successor of the same
  deployment whose predecessor is gone — a clone or restored copy generates a new one and
  follows the rotation runbook.
- CI: a terraform job (pinned `setup-terraform`) triggered by `infra/terraform/**` (incl.
  `envs/`, the lock file) and its workflow file, with the other jobs' `always()` guard; the app
  path filter includes `infra/terraform/*.tf` and `infra/terraform/README*.md`; MinIO started in
  `ci-integration.yml` by a step (`docker run … server /data`, digest-pinned to the compose
  image, readiness on `/minio/health/ready`) — a service container cannot pass `server /data`.

### C6 — docs
`docs/setup/aws/en.md`, `infra/terraform/README.md` and `README.ja.md` (key tables incl.
`VERIFIER_PEPPER_KEY`, `SMTP_USER`, `SMTP_PASS`, `DEPLOYMENT_ID`, and the ja table's missing
`AUDIT_ANCHOR_PUBLISHER_DATABASE_URL`), `docs/operations/deployment.md` (DEPLOYMENT_ID, bucket
procedure, first-publish report), `docs/operations/alerts.md`,
`docs/security/audit-anchor-verification.md` (one version per key; `LastModified` against the
boundary), `CLAUDE.md` (`worker:*`). The verify worker's `passwd_app` surplus stated fully
(reads every table, not only unused writes).

## Testing strategy

- C1: unit — the helper mocked per action (five sites); integration as a new
  `passwd_anchor_publisher` `TestRole`: the helper writes a row; the grant assertion is by
  bypass notices (enforcement is report-mode): `AUDIT_WRITE_DIRECT_OUTBOX` yields none, a grant
  without `auditOutbox` yields one for `audit_outbox` — with no `app.tenant_id` matching the row,
  so the tenant branch of the policy cannot admit it; the failure and missing-prior paths leave
  an outbox row. Test rows carry a per-run metadata nonce; `afterEach` (superuser) marks them
  `FAILED` and deletes them so no PENDING `__system__` row is left. An esbuild metafile check,
  reusing the smoke's Dockerfile-extracted args, that `src/lib/prisma.ts` is not an input (red:
  re-import `logAuditAsync`); a publisher env test in the retention-GC pattern; the app's
  key-provider `validateKeys` with the app task's env (publisher flag on, no anchor keys)
  succeeds, for both providers.
- C2: the scheduler with an injected clock — boot run first; a timer 1 ms early still publishes
  its boundary; wall-clock re-arm; SIGTERM waits for the in-flight run. Integration, as the
  publisher role: `beforeAll` fails unless the only chain-enabled tenants are the test's (so a
  far-future boundary cannot move a real anchor), and the global rows (`…last_published_boundary`,
  `…pending_publication`, `…previous_manifest`, `…deployment_id`) are snapshotted and restored;
  two runs publish once; the boot-run catch-up; the absent-marker derivation; a crash after the
  upload (destination succeeds, phase B forced to fail) then a rerun → one object, the chain
  linked, no `ANCHOR_KEY_EXISTS`; a different object at the key → `ANCHOR_KEY_EXISTS`; a failure
  pauses only to the next boundary; transaction and upload timeouts are `PublisherConfig`
  fields, so a 500 ms bound against a 1.5 s destination fails within the test budget. The race
  test proves overlap: while A holds the lock (its upload held on a deferred), B is observed in
  `pg_locks` waiting; then exactly `["published", "skipped_already_published"]`; with
  `lock_timeout` below the hold, `lock_held`. Red proofs: no lock → two `published`; no marker
  read → two `published`. Existing publisher tests add the new keys to cleanup and make their
  fake key-aware.
- C3: integration against MinIO (the CI step; fail loudly when absent, never skip), probed
  first on the CI digest for `If-None-Match` and retention support (E2): bucket with Object
  Lock; `S3Destination.upload` through its options; `GetObjectRetention` COMPLIANCE at the
  expected date; a second PUT gets 412; the same PUT to a bucket without Object Lock is refused.
  Unit test mocks `@aws-sdk/client-s3`; the old contract test rewritten.
- C4: the smoke self-test on fixture Dockerfiles — a missing `COPY`, a missing esbuild, a
  member in neither, a bundle exiting 0 without its marker, a bundle reading `DATABASE_URL` its
  task lacks (passed explicitly to prove `env -i`) — each red; the real tree green; timeouts from
  a measurement. `container-scan` runs the same smoke in a docker-runner mode
  (`WORKER_BUNDLE_SMOKE_RUNNER=docker:<image>`, same env map and markers), with a self-test of
  that mode's argument construction. The `ecs.tf` parser asserts four worker task definitions
  and fails on unmodelled HCL. Verify worker: `--validate-env-only` allow/deny per axis from a
  temp cwd; SIGTERM during the sleep exits within seconds (red: plain `setTimeout`).
- C5: the terraform CI job; static pins with red fixtures (publisher percentages,
  `desired_count`, anchors Object Lock, SSE-S3, each bucket-policy statement, the publisher
  role's three actions, no task role on the verify worker); `deploy-rollback.test.mjs` with six
  services, failures at the fifth and sixth, and every output name the stubbed `terraform` was
  asked for present in `outputs.tf`; `pool-factory.metric-filter.test.ts` with the new log
  groups; a metric-filter test that each new pattern matches a line the code really emits on
  its path and not the others (the healthy-cadence filter matches `published` and
  `skipped_no_tenants`, not `failed`); a parser test that every `valueFrom` key is in both README
  tables and that no non-publisher task names the signing key or tag secret.
- C6: every documented command run once and recorded; the manual-test file lists each E1
  deferral (incl. the trail prerequisite: an exec session produces the SNS notification) with
  its command and expected observation.

## Considerations & constraints

- SC1 — publisher and verify worker in `docker-compose.workers.yml` / `infra/k8s/` (issue filed
  with the PR).
- SC2 — GitHub release destination wiring.
- SC3 — a dedicated read-only role for the verify worker (issue filed with the PR).
- SC4 — per-worker task roles for the outbox and retention-GC workers (issue filed with the PR).
- `worker-policy-manifest.json`: the publisher's single-owner claim corrected to the mechanism;
  symbols cited, not line numbers; the boundary write is a Prisma `upsert` the sweep-bounds
  check accepts.

## User operation scenarios

- First AWS bootstrap: generate `DEPLOYMENT_ID`; app secret gets it and the publisher URL;
  apply; deploy; six services; with no chain-enabled tenant the publisher reports
  `skipped_no_tenants` daily (healthy); once a tenant enables the chain, the next run publishes
  and reports the missing prior cadence once; the verifier's heartbeat appears hourly.
- Deploy across a boundary: the old publisher drains and stops before the new one starts; the
  new one's boot run publishes the boundary if it is unpublished, otherwise does nothing.
- An S3 hiccup on a boot run: one failure, paused only until the next boundary.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | publisher stands alone (no `@/lib/prisma`, own non-throwing audit path, env) | pending |
| C2 | cadence correctness (explicit boundary, scheduler, two-phase publish, idempotency, pause cap, deploys) | pending |
| C3 | S3 destination (bundled SDK, no overwrite, Object Lock, SSE-S3, policy, supply chain) | pending |
| C4 | bundles, smoke, in-image boot | pending |
| C5 | AWS wiring (tasks, roles, app secrets, alarms, deploy, CI) | pending |
| C6 | docs | pending |
