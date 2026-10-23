# Plan: aws-anchor-publisher-verify-worker

Issue: `#940`. Branch `feat/aws-anchor-publisher-verify-worker`, base `origin/main` 022ca4eac.
Revision 13 — after plan-review rounds 1–13 (round 13: one prose fix applied in place; plan review complete). Rounds 3–4 showed that hardening the publication
protocol itself (published objects as the source of truth, key rotation, a database-write
adversary, multiple destinations) is a design project of its own; by user decision it moves to
a follow-up issue (SC5) and this plan keeps today's protocol — the database pointer and an
in-transaction lock — fixing what running it on ECS exposes. It replaces
`aws-anchor-publisher-and-scram-verifier-plan.md`, whose `#941` half shipped in `#945`.

User decisions: the audit-chain verify worker is included and connects as `passwd_app`;
`@aws-sdk/client-s3` becomes a dependency, statically imported so esbuild bundles it; the
publisher runs as a long-lived ECS service with the replacement problems fixed in code; the
anchors bucket always has Object Lock; one PR; protocol hardening deferred (SC5).

## Project context

- Type: `mixed` (workers, Terraform, Dockerfile, CI, docs). Tests: unit + real-PostgreSQL
  integration + CI.
- Verification environment constraints:
  - E1 — no AWS environment runs. Terraform is gated by a new CI job (`fmt -check`,
    `init -backend=false`, `validate`, and in `modules/anchor-prefix` `init -backend=false` then
    `test -json` under `set -euo pipefail`, its output written to a file and its exit status
    checked on its own; a node check then requires exactly one `test_summary` record with
    `status: "pass"`, `failed` and `errored` 0, and `passed` equal to the number of vector
    entries with a Terraform verdict, counted from the vector file at run time — a missing or
    non-numeric summary fails. From the root, `terraform test` finds no test file and prints
    "0 passed" with exit 0, which is why the count is checked); nothing is planned or applied. ECS deployment
    behaviour, IAM evaluation, bucket-policy conditions and Object Lock on real S3 are
    `blocked-deferred` to the next AWS bootstrap and listed with their checks in
    `aws-anchor-publisher-verify-worker-manual-test.md`. Everything in the publisher's own
    behaviour is tested locally.
  - E2 — MinIO stands in for S3, in CI too (a service container). Whether this MinIO
    release honours the Object Lock retention headers is checked first in
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

### C2 — cadence correctness (today's protocol, run on ECS)
- `runCadence(boundary)` publishes the boundary it is given; the scheduler computes it. The
  boundary drives the idempotency marker, the artifact key and `anchoredAt`; the wall clock
  drives `lastPublishedAt`, the pause and the concurrent-success guard.
- Scheduler, extracted into an importable function with an injected clock and timer: at boot
  it awaits one run for the current boundary, then arms a `setTimeout` to the next boundary
  computed from the wall clock, and re-arms the same way after each run (no `setInterval`).
  SIGTERM stops arming and waits for an in-flight run before disconnecting.
- In the publish transaction (upload inside, as today): `SET LOCAL lock_timeout`, then a
  blocking `pg_advisory_xact_lock` (SQLSTATE 55P03, read with `pgErrorCode` → `lock_held`, not a
  failure); then the idempotency read of `system_settings.audit_anchor_last_published_boundary`
  — equal → `skipped_already_published` — before the missing-prior safety net. Absent: derived
  from `MAX(last_published_at) >= boundary`, so an upgraded install does not republish today. A
  publish writes the marker with the manifest pointer (Prisma `upsert`; the role holds
  INSERT/SELECT/UPDATE on `system_settings`).
