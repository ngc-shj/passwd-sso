# Coding Deviation Log: aws-anchor-publisher-verify-worker

### D1: body-parser override bumped; stale braces suppression removed

- **Plan**: only `@aws-sdk/client-s3` is added.
- **Actual**: `overrides.body-parser` `^2.3.0` → `^2.4.0` (resolves to 2.4.0); the
  GHSA-vfj7-8cjw-p6xm (braces) suppression is deleted.
- **Reason**: `node scripts/checks/check-npm-audit.mjs` (CI's dev-scope gate) failed on the
  pre-change lockfile too: GHSA-27r3-jxmh-p828 (body-parser <2.4.0, high, dev chain
  shadcn → `@modelcontextprotocol/sdk` → express) has a fixed release, and the braces entry
  matches no current advisory, which the gate refuses. A defect found mid-task, fixed in a
  separate commit. Gate exit 0 afterwards; its self-test passes.
- **Impact**: dev-scope tree only (body-parser is reached through shadcn's MCP SDK).

### D2: MinIO needs a KMS key for SSE-S3

- **Plan**: C3 sends `ServerSideEncryption: AES256`; C5's MinIO step is `docker run … server /data`.
- **Actual**: the CI step sets a per-run `MINIO_KMS_SECRET_KEY`; the compose `minio` service
  generates one at each start (entrypoint `sh -c`), nothing stored in the repository.
- **Reason**: measured — without a KMS key MinIO answers 501 "Server side encryption
  specified but KMS is not configured" to every PUT carrying the header.
- **Impact**: integration tests only; `docker-compose.override.yml` gains the entrypoint.

### D3 (superseded, see D8): scheduler retries only `upload` and `after_upload` failures in-process

- **Plan**: retry the same boundary after a commit failure or an upload failure.
- **Actual**: a `before_upload` failure (signing, corrupt previous manifest) is not retried
  in-process; it still costs an attempt and the next boundary or a boot run tries again.
- **Reason**: matches the plan's own rationale that a pre-upload failure "would fail the same
  way again".

### D4: attempt count written with Prisma `findUnique` + `upsert`, not one raw upsert

- **Plan**: "one upsert setting `count + 1` … returning the result".
- **Actual**: read then Prisma `upsert`, under the advisory lock every publisher run takes.
- **Reason**: `worker-policy-manifest.test.ts` sweepBounds refuses raw `INSERT … ON CONFLICT DO
  UPDATE`; the lock makes the read-then-write atomic with respect to other runs. A stored
  value that does not parse fails the run (`before_upload`) without resetting the count.

### D5: production publisher URL has no DATABASE_URL fallback

- **Plan**: production requires `AUDIT_ANCHOR_PUBLISHER_DATABASE_URL`.
- **Actual**: as planned; outside production `DATABASE_URL` remains the fallback. Recorded
  because the old script fell back in every environment.

### D6: batch 3 additions beyond the plan's lists

- `AWS_REGION` in the publisher's task env: the S3 client refuses to send without a region.
- `lifecycle { prevent_destroy = true }` on the anchors bucket: the aws provider (v6.32.1,
  `internal/service/s3/bucket.go`) marks `object_lock_enabled` ForceNew, so turning it on for
  an existing bucket plans a replacement; the guard makes such a plan fail instead. The docs
  give the in-place procedure (`put-object-lock-configuration` on the versioned bucket first).
- Variables `audit_anchor_break_glass_role_arn` (validated role ARN, default empty →
  unconditional Deny) and `audit_anchor_object_lock_days` (default 2557, validated ≥ 2557);
  outputs `audit_anchors_bucket_name`, `audit_anchor_s3_prefix`,
  `audit_anchor_publisher_task_role_arn` for the runbook.
- The publisher role has no `GetObject`/`ListBucket` (the old shared policy had them).
- `.gitignore`: `infra/terraform/.terraform/` widened to `infra/terraform/**/.terraform/`, since
  the module's `terraform init` creates one.
- The app CI path filter also includes `infra/terraform/modules/anchor-prefix/**`, because
  vitest reads its vector file and `.tftest.hcl`.
- Not changed: `envs/*/terraform.tfvars.example` — the prefix default suffices.

### D7: batch 2 choices

- The smoke's per-task env map is checked in (`scripts/checks/worker-bundle-smoke.json`) and
  pinned to `ecs.tf` by a test through the HCL evaluator, not generated at run time:
  `container-scan` installs neither tsx nor the repo's dependencies.
- The docker-runner mode boots in the image's WORKDIR `/app` (what ECS runs from), not an
  empty temp cwd; the metafile forbidden-input check runs in host mode only, since docker mode
  boots already-built bundles.
- The verify worker also requires `AUDIT_CHAIN_VERIFY_MAX_ROWS` to be a safe positive integer
  (it is a SQL `LIMIT`; a fraction would fail every tick).
- `_logType` constants (`PUBLISHER_LOG_TYPE`, `SCHEDULER_LOG_TYPE`) were inlined as literals:
  `check-worker-logtype.mjs` reads only string literals.

### D8: every failed run is retried; anchors read in tenant-id order (found while documenting)

- **Was (D3)**: a `before_upload` failure was not retried in-process, so a transient database
  outage at the boundary cost the whole day.
- **Now**: any `failed` outcome is retried every 15 min until 30 min before the next boundary
  (the plan's wording); the persisted cap bounds a deterministic failure at three runs.
  `lock_held` and `upload_cap_reached` are not retried.
- The manifest's anchors are read `orderBy: { tenantId: "asc" }`, so a retry over an unchanged
  chain signs the same bytes (an unordered read returned heap order).
- Red proofs on a scratchpad copy: the old `isRetryable` fails the new scheduler test; dropping
  `orderBy` fails the tenant-order integration test.
- `audit_anchor_object_lock_days`'s description no longer claims leap days: the publisher's
  retain-until is 7 × 365 = 2555 days, under the 2557 default.

### D9: accepted code behaviour recorded by the docs batch

- The chain-enabled-fell-to-zero alarm is level-triggered (every `skipped_no_tenants` run with
  count 0 and `everChainEnabled: true`), not edge-triggered; CloudWatch notifies on the state
  transition, so it is one notification per disable.
- `previousManifest.uri` is `s3-object-lock://<artifactKey>` without the prefix, and its
  `sha256` is over the canonical payload, not the object bytes; documented in the verification
  doc. Changing either is a protocol change (SC5).
- No application path writes `tenants.audit_chain_enabled`; a disable is a direct database
  change, as before this PR.

### D10: CI-only gates run by hand (parity disposition)

Exit status 0 for each, run on HEAD before push: `npm run licenses:check:strict`,
`npm run licenses:check:cli:strict`, `npm run licenses:check:ext:strict`,
`node scripts/checks/check-npm-audit.mjs`, `bash scripts/check-state-mutation-centralization.sh`;
`terraform fmt -check -recursive`, root `validate`, the module's `terraform test -json` and
`check-terraform-test-count.mjs` (15/15). `scripts/pre-pr.sh`: 85 passed. CLAUDE.md gained the
two `worker:*` lines with the user's approval.

### D11: Phase 2 self-check fixes (F1, S1, S2, T1–T6)

- **F1 — failures before the attempt count were never capped.** Was: a throw in `claimAttempt`
  before the count upsert returned `failed`/`before_upload` uncounted, and the scheduler (any
  `failed` is retryable) re-ran it every 15 min (~94 rows a day); an `audit_anchor_upload_attempts`
  value that did not parse failed every run and was left in place, wedging every boundary.
  Now: (a) an unparseable stored count (JSON or schema, `parseUploadAttempts`) is overwritten in
  the same claim transaction with `{boundary: <this boundary>, count: AUDIT_ANCHOR_UPLOAD_ATTEMPT_CAP + 1}`
  and the run returns `upload_cap_reached`; its `upload_cap_reached` line carries
  `countUnreadable: true` and its one row `failureReason: UPLOAD_ATTEMPT_COUNT_UNREADABLE`. The
  next boundary counts 1 and recovers by itself. (b) The scheduler retries a boundary at most
  `ANCHOR_MAX_RETRIES_PER_BOUNDARY` (3) times per process whatever the stage, then logs
  `audit-anchor-publisher.retries_exhausted` (warn). The documented bound is now: at most 3
  counted runs per boundary across restarts plus the one cap row; uncounted failures add at most
  1 + 3 runs' rows per boundary per process start (alerts.md, worker-policy-manifest.json, the
  runbook, the verification and threat-model docs). This supersedes D8's "until 30 min before
  the next boundary" as the only retry bound.
- **S1 — replication actions bypassed the bucket policy.** The write Denies name `s3:PutObject`;
  a replica is written under `s3:ReplicateObject`/`ReplicateDelete`/`ReplicateTags`. Added
  `DenyReplicationWrite` (unconditional, `bucket/*`; the bucket is never a replication
  destination), pinned in `audit-anchor-wiring.test.ts` with three red fixtures (removed, tags
  left open, a principal exception). The storage.tf and iam.tf comments now claim only what the
  policy enforces; the Terraform READMEs list the statement and M3 gained a replication probe.
- **S2 — retention constant not tied to Terraform.** `audit-anchor-key-contract.test.ts` now
  checks `AUDIT_ANCHOR_RETENTION_YEARS × 365` (S3Destination's retain-until formula) against
  the `audit_anchor_object_lock_days` default, its validation (which must refuse one day less),
  and `local.audit_anchor_retention_cap_days` (which must admit a 366-day-year retain-until).
- **T4** — main's FR7 (key rotation overlap) and FR8 (chain_seq regression) `it.todo` stubs are
  restored at the bottom of `audit-anchor-publisher.integration.test.ts`, with a
  DESTINATION_DIVERGENCE `it.todo` that the GitHub Release destination test's pointer now names.
- T1 (overlap test releases run A in `finally`; the SIGTERM test's child is killed in
  `afterEach`), T2 (`versionsOf` picks the latest by `IsLatest`), T3 (`..a`, `a..b`, `a/..b`
  allow vectors; module test 18/18), T5 (duplicate env case removed), T6 (publisher `SETTING_*`
  keys exported, including the new `SETTING_DEPLOYMENT_ID` used in its SQL, and imported by the
  integration fixtures).

### D12: Phase 3 round-1 fixes (SF-1…SF-12, ST-5…ST-10)

- **SF-1 — `lock_held` is retried and alarmed.** Was: not retried, info only, "the other run
  publishes". Any role that can connect can hold `hashtext('audit-anchor-publish')`, so the
  holder is not assumed to publish. Now `isRetryable` admits `lock_held` under the same 15-min
  interval, 30-min stop window and per-process bound; the marker re-check turns the retry into
  `skipped_already_published` when the holder did publish. `audit-anchor-publisher.lock_held`
  joined the alarmed failure log types (on ECS it never occurs legitimately). The holder query
  in alerts.md was run against the dev database: the one-argument lock is the `bigint` overload
  (`hashtext` is `int4`, widened), stored with `objsubid = 1`, `classid` = the key's high 32 bits
  (0 here: `hashtext('audit-anchor-publish') = 1242793212`) and `objid` its low 32 bits. The
  documented query pins all three; the db-integration lock_held case runs it against a holder.
- **SF-2 — the marker is monotonic.** Published when the marker is at or past the boundary;
  past it also logs `audit-anchor-publisher.stale_boundary` (warn) and is a
  `skipped_already_published` (no healthy line). A marker that is not the ISO-8601 form a
  publish writes (`Date.parse` round-tripping through `toISOString`) throws
  `BoundaryMarkerUnreadableError` → `failed`/`before_upload`,
  `CADENCE_FAILED:BOUNDARY_MARKER_UNREADABLE`, uncounted. The marker write is forward only by
  construction (the re-check under the lock found it absent or earlier).
- **SF-3** — `retries_exhausted` carries `reason`: `count` when the three retries are used,
  `window_closed` when the next retry would land inside the stop window (count wins when both).
- **SF-4** — the `MISSING_PRIOR_CADENCE_PUBLICATION` row is flushed only on `published`; a
  failed run writes its failure row only. The fail-closed and MinIO integration cases now
  assert the failure row alone (they asserted both).
- **SF-5** — boot/signal wiring moved to `src/workers/audit-anchor-publisher-lifecycle.ts`
  (`createPublisherLifecycle`), used by `scripts/audit-anchor-publisher.ts` with the same lines.
  A signal during boot waits for the boot to settle; the boot then starts nothing and the
  process exits 0 — a boot failure while shutting down is not `boot_failed`. The module joined
  the publisher's `worker-policy-manifest.json` entry.
- **SF-6** — the verify worker's `verify threw` line is `error=%j` (`errorLogFields`) plus
  `detail`, which carries a message only for the worker's own precondition errors
  (`ChainVerifyPreconditionError`: `RLS_CONTEXT_MISSING`, `BYPASS_CONTEXT_MISSING`,
  `BYPASS_SCOPE_VIOLATION`, built from tenant ids and GUC values) — kept because those
  messages are the diagnosis the heartbeat tests pin, and their codes now also reach
  `error.code`. `tick threw` and the fatal `main()` line print `errorLogFields` only.
- **SF-7** — the publisher role's trust policy requires `aws:SourceAccount` (a new
  `data.aws_caller_identity.current`; none existed). EventBridge rule
  `audit_anchor_publisher_role_override` matches `RunTask` **and** `StartTask` (both accept
  `overrides.taskRoleArn`) naming the role, targets the alarm topic and is admitted by the
  topic policy. The stack has no `us-east-1` provider, so none was added. **Residual**: IAM
  `UpdateAssumeRolePolicy` / `PutRolePolicy` / `AttachRolePolicy` / `DeleteRole` + `CreateRole`
  on the role, and a `RegisterTaskDefinition` naming it, reach CloudTrail but are not alarmed
  by this stack (alerts.md, the threat model, the manual test). "Only one that reads these"
  narrowed to "the only container that receives these" (the shared execution role can read
  the secret); the READMEs already said "no other task receives".
- **SF-8** — filter and alarm `audit_anchor_publisher_dead_letter` (`audit-dead-letter` on the
  publisher's log group). `deadLetterLoggerOptions` is exported from `audit-logger.ts` so the
  metric-filter test matches the publisher's real dead-letter line.
- **SF-9** — tfvars `DEPLOYMENT_ID` wording. **SF-10** — `ci-integration.yml` paths add
  `package.json`, `package-lock.json` and the workflow itself (it has no push trigger).
  **SF-11** — compose `minio` mounts `/data` as tmpfs. **SF-12** — pre-pr's integration step
  probes MinIO's readiness and refuses the step by name when it is not ready (a failure, since
  the S3 suites fail rather than skip without it); docs/setup/docker/en.md and
  dev-host-migration.md document MinIO and `ANCHOR_TEST_S3_ENDPOINT`.
- ST-5…ST-10 as listed in the code review. ST-8's former "fifth worker task" case is renamed
  for what it tests (a changed bundle), and a real fifth task definition is the new case.
