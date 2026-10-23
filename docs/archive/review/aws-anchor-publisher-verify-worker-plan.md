# Plan: aws-anchor-publisher-verify-worker

Issue: `#940`. Branch `feat/aws-anchor-publisher-verify-worker`, base `origin/main` 022ca4eac.
Revision 4 — after plan-review rounds 1–3. Round 3 showed the two-phase design of revision 3
kept its decision state in `system_settings` (writable by `passwd_app`) and admitted cross-
boundary and unlocked-phase forks; C2 is redesigned around the published objects as the source
of truth. (`aws-anchor-publisher-verify-worker-review.md`). It
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
- The published objects are the source of truth, not database state. The run holds a
  session-level advisory lock on a dedicated connection for its whole duration (acquired with a
  bounded wait; not acquired → `lock_held`, not a failure), so two runs never interleave.
- The database keeps one pointer, `audit_anchor_previous_manifest`, extended with the boundary
  it anchors (an existing pointer without one takes it from its key's date). It is trusted only
  after its object is read back from the primary destination and verified (signature with the
  publisher's own key, `anchoredAt`, deployment id, and its sha256) — `system_settings` is
  writable by `passwd_app`, so a database value alone never decides to skip or what to upload.
- Under the lock, for the boundary to publish:
  1. Walk forward from the pointer's boundary to this one (bounded, at most a year of
     boundaries): an object at a boundary's key that verifies and whose `previousManifest` is
     the current pointer is adopted — the pointer advances to it. This settles an upload whose
     database write never happened (a crash, a timeout, a task replaced mid-run), so the chain
     cannot fork. An object that does not verify, or chains elsewhere, is `ANCHOR_KEY_EXISTS`:
     alerted, nothing uploaded for that boundary.
  2. Pointer now at this boundary → `already_published` (decided from the verified object).
  3. Otherwise build and sign the manifest chained to the pointer and upload it with
     `If-None-Match: *` (bounded as a whole: attempts and backoff, by an abort signal). Created
     → in one transaction the pointer advances and `lastPublishedAt` is written. 412/409 → read
     the key (a 409 retried within the bound until the object is readable) and apply step 1's
     test to it.
  No pending record and no separate marker exist; the upload is outside any transaction.
- The primary destination is the first configured one that can read back (S3, filesystem).
  `AnchorDestination` gains `read(key)` and `upload` reports created/exists; the filesystem
  destination becomes create-only (`wx`). A deployment whose only destination cannot read back
  (GitHub) keeps today's database-pointer behaviour, stated in the docs (SC2).
- Adopted objects are also checked with `GetObjectRetention` (COMPLIANCE, retain-until at least
  the expected date) on S3; the role gains `s3:GetObjectRetention`.
- A failed run pauses at most until the next boundary.
- Budget: lock wait 10 s, upload bound 60 s, pointer transaction 10 s; the task's
  `stopTimeout` 120 s (the Fargate maximum) covers them; SIGTERM waits for the in-flight run.
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
- Task roles: the publisher's own, carrying only `s3:PutObject`, `s3:PutObjectRetention`,
  `s3:GetObject` and `s3:GetObjectRetention` (C2's read-back) on `bucket/<prefix>/*`; the verify
  worker gets none; the anchor policy leaves the shared role. The retention-GC worker keeps the
  shared role (it deletes attachment blobs when `S3_ATTACHMENTS_BUCKET` is set); the outbox
  worker keeps it too, though it gains only unused attachments access from it (the shared role
  has no Secrets Manager action) — per-worker roles are SC4.
- `enable_s3_audit_anchors` is validated true (the app already refuses to boot without a
  destination; the GitHub destination has no wiring — SC2).
- Monitoring: publisher down alarm sized past a deploy's zero-task gap; a healthy-cadence
  absence alarm (~25 h) on a `_logType` the publisher emits for `published`, an adoption, and
  `already_published` decided from a verified object (C2), and for `skipped_no_tenants` with the
  chain-enabled tenant count in the line and an alarm when it falls to 0 after being positive —
  not for paused, failed or `lock_held`; log metric filters on the publisher's failure lines, each given a `_logType`
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
  publisher role, against MinIO through `S3Destination` and against the create-only filesystem
  destination (`beforeAll` fails unless the only chain-enabled tenants are the test's; the
  pointer and deployment-id rows snapshotted and restored; far-future boundaries):
  - two runs for one boundary → one object, the second `already_published`;
  - crash after upload (the pointer transaction forced to fail by a `PublisherConfig` hook),
    then the next boundary's run → B_n adopted, B_{n+1} chained to it (asserted from
    B_{n+1}'s `previousManifest.sha256`), one object each — the round-3 fork case;
  - a pointer row moved to a future boundary or another sha (as `passwd_app` could) → not
    trusted: the run reads back, finds no matching verified object, and publishes or reports;
  - an unverifiable object at the key → `ANCHOR_KEY_EXISTS`, nothing uploaded, pointer
    unchanged;
  - a transaction-timeout/upload-bound case with injected bounds;
  - overlap: a second session holding the advisory lock → `lock_held` after the bounded wait,
    no failure emit, no pause; a run blocked mid-upload holds the lock (observed in `pg_locks`
    from another session) and a concurrent run waits;
  - red proofs: no read-back walk (crash case forks); trusting the pointer row (the moved-
    pointer case skips); a top-level `code` instead of `pgErrorCode` for the lock timeout
    (reports `failed`).
  Existing publisher tests add the new pointer field to their fixtures and cleanup and make their
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
| C2 | cadence correctness (explicit boundary, scheduler, published objects as truth, session lock, pause cap, deploys) | pending |
| C3 | S3 destination (bundled SDK, no overwrite, Object Lock, SSE-S3, policy, supply chain) | pending |
| C4 | bundles, smoke, in-image boot | pending |
| C5 | AWS wiring (tasks, roles, app secrets, alarms, deploy, CI) | pending |
| C6 | docs | pending |