- Crash or commit failure after a successful upload (or an upload aborted after S3 stored it):
  the transaction rolls back and the scheduler retries the same boundary every 15 min until
  30 min before the next boundary. Runs that pass the marker and tenant checks are counted per
  boundary in `system_settings.audit_anchor_upload_attempts` ({boundary, count}) — a run that
  fails before the upload (signing, a corrupt previous manifest) costs an attempt too, which is
  wanted: it would fail the same way again. The count is incremented in its own transaction,
  committed before the publish transaction opens: that transaction takes the same advisory-lock
  key (released at its commit; a run overlapping in the gap can only over-count, and the
  deployment percentages keep runs from overlapping), re-checks the marker, returns
  `skipped_no_tenants` without incrementing when no tenant is chain-enabled (so a deployment
  with nothing to publish never reaches the cap), and otherwise runs one upsert setting
  `count + 1` when the stored boundary matches and 1 otherwise, returning the result. Above 3
  the run uploads nothing —
  in-process retries and boot runs alike — so neither a rollback nor a crash after the PUT
  resets it, and a crash-looping task cannot lock more versions. Cap reached emits its own
  `_logType` (`audit-anchor-publisher.upload_cap_reached`), alarmed, and writes one
  `AUDIT_ANCHOR_PUBLISH_FAILED` row per boundary (the first run to see the cap; later runs log
  only), so a planted cap is visible the same day, not at the ~25 h absence alarm. The marker keeps a repeat idempotent, so the last PUT of the day is
  the committed version; versioning keeps the earlier ones. A task down for the rest of the day
  leaves an uncommitted latest version that the next manifest does not reference; the next
  publish reports it as `MISSING_PRIOR_CADENCE_PUBLICATION`.
- Pause: an upload failure persists one until the next boundary, as today, where it holds
  chain advancement in the outbox worker. Publishing no longer consults it: capped at the next
  boundary it could only ever block that boundary's own retries, so the filter and the
  `skipped_paused` outcome go (the `skipped_paused` unit test is deleted and the partial-pause
  test is rewritten — both tenants are published, no `AUDIT_ANCHOR_PUBLISH_PAUSED` emit;
  `AUDIT_ACTION.AUDIT_ANCHOR_PUBLISH_PAUSED` stays in the enum, groups and messages for
  historical rows and is no longer emitted; the outbox worker's comment saying the publisher
  emits it is corrected). `AUDIT_ANCHOR_PAUSE_CAP_FACTOR` and `PublisherConfig.pauseCapFactor`
  are removed with the 3× term, which can no longer bind (callers in the publisher, its CLI and
  the unit and integration tests updated). A success clears it as today. A post-upload commit failure writes
  no pause and emits its own `_logType` (`audit-anchor-publisher.commit_failed_after_upload`),
  alarmed.
- Each attempt that fails writes its `AUDIT_ANCHOR_PUBLISH_FAILED` row and failure line: at
  most 3 per boundary, plus the one cap-reached row.
- Budget: lock wait 10 s, S3 request/connection timeouts and an abort signal bounding the
  upload as a whole at 60 s, the publish transaction 90 s; `stopTimeout` 120 s (the Fargate
  maximum).
- ECS: `deployment_maximum_percent = 100`, `deployment_minimum_healthy_percent = 0`,
  `desired_count = min(1, var.worker_desired_count)`.
- First publish on a fresh install with chain-enabled tenants reports
  `MISSING_PRIOR_CADENCE_PUBLICATION` once; with none it returns `skipped_no_tenants` daily.
- The publisher keeps trusting `system_settings` for the pointer, as today (SC5). The new marker
  is a database-writable way to make runs skip, so no alarm treats a skip as healthy (C5).

### C3 — S3 destination
- `@aws-sdk/client-s3`, a pinned dependency, imported statically by `s3-destination.ts` and
  bundled into the publisher. `OptionalModuleName` keeps it for `s3-blob-store.ts`.
- `S3Destination` takes client options (endpoint, path style, credentials) defaulting to `{}`.
- No conditional write: a retry after a lost commit re-PUTs its key (C2). Preventing a
  compromised publisher from writing a new version of a past key is SC5.
