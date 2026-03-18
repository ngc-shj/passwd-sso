# Key Provider Setup Guide

## 1. Overview

passwd-sso uses four server-side master keys for cryptographic operations. By default these are loaded directly from environment variables (`KEY_PROVIDER=env`). Three cloud secret management providers are available:

- **`aws-sm`** — AWS Secrets Manager
- **`azure-kv`** — Azure Key Vault
- **`gcp-sm`** — GCP Secret Manager

All providers follow the same pattern: master keys are stored as hex strings in the cloud secret store, fetched at startup via the provider's API, and cached in memory with a configurable TTL. Plaintext key material never appears in environment variables or configuration files.

```
Cloud Secret Store (SM / KV / SM)
    └─ stores ─► secret (64-char hex string)
                     │
              Provider API (GetSecretValue / getSecret / accessSecretVersion)
                     │
                     ▼
              plaintext key Buffer  ← held in memory cache (TTL-based refresh)
```

For AWS, enabling KMS encryption on Secrets Manager secrets adds an additional layer: secrets are encrypted at rest with a KMS CMK, and Secrets Manager handles the envelope encryption transparently.

---

## 2. Environment Variables

### Common (all providers)

| Variable | Description | Default |
|----------|-------------|---------|
| `KEY_PROVIDER` | Backend to use: `env`, `aws-sm`, `azure-kv`, or `gcp-sm` | `env` |
| `SM_CACHE_TTL_MS` | TTL for in-memory decrypted key cache (ms) | `300000` (5 min) |

### `env` provider (default)

All values must be 64-character lowercase hex strings (256-bit keys). Generate with `npm run generate:key`.

| Variable | Description |
|----------|-------------|
| `SHARE_MASTER_KEY` | Share master key, version 1 alias (also readable as `SHARE_MASTER_KEY_V1`) |
| `SHARE_MASTER_KEY_V<N>` | Share master key for version N (N = 1–100, used for key rotation) |
| `SHARE_MASTER_KEY_CURRENT_VERSION` | Active version number (integer, default `1`) |
| `VERIFIER_PEPPER_KEY` | HMAC pepper for passphrase verification (required in production) |
| `DIRECTORY_SYNC_MASTER_KEY` | Encryption key for directory sync provider credentials (required in production) |
| `WEBAUTHN_PRF_SECRET` | PRF salt derivation secret for passkey vault auto-unlock |

### `aws-sm` provider (AWS Secrets Manager)

Standard AWS credential resolution applies (IAM role, instance profile, ECS task role, etc.). Secrets Manager encrypts secrets at rest with a KMS CMK (default `aws/secretsmanager` or custom CMK).

| Variable | Description |
|----------|-------------|
| `AWS_REGION` | AWS region (e.g. `ap-northeast-1`) |
| `AWS_SM_SECRET_SHARE_MASTER` | Secret name/ARN (default: `passwd-sso/share-master-key`) |
| `AWS_SM_SECRET_VERIFIER_PEPPER` | Secret name/ARN (default: `passwd-sso/verifier-pepper-key`) |
| `AWS_SM_SECRET_DIRECTORY_SYNC` | Secret name/ARN (default: `passwd-sso/directory-sync-key`) |
| `AWS_SM_SECRET_WEBAUTHN_PRF` | Secret name/ARN (default: `passwd-sso/webauthn-prf-secret`) |

---

## 3. AWS Secrets Manager Setup (`aws-sm`)

### Prerequisites

```bash
npm install @aws-sdk/client-secrets-manager
```

### Step 1: Create secrets

```bash
# Generate and store 256-bit keys as hex strings
openssl rand -hex 32 | tr -d '\n' | \
  aws secretsmanager create-secret \
    --name passwd-sso/share-master-key \
    --secret-string "$(cat -)" \
    --region ap-northeast-1

openssl rand -hex 32 | tr -d '\n' | \
  aws secretsmanager create-secret \
    --name passwd-sso/verifier-pepper-key \
    --secret-string "$(cat -)" \
    --region ap-northeast-1

openssl rand -hex 32 | tr -d '\n' | \
  aws secretsmanager create-secret \
    --name passwd-sso/directory-sync-key \
    --secret-string "$(cat -)" \
    --region ap-northeast-1

openssl rand -hex 32 | tr -d '\n' | \
  aws secretsmanager create-secret \
    --name passwd-sso/webauthn-prf-secret \
    --secret-string "$(cat -)" \
    --region ap-northeast-1
```

To use a custom KMS CMK for encryption at rest (recommended for production):

```bash
aws secretsmanager create-secret \
  --name passwd-sso/share-master-key \
  --secret-string "$(openssl rand -hex 32)" \
  --kms-key-id alias/passwd-sso \
  --region ap-northeast-1
```

### Step 2: Grant access

```bash
# For ECS task role / EC2 instance profile
aws iam put-role-policy --role-name my-app-role \
  --policy-name passwd-sso-secrets \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": "arn:aws:secretsmanager:ap-northeast-1:*:secret:passwd-sso/*"
    }]
  }'
```

