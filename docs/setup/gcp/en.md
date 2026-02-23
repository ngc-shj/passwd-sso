# passwd-sso GCP Setup (Cloud Run/GKE + Cloud SQL + Memorystore)

This guide describes a production-oriented GCP deployment.

## Recommended services

- App runtime: Cloud Run or GKE
- Database: Cloud SQL for PostgreSQL
- Cache: Memorystore for Redis
- Secrets: Secret Manager
- Object storage for attachments (optional): Cloud Storage (GCS)

## Required app configuration

- `DATABASE_URL`
- `AUTH_SECRET`
- `AUTH_URL`
- `SHARE_MASTER_KEY`
- `REDIS_URL`
- `BLOB_BACKEND`

If `BLOB_BACKEND=gcs`:
- `GCS_ATTACHMENTS_BUCKET`

Optional:
- `BLOB_OBJECT_PREFIX` (object key prefix)

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
