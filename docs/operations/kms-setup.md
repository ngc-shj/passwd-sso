# KMS Setup Guide

## 1. Overview

passwd-sso uses four server-side master keys for cryptographic operations. By default these are loaded directly from environment variables (`KEY_PROVIDER=env`). Two cloud KMS providers are available:

- **`aws-kms`** — Envelope encryption via AWS KMS
- **`azure-kv`** — Secret storage via Azure Key Vault

Both providers cache decrypted keys in memory with a configurable TTL.

**Envelope encryption flow:**

```
AWS KMS key (CMK)
    └─ encrypts ─► data key ciphertext  ← stored in env var
                        │
                   KMS Decrypt API
                        │
                        ▼
                   plaintext data key  ← held in memory cache
```

This separates key custody (AWS KMS IAM policy) from key storage (env vars / secrets manager), so compromising the environment variables alone does not expose key material.

---

## 2. Environment Variables

### Common (all providers)

| Variable | Description | Default |
|----------|-------------|---------|
| `KEY_PROVIDER` | Backend to use: `env` or `aws-kms` | `env` |
| `KMS_CACHE_TTL_MS` | TTL for in-memory decrypted key cache (ms) | `300000` (5 min) |

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

### `aws-kms` provider

Standard AWS credential resolution applies (IAM role, `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, instance profile, etc.).

| Variable | Description |
|----------|-------------|
| `AWS_REGION` | AWS region where the KMS key resides (e.g. `ap-northeast-1`) |
| `KMS_ENCRYPTED_KEY_SHARE_MASTER_V<N>` | Base64-encoded KMS-encrypted data key for share master key version N |
| `KMS_ENCRYPTED_KEY_VERIFIER_PEPPER` | Base64-encoded KMS-encrypted data key for verifier pepper |
| `KMS_ENCRYPTED_KEY_DIRECTORY_SYNC` | Base64-encoded KMS-encrypted data key for directory sync |
| `KMS_ENCRYPTED_KEY_WEBAUTHN_PRF` | Base64-encoded KMS-encrypted data key for WebAuthn PRF secret |

> **Note:** `SHARE_MASTER_KEY_CURRENT_VERSION` is still required to tell the application which version is active. The application validates and warms up the cache for that version at startup.

---

## 3. AWS KMS Setup

### Step 1: Create a KMS symmetric key

```bash
aws kms create-key \
  --description "passwd-sso master keys" \
  --key-usage ENCRYPT_DECRYPT \
  --region ap-northeast-1
# Note the KeyId from the response
```

Optionally create an alias for readability:

```bash
aws kms create-alias \
  --alias-name alias/passwd-sso \
  --target-key-id <KeyId> \
  --region ap-northeast-1
```

### Step 2: Generate data keys

Run this once per master key. The `--key-spec AES_256` option produces a 32-byte (256-bit) key, matching the format expected by the application.

```bash
# Share master key (version 1)
aws kms generate-data-key \
  --key-id alias/passwd-sso \
  --key-spec AES_256 \
  --region ap-northeast-1 \
  --output json > /tmp/share-master-v1.json

# Verifier pepper
aws kms generate-data-key \
  --key-id alias/passwd-sso \
  --key-spec AES_256 \
  --region ap-northeast-1 \
  --output json > /tmp/verifier-pepper.json

# Directory sync
aws kms generate-data-key \
  --key-id alias/passwd-sso \
  --key-spec AES_256 \
  --region ap-northeast-1 \
  --output json > /tmp/directory-sync.json

# WebAuthn PRF secret
aws kms generate-data-key \
  --key-id alias/passwd-sso \
  --key-spec AES_256 \
  --region ap-northeast-1 \
  --output json > /tmp/webauthn-prf.json
```

### Step 3: Extract and store the encrypted data key

The `CiphertextBlob` field is already Base64-encoded in the JSON response.

```bash
# Example for share master key v1
jq -r '.CiphertextBlob' /tmp/share-master-v1.json
# → base64 string, set this as KMS_ENCRYPTED_KEY_SHARE_MASTER_V1

jq -r '.CiphertextBlob' /tmp/verifier-pepper.json
# → set as KMS_ENCRYPTED_KEY_VERIFIER_PEPPER

jq -r '.CiphertextBlob' /tmp/directory-sync.json
# → set as KMS_ENCRYPTED_KEY_DIRECTORY_SYNC

jq -r '.CiphertextBlob' /tmp/webauthn-prf.json
# → set as KMS_ENCRYPTED_KEY_WEBAUTHN_PRF
```

Add these values to your secrets manager or `.env.local` (not committed to version control):

```dotenv
KEY_PROVIDER=aws-kms
AWS_REGION=ap-northeast-1
SHARE_MASTER_KEY_CURRENT_VERSION=1
KMS_ENCRYPTED_KEY_SHARE_MASTER_V1=<base64 from CiphertextBlob>
KMS_ENCRYPTED_KEY_VERIFIER_PEPPER=<base64 from CiphertextBlob>
KMS_ENCRYPTED_KEY_DIRECTORY_SYNC=<base64 from CiphertextBlob>
KMS_ENCRYPTED_KEY_WEBAUTHN_PRF=<base64 from CiphertextBlob>
```

### Step 4: Discard plaintext key material

The `Plaintext` field in the JSON responses must be treated as temporary. Once the application is running and decrypting via KMS, delete the temporary files:

```bash
rm /tmp/share-master-v1.json /tmp/verifier-pepper.json \
   /tmp/directory-sync.json /tmp/webauthn-prf.json
```

Never log, commit, or persist the `Plaintext` field.

---

## 4. Key Rotation

### `env` provider

1. Generate a new key: `npm run generate:key`
2. Set the new key as the next versioned env var (e.g. `SHARE_MASTER_KEY_V2=<hex>`).
3. Update `SHARE_MASTER_KEY_CURRENT_VERSION=2`.
4. Call `POST /api/admin/rotate-master-key` (bearer token required) to re-encrypt existing share link data under the new version.
5. Restart the service to pick up the new env vars.

### `aws-kms` provider

1. Generate a new data key with KMS (Step 2 above) using the next version number.
2. Set the new encrypted data key: `KMS_ENCRYPTED_KEY_SHARE_MASTER_V<N>=<base64>`.
3. Update `SHARE_MASTER_KEY_CURRENT_VERSION=<N>`.
4. Call `POST /api/admin/rotate-master-key` to re-encrypt existing data.
5. Restart the service.

For non-versioned keys (`VERIFIER_PEPPER_KEY`, `DIRECTORY_SYNC_MASTER_KEY`, `WEBAUTHN_PRF_SECRET`):
- Generate a new data key, update the corresponding `KMS_ENCRYPTED_KEY_*` env var, then restart.
- Note that changing `VERIFIER_PEPPER_KEY` invalidates all existing vault verifiers — users will need to re-unlock their vault once after the rotation.

> **Important:** The KMS provider caches decrypted keys in memory. A service restart is required for new key values to take effect. There is no hot-reload path.

---

## 5. Security Considerations

**Cache staleness bound.** The `maxStaleTtlMs` setting (default `2 × KMS_CACHE_TTL_MS = 10 min`) caps how long a stale cached key can be used when KMS is temporarily unreachable. Beyond this window the application throws rather than use an arbitrarily old key.

**KMS IAM policy scope.** The IAM policy attached to the application's execution role should restrict `kms:Decrypt` to the specific key ARN, not `*`:

```json
{
  "Effect": "Allow",
  "Action": "kms:Decrypt",
  "Resource": "arn:aws:kms:<region>:<account>:key/<key-id>"
}
```

**Encrypted data keys are inert without KMS access.** If an attacker obtains the environment variables but not AWS credentials with `kms:Decrypt` permission, the encrypted data keys cannot be decrypted. This is the primary security benefit over the `env` provider.

**No key material in logs.** The application never logs decrypted key bytes. Ensure your logging pipeline does not capture raw environment variable dumps.

**Separate KMS keys per environment.** Use distinct CMKs for development, staging, and production to limit blast radius.

---

## 6. Troubleshooting

### `Encrypted data key not found in env: KMS_ENCRYPTED_KEY_SHARE_MASTER_V1`

The env var is missing. Verify the variable is set and that `SHARE_MASTER_KEY_CURRENT_VERSION` matches the suffix (e.g. `V1`).

### `KMS Decrypt returned no plaintext for ...`

KMS accepted the request but returned no plaintext. This can happen if the ciphertext was generated by a different KMS key. Regenerate the data key with the correct CMK.

### `AccessDeniedException` from KMS

The application's IAM role lacks `kms:Decrypt` on the target key. Check the role's policy and the KMS key resource policy.

### `Key "share-master" not in cache. Call validateKeys() at startup.`

`getKeySync()` was called before `validateKeys()` completed. This indicates a startup ordering issue — the provider warms the cache during `validateKeys()` which must complete before the application serves requests.

### `Key "..." cache expired beyond max stale TTL`

KMS has been unreachable for longer than `maxStaleTtlMs`. The application refuses to use a key that is too stale. Investigate KMS connectivity and consider increasing `KMS_CACHE_TTL_MS` if transient outages are expected, or ensure the execution environment has stable network access to the KMS endpoint.

### `Unknown KEY_PROVIDER: <value>`

`KEY_PROVIDER` is set to an unrecognized value. Valid values are `env`, `aws-kms`, and `azure-kv`.

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
| `KMS_CACHE_TTL_MS` | No | TTL for cached keys in ms (default: 300000 = 5 min) |
| `KV_SECRET_SHARE_MASTER` | No | Secret name for share master key (default: `share-master-key`) |
| `KV_SECRET_VERIFIER_PEPPER` | No | Secret name for verifier pepper (default: `verifier-pepper-key`) |
| `KV_SECRET_DIRECTORY_SYNC` | No | Secret name for directory sync key (default: `directory-sync-key`) |
| `KV_SECRET_WEBAUTHN_PRF` | No | Secret name for WebAuthn PRF (default: `webauthn-prf-secret`) |

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