If using a custom KMS CMK, also grant `kms:Decrypt` on the key ARN.

### Step 3: Configure the application

```dotenv
KEY_PROVIDER=aws-sm
AWS_REGION=ap-northeast-1
# Optional: override default secret names
# AWS_SM_SECRET_SHARE_MASTER=my-custom/share-key
```

---

## 4. Key Rotation

### `env` provider

1. Generate a new key: `npm run generate:key`
2. Set the new key as the next versioned env var (e.g. `SHARE_MASTER_KEY_V2=<hex>`).
3. Update `SHARE_MASTER_KEY_CURRENT_VERSION=2`.
4. Call `POST /api/admin/rotate-master-key` (bearer token required) to re-encrypt existing share link data under the new version.
5. Restart the service to pick up the new env vars.

### Cloud providers (`aws-sm`, `azure-kv`, `gcp-sm`)

For share master key (versioned):
1. Create a new secret with version suffix (e.g. `passwd-sso/share-master-key-v2`)
2. Update `SHARE_MASTER_KEY_CURRENT_VERSION=2`
3. Call `POST /api/admin/rotate-master-key` to re-encrypt existing data
4. Restart the service

For non-versioned keys (verifier pepper, directory sync, WebAuthn PRF):
1. Update the secret value in the cloud secret store
2. Restart the service
3. Note: changing the verifier pepper invalidates all existing vault verifiers — users will need to re-unlock their vault once

> **Important:** All providers cache keys in memory. A service restart is required for new values to take effect.

---

## 5. Security Considerations

**Cache staleness bound.** `maxStaleTtlMs` (default `2 × SM_CACHE_TTL_MS = 10 min`) caps how long a stale cached key can be used when the secret store is temporarily unreachable.

**Least-privilege access.** Restrict the application's IAM/RBAC role to only the specific secrets it needs:
- AWS: `secretsmanager:GetSecretValue` scoped to `passwd-sso/*`
- Azure: `Key Vault Secrets User` role scoped to the vault
- GCP: `roles/secretmanager.secretAccessor` scoped to individual secrets

**KMS encryption at rest.** AWS Secrets Manager and GCP Secret Manager encrypt secrets with KMS by default. Azure Key Vault uses platform-managed keys with optional customer-managed keys (CMK).

**No key material in logs.** The application never logs decrypted key bytes. Ensure your logging pipeline does not capture raw environment variable dumps.

**Separate secret stores per environment.** Use distinct secret stores (or prefixed names) for development, staging, and production.

---

## 6. Troubleshooting

### `Key "share-master" not in cache. Call validateKeys() at startup.`

`getKeySync()` was called before `validateKeys()` completed. This indicates a startup ordering issue — the provider warms the cache during `validateKeys()` which must complete before the application serves requests.

### `Key "..." cache expired beyond max stale TTL`

The secret store has been unreachable for longer than `maxStaleTtlMs`. Investigate connectivity and consider increasing `SM_CACHE_TTL_MS`.

### `Unknown KEY_PROVIDER: <value>`

`KEY_PROVIDER` is set to an unrecognized value. Valid values are `env`, `aws-sm`, `azure-kv`, and `gcp-sm`.

---

## Azure Key Vault Provider (`azure-kv`)

### Overview

The `azure-kv` provider stores master keys as **Key Vault secrets** (64-char hex strings). Authentication uses `DefaultAzureCredential`, which supports managed identity, workload identity, Azure CLI, and other credential sources.

**Flow:**

```
Azure Key Vault
    └─ stores ─► secret (64-char hex)
                     │
              SecretClient.getSecret()
                     │
                     ▼
              plaintext key Buffer  ← held in memory cache
```

### Prerequisites

```bash
npm install @azure/keyvault-secrets @azure/identity
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `KEY_PROVIDER` | Yes | Set to `azure-kv` |
| `AZURE_KV_URL` | Yes | Key Vault URL (e.g. `https://my-vault.vault.azure.net`) |
| `SM_CACHE_TTL_MS` | No | TTL for cached keys in ms (default: 300000 = 5 min) |
| `AZ_KV_SECRET_SHARE_MASTER` | No | Secret name for share master key (default: `share-master-key`) |
| `AZ_KV_SECRET_VERIFIER_PEPPER` | No | Secret name for verifier pepper (default: `verifier-pepper-key`) |
| `AZ_KV_SECRET_DIRECTORY_SYNC` | No | Secret name for directory sync key (default: `directory-sync-key`) |
| `AZ_KV_SECRET_WEBAUTHN_PRF` | No | Secret name for WebAuthn PRF (default: `webauthn-prf-secret`) |

### Setup Steps

1. **Create a Key Vault:**

```bash
az keyvault create --name my-vault --resource-group my-rg --location japaneast
```

2. **Generate and store secrets:**

