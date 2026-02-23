# Security Considerations

This document summarizes practical security considerations for `passwd-sso` (web app + browser extension).

## 1. Threat Model (High Level)

- Personal vault entries are encrypted client-side (E2E); server stores ciphertext only.
- Organization vault entries are encrypted end-to-end (client-side, ECDH-P256 member-key distribution).
- Browser extension is convenience UX; it must not weaken the core vault security model.

## 1.1 Architecture Diagram (ASCII)

```text
┌──────────────────────────────────────────────┐
│                Browser / Extension           │
│  - Web App (Next.js UI)                      │
│  - MV3 Extension (Popup/Background/Content)  │
│  - Web Crypto (E2E encrypt/decrypt)          │
└───────────────┬──────────────────────────────┘
                │ HTTPS (Auth/API)
                ▼
┌──────────────────────────────────────────────┐
│              Next.js App Server              │
│  - Auth.js session                           │
│  - API routes                                │
│  - Share links / sends server-side crypto    │
└───────────┬───────────────────┬──────────────┘
            │ TLS               │ TLS
            ▼                   ▼
     ┌──────────────┐     ┌──────────────┐
     │ PostgreSQL   │     │ Redis        │
     │ (ciphertext) │     │ rate limit   │
     └──────────────┘     └──────────────┘
            │
            │ TLS (optional)
            ▼
     ┌──────────────┐
     │ Blob Storage │
     │ attachments  │
     └──────────────┘
```

## 1.2 Protocol Flow (Summary)

```text
[Sign-in]
Browser -> Auth Provider/NextAuth -> session established

[Personal Vault Write]
Browser(WebCrypto) encrypts -> API -> DB stores ciphertext

[Personal Vault Read]
API returns ciphertext -> Browser(WebCrypto) decrypts in-memory

[Extension Fill]
Popup/Content -> Background -> API(ciphertext) -> decrypt in extension runtime
-> fill to target form (user action required)
```

## 1.3 Cryptographic Parameters (Current Implementation)

### Personal Vault (Web Crypto API / `src/lib/crypto-client.ts`)

#### Key derivation flow (from passphrase)

```text
passphrase
  + accountSalt(32 bytes)
    └─ PBKDF2-HMAC-SHA-256 (600,000)
       └─ wrappingKey (AES-256-GCM)
          ├─ unwrap encryptedSecretKey -> secretKey(32 bytes)
          └─ (during setup) wrap secretKey

secretKey
  ├─ HKDF-SHA-256(info="passwd-sso-enc-v1")
  │   └─ encryptionKey (AES-256-GCM)  // entry encryption/decryption
  └─ HKDF-SHA-256(info="passwd-sso-auth-v1")
      └─ authKey (HMAC-SHA-256)
          └─ SHA-256(raw authKey) = authHash  // server-side verification input
```

#### Unlock verification flow (summary)

```text
Client:
  passphrase -> wrappingKey -> secretKey
  secretKey -> authKey -> authHash
  POST /api/vault/unlock { authHash }

Server:
  serverHash == SHA-256(authHash + serverSalt) ? valid : invalid

Client(on valid):
  secretKey -> encryptionKey
  decrypt verificationArtifact successfully
```

- Wrapping key KDF: `PBKDF2-HMAC-SHA-256`
- Iterations: `600,000`
- Wrapping key target: `AES-256-GCM` (`encrypt/decrypt`)
- `secretKey`: random `32 bytes` (256-bit)
- `accountSalt`: random `32 bytes` (256-bit)
- Secret-key wrap IV: `12 bytes` (96-bit)
- AES-GCM auth tag: `16 bytes` (128-bit)
- HKDF (encryption key derivation):
  - hash: `SHA-256`
  - salt: 32-byte zero buffer
  - info: `passwd-sso-enc-v1`
  - output key: `AES-256-GCM`
- HKDF (auth key derivation):
  - hash: `SHA-256`
  - salt: 32-byte zero buffer
  - info: `passwd-sso-auth-v1`
  - output key: `HMAC-SHA-256` (256-bit)
