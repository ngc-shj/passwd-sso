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
