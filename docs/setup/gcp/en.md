# passwd-sso GCP Setup (Cloud Run/GKE + Cloud SQL + Memorystore)

This guide describes a production-oriented GCP deployment.

## Recommended services

- App runtime: Cloud Run or GKE
- Database: Cloud SQL for PostgreSQL
- Cache: Memorystore for Redis
- Secrets: Secret Manager
- Object storage for attachments (optional): Cloud Storage (GCS)

## Required app configuration

- `DATABASE_URL` (app role `passwd_app`)
- `MIGRATION_DATABASE_URL` (SUPERUSER role `passwd_user` — used for `prisma migrate deploy` only)
- `OUTBOX_WORKER_DATABASE_URL` (least-privilege role `passwd_outbox_worker` — required for audit-outbox-worker)
- `AUTH_SECRET`
- `AUTH_URL`
- `SHARE_MASTER_KEY`
- `REDIS_URL` (REQUIRED in production — Zod schema enforces this for `NODE_ENV=production`; backs session cache with tombstone-based revocation propagation (PR #407) and shared rate limiting. Use Memorystore for Redis.)
- `BLOB_BACKEND`
- `JACKSON_API_KEY` (passed to the Jackson container as `JACKSON_API_KEYS` — note the trailing `S`)
- `PASSWD_OUTBOX_WORKER_PASSWORD` (sets the `passwd_outbox_worker` DB role password; use `scripts/set-outbox-worker-password.sh` to rotate)

If `BLOB_BACKEND=gcs`:
- `GCS_ATTACHMENTS_BUCKET`

Optional:
- `BLOB_OBJECT_PREFIX` (object key prefix)
- `KEY_PROVIDER=gcp-sm` (use GCP Secret Manager for master key management — see [KMS Setup](../../operations/key-provider-setup.md#gcp-secret-manager-provider-gcp-sm))

## Audit-outbox-worker

The audit-outbox-worker is a long-running process that drains `audit_outbox` rows into `audit_logs`. Without it, audit events silently accumulate as `PENDING`.

> **Important**: Cloud Run regular services are request-scoped and are NOT suitable for long-running workers. Use one of:
>
> - **Cloud Run Jobs**: scheduled or triggered execution (suitable only if infrequent batch draining is acceptable).
> - **GKE Deployment**: a dedicated pod running `npx tsx scripts/audit-outbox-worker.ts` continuously.
> - **Compute Engine VM**: a systemd service or Docker container running the worker.

Required env var: `OUTBOX_WORKER_DATABASE_URL` (least-privilege `passwd_outbox_worker` role).

## Jackson Deployment

BoxyHQ SAML Jackson must run as a separate service (Docker container). It is not an npm package.

- Image: `boxyhq/jackson:1.52.2`
- Suitable deployment targets: Cloud Run service (expose port 5225), GKE Deployment, or Compute Engine VM.
- Set `JACKSON_URL` in the `app` service to the internal or public URL of this service.
- Required env vars for Jackson:
  - `JACKSON_API_KEYS` (your `JACKSON_API_KEY` value — note the trailing `S` in the Jackson env name)
  - `DB_ENGINE=sql`, `DB_TYPE=postgres`, `DB_URL` (Cloud SQL)
  - `NEXTAUTH_URL` and `EXTERNAL_URL` (public or internal URL of Jackson)
  - `NEXTAUTH_SECRET` (same value as `AUTH_SECRET`)
  - `NEXTAUTH_ACL=*`

## Admin / Maintenance Scripts

Admin scripts require a per-operator `op_*` token. Mint a token in the application UI at `/admin/tenant/operator-tokens`, then pass it at invocation time:

```bash
ADMIN_API_TOKEN=op_<your-token> scripts/purge-history.sh
ADMIN_API_TOKEN=op_<your-token> scripts/purge-audit-logs.sh
ADMIN_API_TOKEN=op_<your-token> TARGET_VERSION=<int> scripts/rotate-master-key.sh
```

Do NOT store `ADMIN_API_TOKEN` as a persistent environment variable. Mint tokens on demand and revoke them after use.

## Object storage design (attachments)

- Attachment ciphertext is stored in GCS.
- DB stores metadata + object reference only.
- Bucket should be private and blocked from public access.
- Configure retention/lifecycle rules for operations.

## Identity and permissions

- Prefer Workload Identity (or equivalent service account binding).
- Minimum Storage permissions:
  - Read object
  - Create/Update object
  - Delete object
- Scope permissions to one attachments bucket.

## Operational checks

1. Confirm app can read secrets from Secret Manager.
2. Confirm connectivity:
   - App -> Cloud SQL
   - App -> Memorystore
   - App -> GCS
3. Upload/download/delete one attachment via API.
4. Verify logs do not include plaintext attachment data.

## Security notes

- Keep all credentials outside source code.
- Enforce TLS where applicable.
- Rotate service account keys if keys are used (prefer keyless identity).