- Verification artifact plaintext: `passwd-sso-vault-verification-v1`
- Core `CryptoKey` objects are generally non-extractable (`extractable: false`)

#### AAD (Additional Authenticated Data)

- AES-GCM uses `additionalData` with **AAD** to bind ciphertext to context
- Implementation: `src/lib/crypto-aad.ts`
- Scopes:
  - `PV` (Personal Vault): `userId`, `entryId`
  - `OV` (Org Vault): `orgId`, `entryId`, `vaultType(blob|overview)`
  - `AT` (Attachment): `entryId`, `attachmentId`
- Format:
  - 2-byte scope + 1-byte `aadVersion` + 1-byte field count + length-prefixed UTF-8 fields
- Purpose:
  - Prevent ciphertext transplant/replay across users/entries

### Passphrase Verifier

- Version: `VERIFIER_VERSION = 1`
- `PBKDF2-HMAC-SHA-256` / `600,000` iterations / `256-bit` output
- Domain separation prefix: `verifier`
- Stored value in DB: `hmacVerifier(verifierHash)`
  - HMAC: `SHA-256`
  - key: `VERIFIER_PEPPER_KEY` (required in production, 64 hex chars)
  - non-production fallback derives from `SHARE_MASTER_KEY`

### Share Links / Sends (Server Crypto / `src/lib/crypto-server.ts`)

- Algorithm: `aes-256-gcm` (Node `crypto`)
- `SHARE_MASTER_KEY`: 64 hex chars (256-bit)
- IV: `12 bytes`, AuthTag: `16 bytes`
- Used for server-encrypted share links and sends

### Export Encryption (`src/lib/export-crypto.ts`)

- cipher: `AES-256-GCM`
- kdf: `PBKDF2-HMAC-SHA256`
- iterations: `600,000`

## 1.4 Auth / Extension Token Parameters (Current Implementation)

### Vault unlock verification (server side)

- Client sends `authHash` (`SHA-256(raw authKey)`)
- Server stores `serverHash = SHA-256(authHash + serverSalt)`
- Unlock verifies by recomputing and comparing
- Unlock rate limit: 5 attempts per 5 minutes (`/api/vault/unlock`)

- Extension token TTL: `15 minutes` (`EXTENSION_TOKEN_TTL_MS`)
- Extension refresh buffer: `2 minutes before expiry` (extension background)
- Default scopes:
  - `passwords:read`
  - `vault:unlock-data`
- Max active extension tokens per user: `3` (oldest revoked on overflow)
- Rate limits:
  - issue: 10 per 15 minutes
  - refresh: 20 per 15 minutes

## 1.5 Storage and Lifetime (Current Implementation)

- Web app:
  - Vault decryption key is handled in runtime memory during unlock windows
  - Auto-lock: 15 min inactivity / 5 min hidden tab
- Browser extension:
  - token persisted in `chrome.storage.session` (cleared on browser close)
  - `vaultSecretKey` for key re-derivation is also in `chrome.storage.session`
  - `autoLockMinutes` controls extension vault lock timer (default 15 min)

## 2. Core Security Controls

- Use HTTPS everywhere in production.
- Keep `AUTH_SECRET` and `SHARE_MASTER_KEY` in a secret manager (never in Git).
- Enforce DB/Redis/blob TLS.
- Enable Redis in production (`REDIS_URL`) to keep unlock rate limiting effective.
- Keep CSP enabled; avoid adding unsafe script/style exceptions.

## 3. Authentication and Session

- Auth.js database sessions are used (no JWT session storage in browser localStorage).
- Keep reasonable session lifetime and revocation procedures.
- Restrict SSO domains/providers where possible (`GOOGLE_WORKSPACE_DOMAIN`, IdP controls).

## 4. Vault and Key Handling

- Personal vault keys must only exist in runtime memory during unlock windows.
- Auto-lock settings are part of security posture; do not disable casually.
- Clear clipboard copies quickly (already implemented as 30s auto-clear).

