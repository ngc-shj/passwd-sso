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

### D13: Phase 3 round-2 fixes (M1…M5)

- **M1 — a marker ahead of the wall clock fails closed.** Was: any marker at or past the
  run's boundary skipped, so a marker planted at a future date suppressed every boundary up
  to it with no alarm but the day-late cadence-absent one. `isBoundaryPublished` now takes the
  wall clock's current boundary — from a new `PublisherConfig.now` (epoch ms, default
  `Date.now`, the scheduler's shape), which the publish's own `now` (`lastPublishedAt`, the
  pause) now reads too — and throws `BoundaryMarkerAheadError` for a marker strictly past it →
  `failed`/`before_upload`, `CADENCE_FAILED:BOUNDARY_MARKER_AHEAD`, uncounted, through the
  alarmed `cadence_failed` path, in both the attempt and the publish transaction. A marker
  equal to the current boundary still skips quietly when the run is for it; one past the
  run's boundary but not the clock's stays the `stale_boundary` skip, which joined
  `audit_anchor_publisher_failure_log_types` (a legitimate one on ECS needs a clock that went
  back). Forward-only marker writes are unchanged. The db-integration files run far-future
  boundaries on the real clock, so every case that runs again after a publish read its own
  marker as ahead (4 failures, `BOUNDARY_MARKER_AHEAD`, observed); those cases now pass
  `now: wallClockAt(boundary)` (anchor-publisher-fixtures.ts). Single-run cases keep the
  real clock.
- **M2 — the role rules cover both spellings and other families.** Both EventBridge rules
  match `taskRoleArn` against the role's full ARN and its bare name
  (`local.audit_anchor_publisher_role_spellings`): `RegisterTaskDefinition` documents
  "the short name or full ARN", and CloudTrail records the request as sent. A second rule,
  `audit_anchor_publisher_role_task_definition`, matches `RegisterTaskDefinition` naming the
  role with `family` `anything-but` `aws_ecs_task_definition.audit_anchor_publisher.family`
  (referenced, not re-typed); a separate rule because the field set differs from the
  override rule's. Target + topic-policy entry added. The wiring test gained a small
  EventBridge matcher (exact, `anything-but`, `suffix`) and pins: publisher family not
  matched, family `foo` matched under either spelling, another role not matched; red
  fixtures for ARN-only, the exclusion removed, exact-instead-of-anything-but, a re-typed
  family, the shared role, target, topic policy and the rule removed. **Residual** narrowed:
  a revision of the publisher's own family is still not alarmed (every deploy registers one).
- **M3** — the "bounds the upload as a whole" cases run on `vi.useFakeTimers()` +
  `advanceTimersByTimeAsync`: 0.6+0.6 → `UPLOAD_TIMEOUT`, 0.3+0.3 → `published`, and the edge
  0.5+0.5 → `UPLOAD_TIMEOUT` (the bound is armed before the first upload, so its timer is
  queued first and wins a tie). Real timers are restored in the existing `afterEach`.
- **M4** — the db-integration `lock_held` case reads the one fenced `sql` block under the
  `audit-anchor-publisher.lock_held` heading of alerts.md (throws when the section or block is
  missing or there is more than one) and runs it verbatim; the result must be exactly the
  holder's pid. The holder also takes two decoy locks — the next bigint key (same `classid`,
  other `objid`) and the two-int4 form over the same halves (`objsubid = 2`) — so a doc query
  that dropped either filter returns two rows and fails.
- **M5** — scheduler case: start at B1 − 75 min with every run failing; retries at −60, −45,
  −30; the third uses up the count as the window closes → `retries_exhausted`
  `{ retries: 3, reason: "count" }`. The window-only cases stay.

### D14: Phase 3 round-3 fixes (P1…P6)

