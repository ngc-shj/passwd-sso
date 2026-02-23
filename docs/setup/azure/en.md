# passwd-sso Azure Setup (Container Apps/AKS + PostgreSQL + Redis)

This guide describes a production-oriented Azure deployment.

## Recommended services

- App runtime: Azure Container Apps or AKS
- Database: Azure Database for PostgreSQL (Flexible Server)
- Cache: Azure Cache for Redis
- Secrets: Azure Key Vault
- Object storage for attachments (optional): Azure Blob Storage

## Required app configuration

- `DATABASE_URL`
- `AUTH_SECRET`
- `AUTH_URL`
- `SHARE_MASTER_KEY`
- `REDIS_URL`
- `BLOB_BACKEND`

If `BLOB_BACKEND=azure`:
- `AZURE_STORAGE_ACCOUNT`
- `AZURE_BLOB_CONTAINER`
- One of:
  - `AZURE_STORAGE_CONNECTION_STRING`
  - `AZURE_STORAGE_SAS_TOKEN`

Optional:
- `BLOB_OBJECT_PREFIX` (object key prefix)

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
