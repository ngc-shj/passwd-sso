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