- **P1 — the publisher-role alarm class, derived from the primitive.** The member set had
  grown by accretion (override, then another family's registration). Re-derived: a task runs
  with the publisher's role iff (a) an override names it — `audit_anchor_publisher_role_override`;
  or its task definition names it — (b1) another family: `audit_anchor_publisher_role_task_definition`
  at registration; (b2) the publisher's own family, legitimate only for a task the publisher
  service launched. (b2) is closed by two rules. `audit_anchor_publisher_family_task_outside_service`
  matches the native "ECS Task State Change" event (no trail): `taskDefinitionArn` prefix
  `"${aws_ecs_task_definition.audit_anchor_publisher.arn_without_revision}:"` (a resource
  reference — region, account and family as the provider renders them — with the `:` terminator)
  and `$or` [`clusterArn` anything-but `aws_ecs_cluster.main.arn`, `group` anything-but
  `"service:${aws_ecs_service.audit_anchor_publisher.name}"`]. The cluster branch is part of the
  derivation, not an extra route: "the publisher service" is a cluster and a name, and a service
  of the same name in another cluster runs the role too. The event carries `clusterArn`,
  `taskDefinitionArn` and `group` (`service:<name>` for a service's task, `family:<family>` by
  default otherwise). **Deviation from the requested single rule:** `group` is a RunTask /
  StartTask request parameter, documented as free-form, so a caller can start a task claiming
  `service:<publisher>` and pass the native rule. `audit_anchor_publisher_family_run_task` closes
  that: CloudTrail `RunTask` / `StartTask` whose `taskDefinition` is the family, `family:`-prefixed,
  the ARN without revision, or `arn_without_revision:`-prefixed, whatever group it claims, in any
  cluster. That the service scheduler's launches raise neither rule is a manual-test check (M6
  step 7). Both rules target the alarm topic and are in its policy. The wiring test's matcher
  gained `prefix` and `$or` (with unit cases); `roleRouteViolations` enumerates (a), (b1), (b2)
  — including the group-forged RunTask — and the legitimate events (the service's own task, a
  deploy's registration, unrelated tasks), and requires each to be matched by exactly its rule
  (none for the legitimate ones). Red fixtures: each new rule removed, the service exclusion
  removed, the cluster branch removed, the prefix without `:`, a re-typed family / service name,
  targets sent elsewhere, topic-policy entries removed, the bare-family spellings dropped. The
  "StartTask unwatched" fixture's `from` was widened (the new run-task rule repeats the line).
  **Residual** (alerts.md, threat model, manual test): `UpdateService` / `CreateService` pointing
  the publisher service at a revision registered outside a deploy (the deploy path itself), and
  IAM mutations of the role (EventBridge delivers IAM events only in `us-east-1`). Without a
  trail, (b2) is surfaced only for a task that does not claim the publisher service's group.
  deployment.md's CloudTrail prerequisite now lists all five trail-dependent rules (it listed
  three).
- **P2 — `stale_boundary` has no legitimate cause on ECS.** Corrected the D13 claim that a
  legitimate one needs a clock that went back: such a clock's current boundary moves back too, so
  the marker reads as ahead (`BOUNDARY_MARKER_AHEAD`). alerts.md's section and the
  `audit_anchor_publisher_failure_log_types` comment now say another writer (a second publisher
  or a database write); recovery starts from the `lock_held` holder query and
  `pg_stat_activity` by `application_name = 'passwd-sso-audit-anchor-publisher'`.
- **P3 — an early timer re-arms.** The scheduler's timer callback re-arms for the remainder (same
  boundary, same retry count) when `now() < at`; `now() >= at` runs. Was: an early timer ran the
  boundary it was armed for, which would write a marker ahead of the clock. The plan's C2 line
  ("a timer 1 ms early still publishes") is superseded; its test now asserts no run and a re-arm
  at the deadline, plus an exact-deadline run and an early-fired retry keeping its count.
- **P4** — unit cases with `config.now` two days past the faked `Date`: `lastPublishedAt` is
  `new Date(config.now())`, and an upload failure's pause is the boundary after `config.now`'s.
- **P5** — the UPDATE-path case and the MinIO lost-commit case run `runCadence(next)` with
  `now: wallClockAt(next)` (same keys and destinations).
- **P6** — the `lock_held` case takes a third decoy, `(1::bigint << 32) + hashtext(...)::bigint`
  (classid 1, same objid, objsubid 1), released in `finally`; the exact-pid assertion stays.
