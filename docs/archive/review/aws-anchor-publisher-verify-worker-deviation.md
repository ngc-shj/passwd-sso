# Coding Deviation Log: aws-anchor-publisher-verify-worker

### D1: body-parser override bumped; stale braces suppression removed

- **Plan**: only `@aws-sdk/client-s3` is added.
- **Actual**: `overrides.body-parser` `^2.3.0` → `^2.4.0` (resolves to 2.4.0); the
  GHSA-vfj7-8cjw-p6xm (braces) suppression is deleted.
- **Reason**: `node scripts/checks/check-npm-audit.mjs` (CI's dev-scope gate) failed on the
  pre-change lockfile too: GHSA-27r3-jxmh-p828 (body-parser <2.4.0, high, dev chain
  shadcn → @modelcontextprotocol/sdk → express) has a fixed release, and the braces entry
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

### D3: scheduler retries only `upload` and `after_upload` failures in-process

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