- Anchors bucket: Object Lock always on, default retention COMPLIANCE 2557 days; versioning;
  SSE-S3 (anchors are signed and tag-pseudonymised, and a deletable CMK could make locked
  evidence unreadable); a bucket policy, each statement pinned by a static test:
  each `Deny` with `Principal: "*"` and an `ArnNotEquals aws:PrincipalArn` condition (a
  `NotPrincipal` would not match the task's assumed-role session and would deny the publisher
  too). The manifest key is built by one exported function (date + kid → key, and the prefix
  join), and the policy's manifest pattern is pinned to it by a test. Write paths are split by
  key shape, matching the rotation runbook's layout (the archive
  verifiers read sits next to the manifests): manifests `<prefix>/????-??-??.kid-*.jws` — only
  the publisher's task role; `<prefix>/key-rotation-*` and `<prefix>/public-keys/*` — only the
  break-glass operator role (a variable validated as a role ARN; empty → an unconditional Deny
  on those paths, never an empty condition list); the rest of the bucket — no one: an
  unconditional `s3:PutObject` Deny with `NotResource` listing only the manifest pattern and the
  two break-glass paths; `s3:PutObjectRetention` only the two roles
  (extend-only under COMPLIANCE and the cap); `s3:DeleteObject` and `s3:DeleteObjectVersion`
  denied with no exception (a delete marker would hide an anchor from a read by key);
  `s3:PutLifecycleConfiguration` denied on the bucket ARN (a bucket-level action; an expiration
  rule creates delete markers). The prefix is validated as one or more `/`-separated segments
  of `[A-Za-z0-9._-]`, none `.` or `..`: no `*` or `?`, which would widen every statement, and no
  leading, trailing or doubled `/`, which would make the runbook's and the verification doc's
  keys differ from the builder's. Terraform's `regex()` is RE2 (no lookahead; a lookahead
  pattern under `can()` refuses every value — checked with `terraform console`), so the rule is
  two RE2-safe parts: `can(regex("^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$", p)) &&
  alltrue([for s in split("/", p) : s != "." && s != ".."])`. It lives once, as the variable
  validation of a provider-less module `infra/terraform/modules/anchor-prefix` that the root
  passes the prefix through, so `terraform test` can exercise it without AWS credentials (it
  needs Terraform ≥ 1.6, which the CI job pins; the root's `required_version` is unchanged).
  The root prefix variable defaults to `"audit-anchors"` (the runbook's existing layout, so an
  existing environment's next plan needs no new value), described in its `variables.tf`
  `description`, `terraform.tfvars.example`, and a new "Audit anchor publisher" subsection of
  `infra/terraform/README.md` and `README.ja.md` (default and validation rule) — not the
  secret-key table, which lists Secrets Manager keys only. The root calls the module unconditionally with it, and the bucket
  policy and the task env read the prefix from the module's output (pinned statically, red: the
  call removed or given a constant; the default value pinned). The publisher's env schema applies the same segment rule
  in Zod only when the prefix is set and non-empty: an unset or empty prefix stays valid for
  non-Terraform deployments that write at the bucket root; non-empty is Terraform's alone,
  because the bucket policy needs it. The policy holds only as long as nobody
  replaces it — the account root always can — so changes to the anchors bucket's policy,
  lifecycle, Object Lock or versioning configuration are alarmed (an EventBridge rule on those
  CloudTrail events; a Terraform apply is the expected false positive), and the docs state the
  residual. `s3:PutObject` denied when
  `StringNotEquals s3:object-lock-mode = COMPLIANCE` (this also denies a PUT without the header,
  so the upload must keep sending it — stated in the code); `s3:PutObject` and
  `s3:PutObjectRetention` denied when `NumericGreaterThan
  s3:object-lock-remaining-retention-days` exceeds the default plus a margin; `s3:PutObject`
  denied when `s3:x-amz-server-side-encryption` is present and not `AES256`
  (`StringNotEqualsIfExists`). The runbook's operator writes (Step 4 advisory, Step 5 public key)
  use `aws s3api put-object` with the lock headers as the break-glass role and the configured
  prefix (not a hard-coded `audit-anchors/`), run in the manual test.
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
  `bucket/<prefix>/*`; the verify worker gets none; the anchor policy leaves the shared role.
  The retention-GC worker keeps the shared role (it deletes attachment blobs when
  `S3_ATTACHMENTS_BUCKET` is set); the outbox worker keeps it too, though it gains only unused
  attachments access from it (the shared role has no Secrets Manager action) — per-worker roles
  are SC4.
- `enable_s3_audit_anchors` is validated true (the app already refuses to boot without a
  destination; the GitHub destination has no wiring — SC2).
- Monitoring: publisher down alarm sized past a deploy's zero-task gap; a healthy-cadence
  absence alarm (~25 h) on a `_logType` the publisher emits only for `published` — each
  healthy boundary yields exactly one — and for `skipped_no_tenants` with `everChainEnabled:
  false`, decided from the absence of any `audit_chain_anchors` row (not a new setting); an
  alarm when the chain-enabled tenant count (carried in every cadence line) falls from positive
  to 0. A deliberate full disable leaves the absence alarm in ALARM — that is the state to see;
  the runbook says so; `skipped_already_published`, failed, `upload_cap_reached` and
  `lock_held` never count; an EventBridge alarm on the anchors bucket's configuration changes
  (C3); log metric filters on the publisher's failure lines (including `upload_cap_reached`),
  each given a `_logType`
  (`cadence_error` lacks one); verify-worker heartbeat
  filters (`erroredTenantCount > 0`, `failedTenantCount > 0`, absence); both log groups in
  `rls_bypass_report_log_groups`; an EventBridge rule on CloudTrail's ECS `ExecuteCommand`.
- ECS Exec logging `NONE`, explicit: the bootstrap's operator shell holds role passwords; the
  remaining audit is CloudTrail `ExecuteCommand`. EventBridge receives that only from an
  account with a trail logging management events; Terraform defines none, so a trail is a
  documented prerequisite (or an organisation trail) — with an S3 data-event selector on the
  anchors bucket, which records the break-glass role's writes — both checked in the manual test.
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
`docs/operations/audit-anchor-rotation-runbook.md`, `docs/security/audit-chain-threat-model.md`,
the verification doc's "Pause-window protection boundary" section and the publisher's
`retryPolicy`/`poisonMessageHandling` in `scripts/checks/worker-policy-manifest.json` (now the
15-min retry loop and the persisted cap)
(the pause now ends at the next boundary and no longer holds publishing — the "3× cadence = 72h"
cap and its paging text go; the threat model's 72 h figure is restated; the attempt cap and its
alarm are described),
`docs/security/audit-anchor-verification.md` (list every version of a key, not only the
latest; the authoritative version of a key is the one whose sha256 the next manifest's
`previousManifest` names — only for the newest key is it the latest version; other versions
created before the key's next boundary are retries; a version created later is a tamper signal
to report, never one to prefer; a key no manifest references is expected only with a
`MISSING_PRIOR_CADENCE_PUBLICATION` on the next publish, otherwise it is reported; a delete
marker on an anchor key is a tamper signal; the residual — a compromised publisher forging
within the same day — is SC5's), `CLAUDE.md` (`worker:*`). The verify worker's `passwd_app` surplus stated fully
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
  its boundary, including the day after a failure; wall-clock re-arm; the same-boundary retry
  after a commit failure and after an upload failure, its stop before the next boundary; SIGTERM waits for the in-flight run. Integration, as the publisher role
  (`beforeAll` fails unless the only chain-enabled tenants are the test's; the marker, pointer,
  deployment-id and `audit_anchor_upload_attempts` rows snapshotted and restored, and the
  attempts row deleted in every publisher test's `afterEach`; far-future boundaries; the cap
  and no-tenant cases assert the attempts row is absent at their start — red: the cleanup
  dropped and the cap case run before the lost-commit case, which then reports
  `upload_cap_reached`):
  - two runs for one boundary publish once;
  - the absent-marker derivation: `last_published_at` seeded at or after the boundary with no
    marker → `skipped_already_published`; seeded below → publishes (red: derivation removed);
  - lost commit: a `PublisherConfig` hook fails the commit after the upload; a test tenant's
    `chain_seq`/`prev_hash` is advanced; the retry for the same boundary publishes → on MinIO two
    versions with different sha256, the latest equal to the committed pointer's, the earlier not;
    the next boundary's `previousManifest.sha256` is the latest's; no pause written (red: write
    the pointer from the first attempt's sha);
  - upload aborted after the object was stored (MinIO wrapped so the PUT completes and the abort
    fires): a pause is written; a test tenant's chain is advanced; the same-boundary retry
    publishes → two versions with different sha256, the latest equal to the pointer;
    `publish_paused_until` is NULL afterwards (red: the success skips the clear);
  - the persisted attempt cap: three boots, each in a fresh module graph (`vi.resetModules()`),
    whose attempts fail after the PUT stored the object; after each the DB holds
    `{boundary, 1..3}`; a fourth reports `upload_cap_reached` without uploading, writing one
    failure row, and a fifth writes none (red: the increment written inside the publish
    transaction — the fourth still uploads; red: the count kept at module level). Allow case: at
    the next boundary the run reaches the upload with the count reset to 1;
  - every tenant paused: the run publishes (red: the filter restored → it skips);
  - no chain-enabled tenant, four boots in a day: each reports `skipped_no_tenants`, the count
    stays absent, no `upload_cap_reached` (red: increment before the tenant check);
  - a failure pauses only to the next boundary; injected transaction/upload bounds fail within
    the test budget;
  - overlap: A blocked mid-upload inside its transaction; its backend pid recorded by a test
    hook (`pg_backend_pid()` in the transaction); B observed waiting in `pg_locks` for that pid
    within a deadline; A released within B's injected `lock_timeout` → exactly
    `["published", "skipped_already_published"]` (red: no lock → the wait is never observed, the
    deadline fails the case; no marker read → two `published`);
  - `lock_held`: a second session holds `pg_advisory_lock` (released in `finally`), injected
    `lock_timeout` → `lock_held`, no failure emit, no pause (red: a top-level `code` read instead
    of `pgErrorCode` — the Prisma adapter nests 55P03 under `P2010` → `failed`).
  Existing publisher tests add the marker and the attempts row to cleanup and make their fake key-aware.
- C3: integration against MinIO (the CI step; fail loudly when absent, never skip), probed
  first on the CI digest for retention support (E2): bucket with Object
  Lock; `S3Destination.upload` through its options; `GetObjectRetention` COMPLIANCE at the
  expected date; the same PUT to a bucket without Object Lock is refused.
  Unit test mocks `@aws-sdk/client-s3`; the old contract test rewritten.
- C4: the smoke self-test on fixture Dockerfiles — a missing `COPY`, a missing esbuild, a
  member in neither, a bundle exiting 0 without its marker, a bundle reading `DATABASE_URL` its
  task lacks (passed explicitly to prove `env -i`) — each red; the real tree green; timeouts from
  a measurement. `container-scan` runs the same smoke in a docker-runner mode
  (`WORKER_BUNDLE_SMOKE_RUNNER=docker:<image>`, same env map and markers), with a self-test of
  that mode's argument construction. The `ecs.tf` parser asserts four worker task definitions
  and fails on unmodelled HCL. Verify worker: `--validate-env-only` allow/deny per axis from a
  temp cwd; SIGTERM during the sleep exits within seconds (red: plain `setTimeout`).
- C3/C5 key contract: a static test extracts the manifest `Resource` pattern from the bucket
  policy — both copies: the publisher-only statement's `Resource` and the catch-all's
  `NotResource` — asserts they are equal and that the `NotResource` list is exactly that pattern
  plus the two break-glass paths, and matches each copy as S3 does (`?` one character, `*` any
  sequence) against the exported key builder's output for a real kid and against
  `S3Destination`'s full key, and asserts neither matches the break-glass paths (red: a
  `YYYYMMDD` date; a pattern without the prefix; only the `NotResource` copy changed). Prefix
  validation, one vector file whose entries carry a verdict per validator
  (`{ value, terraform: allow|deny|n/a, zod: allow|deny }`): unset is Zod-allow/Terraform-n/a,
  `""` Zod-allow/Terraform-deny; `a`, `a/b`, `a.b`, `.a` allowed; `*`, `?`, `/a`, `a/`,
  `a//b`, `.`, `..`, `a/../b`, `a/./b` refused) run through both validators: `terraform test` in
  the module (`command = plan`, `expect_failures = [var.prefix]` per refused value) in the
  terraform CI job, and the Zod schema in vitest against the `zod` column; a static test asserts
  the `.tftest.hcl` run values equal the entries whose `terraform` verdict is not n/a, each with
  its verdict (red: the empty entry's Zod verdict flipped; red: the CI count check fed output
  without a summary record, and output with one run fewer than the vector — both fail; red: the
  lookahead form fails the allowed runs; red: a value dropped from the HCL).
- C5: the terraform CI job; static pins with red fixtures (publisher percentages,
  `desired_count`, anchors Object Lock, SSE-S3, each bucket-policy statement — `Principal: "*"`
  with `ArnNotEquals aws:PrincipalArn`, no `NotPrincipal`; red fixtures for a third principal, a
  wildcard, an empty break-glass ARN rendered as an empty condition list instead of an
  unconditional Deny, an empty prefix, a publisher allowed on a break-glass path or the reverse,
  a catch-all with a principal exception (the publisher writing `<prefix>/other` must be
  denied), a prefix with `*`, a lifecycle Deny on `bucket/*` instead of the bucket ARN, a
  missing delete Deny, and a principal exception on the lock-mode, retention-cap or SSE
  statements — the publisher
  role's two actions, no task role on the verify worker); `deploy-rollback.test.mjs` with six
  services, failures at the fifth and sixth, and every output name the stubbed `terraform` was
  asked for present in `outputs.tf`; `pool-factory.metric-filter.test.ts` with the new log
  groups; a metric-filter test that each new pattern matches a line the code really emits on
  its path and not the others (the healthy-cadence filter matches `published` and the
  never-enabled `skipped_no_tenants`, not `skipped_already_published`, `failed`,
  `upload_cap_reached` or `lock_held`; `skipped_no_tenants` with `everChainEnabled: false` matches and with `true` does
  not (red: a pattern without the field) — the derivation itself unit-tested with a fake
  returning zero and one `audit_chain_anchors` rows (red: hard-coded `false`; not isolatable on
  the shared integration database); the falls-to-zero alarm on a count going from 1 to 0;
  the `commit_failed_after_upload` alarm); a parser test that every `valueFrom` key is in both README
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
- SC6 — the rotation runbook names npm scripts that do not exist (`audit-anchor-kid`,
  `audit-anchor-rotation-advisory`, `audit-anchor-emit-rotation-event`,
  `audit-anchor-publish-pubkey`); this PR rewrites only the bucket writes of Steps 4–5 and
  marks the other steps as not yet automated (issue filed with the PR).
- SC5 — publication protocol hardening (issue filed with the PR, carrying rounds 3–4 of this
  plan's review): published objects as the source of truth, `If-None-Match` with adoption of a
  verified earlier upload, a pinned kid→key map across rotation and `DEPLOYMENT_ID` changes,
  binding the JWS header `kid` to the key name's in `verify()`, fail-closed on an unverifiable
  pointer, secondary destinations, a GitHub-only deployment's trusted pointer (and read-back via
  release assets), the verifier's one-version-per-key rule once overwrites are prevented, and
  the database-write adversary (today the publisher trusts `system_settings`).
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
- A commit lost after an upload: the scheduler retries the boundary within the day; the bucket
  keeps both versions, the latest is the one the chain points to.
- An S3 hiccup on a boot run: one failure; the 15-min retry publishes the boundary; the outbox
  chain advancement is held only until then.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | publisher stands alone (no `@/lib/prisma`, own non-throwing audit path, env) | pending |
| C2 | cadence correctness on today's protocol (explicit boundary, scheduler, marker, pause cap, budget, deploys) | pending |
| C3 | S3 destination (bundled SDK, Object Lock, SSE-S3, policy, supply chain) | pending |
| C4 | bundles, smoke, in-image boot | pending |
| C5 | AWS wiring (tasks, roles, app secrets, alarms, deploy, CI) | pending |
| C6 | docs | pending |