## 5. Browser Extension Specific

- Default to manual fill only (no silent background autofill).
- Suppress inline suggestions on the passwd-sso app origin to avoid noisy/self-fill confusion.
- Keep host permissions minimal and explicit.
- Treat extension token as short-lived and scope-limited.
- Prefer no persistent storage for vault decryption material.

## 6. Deployment Checklist

- Production env vars are fully set and validated.
- `prisma migrate deploy` executed before serving traffic.
- DB/Jackson internal endpoints are not publicly exposed.
- Security headers/CSP reporting endpoint is active.
- Secrets rotation policy is documented and scheduled.

## 7. Vulnerability Reporting

See `SECURITY.md` for disclosure policy and contact.

## 8. PQC (Post-Quantum) Readiness

Current critical paths are mostly symmetric cryptography (PBKDF2/HKDF/AES-GCM),  
so there is no immediate break scenario. Still, long-term migration planning is required.

### 8.1 Design Principles

- Keep cryptographic agility (easy algorithm replacement)
- Keep explicit crypto/data `version` fields for staged migration
- Support parallel legacy/new modes during migration windows

### 8.2 Implementation Preparation

- Preserve `wrapVersion` style versioning for wrap/key-exchange paths
- Keep the migration path referenced in `src/lib/crypto-emergency.ts` toward
  `HYBRID-ECDH-P256-MLKEM768`
- Ensure API/DB schemas can extend key material/salt/version without breaking compatibility
- Centralize crypto parameters as constants; avoid scattered ad-hoc values

### 8.3 Operational Preparation

- Track NIST standardization updates (ML-KEM / ML-DSA)
- Define dependency upgrade policy for crypto-related libraries
- Document migration strategy: new writes use new scheme, old data remains readable

### 8.4 Practical Priority in This Product

1. Hybridize key-exchange/sharing paths first (e.g., emergency-access flows)  
2. Keep data encryption on AES-GCM while strengthening key lifecycle management  
3. Introduce PQC for signatures/auth aligned with upstream Auth/IdP ecosystem readiness

## 9. Assumptions / Non-Goals

### Assumptions

- HTTPS/TLS is correctly enforced
- Browser runtime is not compromised
- Server secrets (`AUTH_SECRET`, `SHARE_MASTER_KEY`, etc.) are properly protected

### Non-Goals

- Full protection against endpoint malware
- Full protection after successful same-origin XSS execution
- Full protection against screen capture/keylogger attacks

## 10. Key Lifecycle

- Generation:
  - Personal: client generates `secretKey` / `accountSalt`
  - Organization: client-side org key is distributed per member (ECDH-P256)
- Storage:
  - Personal: `secretKey` stored wrapped by `wrappingKey`
  - Organization: per-member wrapped org keys are stored in `OrgMemberKey`
- Use:
  - Decryption keys materialize in runtime only after unlock
- Rotation:
  - Versioned rollout (`keyVersion`)
- Destruction / revocation:
  - lock / logout / expiry clears key material
  - extension tokens expire by revoke + TTL

## 11. Extension Trust Boundary

- `popup`: user interaction and UI
- `background (SW)`: token lifecycle, API access, decrypt orchestration
- `content script`: minimal DOM bridge to page context
- Boundary rules:
  - no persistent secret material in content script
  - strict separation of site origin and extension origin responsibilities
  - suppress inline suggestions on `serverUrl` origin

## 12. Incident Response Runbook (Minimum)

### 12.1 Suspected extension token leak

1. Revoke immediately via `DELETE /api/extension/token`  
2. Invalidate affected sessions (global logout if needed)  
3. Review audit logs (source IP/time/actions)

### 12.2 Suspected server secret leak

1. Rotate `AUTH_SECRET` / `SHARE_MASTER_KEY` / `VERIFIER_PEPPER_KEY`  
2. Assess blast radius (share links/sends decryptability, sessions)  
3. Trigger key re-issuance and forced re-auth where required

### 12.3 Suspected DB leak

