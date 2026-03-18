# KMS Setup Guide

## 1. Overview

passwd-sso uses four server-side master keys for cryptographic operations. By default these are loaded directly from environment variables (`KEY_PROVIDER=env`). The `aws-kms` provider adds envelope encryption: each master key is stored as a KMS-encrypted data key in an environment variable. At runtime the application calls AWS KMS to decrypt the data key into memory, caches it, and uses it for cryptographic operations. Plaintext key material never appears in configuration files or version control.

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

`KEY_PROVIDER` is set to an unrecognized value. Valid values are `env` and `aws-kms`.