```bash
# Generate a 256-bit key
KEY=$(openssl rand -hex 32)

# Store in Key Vault
az keyvault secret set --vault-name my-vault --name share-master-key --value "$KEY"
az keyvault secret set --vault-name my-vault --name verifier-pepper-key --value "$(openssl rand -hex 32)"
az keyvault secret set --vault-name my-vault --name directory-sync-key --value "$(openssl rand -hex 32)"
az keyvault secret set --vault-name my-vault --name webauthn-prf-secret --value "$(openssl rand -hex 32)"
```

3. **Grant access to the application:**

```bash
# For managed identity (App Service / AKS)
az keyvault set-policy --name my-vault \
  --object-id <managed-identity-object-id> \
  --secret-permissions get

# Or use RBAC (recommended)
az role assignment create \
  --role "Key Vault Secrets User" \
  --assignee <managed-identity-client-id> \
  --scope /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.KeyVault/vaults/my-vault
```

4. **Configure the application:**

```env
KEY_PROVIDER=azure-kv
AZURE_KV_URL=https://my-vault.vault.azure.net
```

### Key Rotation

1. Create a new secret version in Key Vault
2. Restart the application to pick up the new value
3. For share master key versioning, use the `-v{N}` suffix pattern (e.g. `share-master-key-v2`)

### Troubleshooting

**`AZURE_KV_URL is required for KEY_PROVIDER=azure-kv`**

`AZURE_KV_URL` env var is not set or empty.

**`Azure Key Vault secret "..." has no value`**

The secret exists but has an empty value. Re-create with a valid 64-char hex string.

**`Azure Key Vault secret "..." is not a valid 64-char hex string`**

The secret value is not in the expected format. Key Vault secrets must contain exactly 64 hexadecimal characters (256 bits).

**`@azure/keyvault-secrets and @azure/identity are required`**

Install the required packages: `npm install @azure/keyvault-secrets @azure/identity`

---

## GCP Secret Manager Provider (`gcp-sm`)

### Overview

The `gcp-sm` provider stores master keys as **Secret Manager secrets** (64-char hex strings). Authentication uses Application Default Credentials (ADC), which supports Workload Identity, service account keys, and gcloud CLI.

**Flow:**

```
GCP Secret Manager
    └─ stores ─► secret version (64-char hex)
                     │
         accessSecretVersion()
                     │
                     ▼
              plaintext key Buffer  ← held in memory cache
```

### Prerequisites

```bash
npm install @google-cloud/secret-manager
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `KEY_PROVIDER` | Yes | Set to `gcp-sm` |
| `GCP_PROJECT_ID` | Yes | GCP project ID |
| `SM_CACHE_TTL_MS` | No | TTL for cached keys in ms (default: 300000 = 5 min) |
| `GCP_SM_SECRET_SHARE_MASTER` | No | Secret name for share master key (default: `share-master-key`) |
| `GCP_SM_SECRET_VERIFIER_PEPPER` | No | Secret name for verifier pepper (default: `verifier-pepper-key`) |
| `GCP_SM_SECRET_DIRECTORY_SYNC` | No | Secret name for directory sync key (default: `directory-sync-key`) |
| `GCP_SM_SECRET_WEBAUTHN_PRF` | No | Secret name for WebAuthn PRF (default: `webauthn-prf-secret`) |

### Setup Steps

1. **Enable Secret Manager API:**

```bash
gcloud services enable secretmanager.googleapis.com --project=my-project
```

2. **Create secrets:**

```bash
# Generate and store a 256-bit key
openssl rand -hex 32 | gcloud secrets create share-master-key \
  --project=my-project --data-file=-

openssl rand -hex 32 | gcloud secrets create verifier-pepper-key \
  --project=my-project --data-file=-

openssl rand -hex 32 | gcloud secrets create directory-sync-key \
  --project=my-project --data-file=-

openssl rand -hex 32 | gcloud secrets create webauthn-prf-secret \
  --project=my-project --data-file=-
```

3. **Grant access to the application:**

```bash
# For Workload Identity (GKE / Cloud Run)
gcloud secrets add-iam-policy-binding share-master-key \
  --project=my-project \
  --member="serviceAccount:my-sa@my-project.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

# Repeat for each secret
```

4. **Configure the application:**

```env
KEY_PROVIDER=gcp-sm
GCP_PROJECT_ID=my-project
```

### Key Rotation

1. Add a new secret version: `echo -n $(openssl rand -hex 32) | gcloud secrets versions add share-master-key --data-file=-`
2. Restart the application to pick up the new version (the provider always fetches `versions/latest`)
3. For share master key versioning, use the `-v{N}` suffix pattern (e.g. `share-master-key-v2`)

### Troubleshooting

**`GCP_PROJECT_ID is required for KEY_PROVIDER=gcp-sm`**

`GCP_PROJECT_ID` env var is not set or empty.

**`GCP Secret Manager secret "..." has no payload data`**

The secret version exists but has empty payload. Re-create with a valid 64-char hex string.

**`GCP Secret Manager secret "..." is not a valid 64-char hex string`**

The secret value is not in the expected format. Secrets must contain exactly 64 hexadecimal characters (256 bits).

**`@google-cloud/secret-manager is required`**

Install the required package: `npm install @google-cloud/secret-manager`
