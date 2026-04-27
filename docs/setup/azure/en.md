# passwd-sso Azure Setup (Container Apps/AKS + PostgreSQL + Redis)

This guide describes a production-oriented Azure deployment.

## Recommended services

- App runtime: Azure Container Apps or AKS
- Database: Azure Database for PostgreSQL (Flexible Server)
- Cache: Azure Cache for Redis
- Secrets: Azure Key Vault
- Object storage for attachments (optional): Azure Blob Storage

## Required app configuration

- `DATABASE_URL` (app role `passwd_app`)
- `MIGRATION_DATABASE_URL` (SUPERUSER role `passwd_user` — used for `prisma migrate deploy` only)
- `OUTBOX_WORKER_DATABASE_URL` (least-privilege role `passwd_outbox_worker` — required for audit-outbox-worker)
- `AUTH_SECRET`
- `AUTH_URL`
- `SHARE_MASTER_KEY`
- `REDIS_URL` (REQUIRED in production — Zod schema enforces this for `NODE_ENV=production`; backs session cache with tombstone-based revocation propagation (PR #407) and shared rate limiting. Use Azure Cache for Redis.)
- `BLOB_BACKEND`
- `JACKSON_API_KEY` (passed to the Jackson container as `JACKSON_API_KEYS` — note the trailing `S`)
- `PASSWD_OUTBOX_WORKER_PASSWORD` (sets the `passwd_outbox_worker` DB role password; use `scripts/set-outbox-worker-password.sh` to rotate)

If `BLOB_BACKEND=azure`:
- `AZURE_STORAGE_ACCOUNT`
- `AZURE_BLOB_CONTAINER`
- One of:
  - `AZURE_STORAGE_CONNECTION_STRING`
  - `AZURE_STORAGE_SAS_TOKEN`

Optional:
- `BLOB_OBJECT_PREFIX` (object key prefix)
- `KEY_PROVIDER=azure-kv` (use Azure Key Vault for master key management — see [KMS Setup](../../operations/key-provider-setup.md#azure-key-vault-provider-azure-kv))

## Audit-outbox-worker

The audit-outbox-worker is a long-running process that drains `audit_outbox` rows into `audit_logs`. Without it, audit events silently accumulate as `PENDING`. Deploy it as:

- **Container Apps revision/job**: add a second container or a Container Apps Job using the same Docker image, with `OUTBOX_WORKER_DATABASE_URL` set and command `["npx", "tsx", "scripts/audit-outbox-worker.ts"]`.
- **AKS sidecar or Deployment**: add a dedicated container/pod running the worker command.

Required env var: `OUTBOX_WORKER_DATABASE_URL` (least-privilege `passwd_outbox_worker` role).

## Jackson Deployment

BoxyHQ SAML Jackson must run as a separate service (Docker container or Container App). It is not an npm package.

- Image: `boxyhq/jackson:1.52.2`
- Expose port 5225 internally; set `JACKSON_URL` in the `app` service to point to this service.
- Required env vars for Jackson container:
  - `JACKSON_API_KEYS` (your `JACKSON_API_KEY` value — note the trailing `S` in the Jackson env name)
  - `DB_ENGINE=sql`, `DB_TYPE=postgres`, `DB_URL` (PostgreSQL)
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

## Blob storage design (attachments)

- Attachment ciphertext is stored in Blob Storage.
- DB stores metadata + object reference only.
- Container should be private (no public anonymous access).
- Use lifecycle policy for old object cleanup if needed.

## Identity and permissions

- Prefer Managed Identity for runtime workloads.
- Minimum Blob permissions:
  - Read object
  - Write object
  - Delete object
- Scope to one container dedicated to attachments.

## Operational checks

1. Confirm app can read secrets from Key Vault.
2. Confirm connectivity:
   - App -> PostgreSQL
   - App -> Redis
   - App -> Blob Storage
3. Upload/download/delete one attachment via API.
4. Verify logs do not include plaintext attachment data.

## Security notes

- Keep `BLOB_BACKEND` and credentials in secure secret stores only.
- Enable TLS for PostgreSQL, Redis, and Blob endpoints.
- Rotate storage credentials/SAS periodically.