1. Contain exposure path and preserve forensic evidence  
2. Invalidate tokens/sessions  
3. Guide passphrase reset and key rotation steps

## 13. Security Test Matrix (Risk Mapping)

- AAD tamper/transplant: decryption must fail
- Vault unlock:
  - valid passphrase succeeds
  - invalid passphrase fails + rate limit enforced
- Extension token:
  - TTL expiry
  - refresh success/failure
  - revoke denies further access
- CSP:
  - violation report ingestion works
  - no `unsafe-*` policy regressions
- Extension:
  - inline suppressed on same app origin
  - fill path remains user-action-driven

## 14. Stored Data and Rationale (Current Implementation)

### 14.1 Web App

- `memory`:
  - `encryptionKey` (`CryptoKey`)
  - `secretKeyRef` (`Uint8Array`)
  - Rationale: keep decryption material out of persistent storage
- `sessionStorage`:
  - `psso:skip-beforeunload-once` (temporary flag)
  - Rationale: UX control only (e.g., close-tab flow), no secrets
- `localStorage`:
  - Watchtower UI helper state (e.g., display/ack timestamps)
  - Rationale: usability only; no secret material

### 14.2 Browser Extension

- `chrome.storage.local`:
  - `serverUrl`, `autoLockMinutes`
  - Rationale: persistent settings; non-secret
- `chrome.storage.session`:
  - `token`, `expiresAt`, `userId`, `vaultSecretKey` (for re-derivation)
  - Rationale:
    - MV3 Service Worker restarts otherwise drop state too aggressively
    - session scope is cleared on browser close
    - token is short-lived (15m) with refresh + revoke
    - `vaultSecretKey` is an explicit UX/security tradeoff
- `background memory`:
  - `encryptionKey`, `currentToken`, etc.
  - Rationale: required for runtime operations; cleared on lock/expiry

### 14.3 Explicitly Not Stored

- Plaintext passphrase
- Decrypted plaintext entries
- Server secrets such as `AUTH_SECRET` / `SHARE_MASTER_KEY`

### 14.4 Why This Is Accepted

- Principle: keep secrets memory-centric whenever possible.
- Practical constraint: MV3 SW lifecycle makes pure memory-only extension state
  operationally unstable for real usage.
- Therefore, `chrome.storage.session` is used with compensating controls:
  TTL, scoped tokens, revoke endpoints, and auto-lock.
- This remains a policy-sensitive area and should be periodically re-evaluated.

## 15. Key Sharing (Emergency Access)

### 15.1 What is shared (and what is not)

- Shared: owner's `secretKey` (wrapped for controlled recovery access)
- Not shared: plaintext passphrase, plaintext long-term private keys

### 15.2 Key exchange and wrapping method (current)

- Implementation: `src/lib/crypto-emergency.ts`
- Method: `wrapVersion=1` (`ECDH-P256`)
- Flow:
  1. grantee generates ECDH key pair
  2. grantee private key is encrypted at rest with grantee `encryptionKey`
  3. owner generates ephemeral ECDH key pair
  4. derive shared secret via `ECDH(ownerEphemeralPriv, granteePub)`
  5. HKDF (`SHA-256`, random 32-byte salt, info=`passwd-sso-emergency-v1`)
  6. use derived AES-256-GCM key to wrap owner `secretKey`

### 15.3 AAD binding

- AAD is fixed-order: `grantId|ownerId|granteeId|keyVersion|wrapVersion`
- Byte representation is deterministic (no JSON ordering ambiguity)
- Purpose: prevent ciphertext transplant/replay across grants

### 15.4 Main DB-stored artifacts

- `ownerEphemeralPublicKey`
- `encryptedSecretKey`, `secretKeyIv`, `secretKeyAuthTag`
- `hkdfSalt`
- `wrapVersion`, `keyVersion`

### 15.5 Revocation and rotation

- Grant state transitions (requested/approved/revoked) control usability
- `keyVersion` preserves rotation consistency
- Designed for future phased migration to `wrapVersion=2` (PQC hybrid)
