# Cryptography Whitepaper

This document describes the cryptographic architecture of passwd-sso.
For the full domain separation ledger, see [crypto-domain-ledger.md](crypto-domain-ledger.md).
For threat assumptions and non-cryptographic trust boundaries, see [threat-model.md](threat-model.md).

Last updated: 2026-04-28

---

## 1. Design Principles

1. **Zero-knowledge server**: The server never sees plaintext passwords or encryption keys.
2. **Domain separation**: Every key derivation uses a unique HKDF info string; every ciphertext is AAD-bound to its context.
3. **Defense in depth**: Passphrase → KDF → wrapping key → secret key → derived keys. Compromise of one layer does not immediately compromise all data.
4. **Forward compatibility**: KDF parameters and protocol versions are stored per-user, enabling algorithm migration without breaking existing data.

## 2. Key Hierarchy

### 2.1 Personal Vault

```text
User passphrase
    │
    ├─ accountSalt (random 256-bit, stored in DB)
    │
    ▼
PBKDF2-SHA256 (600k iterations)        ─── or ─── Argon2id (64MB, p=4, t=3)
    │                                               │
    ▼                                               ▼
wrappingKey (AES-256, non-extractable)
    │
    ├── wraps ──► secretKey (random 256-bit, stored encrypted in DB)
    │
    ▼
secretKey
    │
    ├── HKDF("passwd-sso-enc-v1")  ──► encryptionKey (AES-256-GCM)
    │       └── encrypts vault entries (blob + overview)
    │
    ├── HKDF("passwd-sso-auth-v1") ──► authKey (HMAC-SHA256)
    │       └── SHA-256(authKey) = authHash (sent to server for verification)
    │
    └── HKDF("passwd-sso-ecdh-v1") ──► ecdhWrappingKey (AES-256-GCM)
            └── wraps ECDH-P256 private key
```

### 2.2 Team Vault

```text
Team creation:
    teamKey = random 256-bit symmetric key

Key distribution (per member):
    ECDH(ephemeral, memberPublicKey) ──► sharedSecret
        │
        ▼
    HKDF("passwd-sso-team-v1", salt=random) ──► teamWrappingKey
        │
        └── wraps teamKey ──► stored as TeamMemberKey in DB
            (AAD scope "OK": teamId, userId, keyVersion, wrapVersion)

Entry encryption:
    teamKey
        │
        ├── HKDF("passwd-sso-team-enc-v1") ──► teamEncryptionKey
        │       └── encrypts entry blob + overview (legacy, itemKeyVersion=0)
        │           (AAD scope "OV": teamId, entryId, vaultType)
        │
        └── wraps ItemKey (per entry, itemKeyVersion>=1)
            (AAD scope "IK": teamId, entryId, teamKeyVersion)

    ItemKey (random 256-bit, per TeamPasswordEntry; identified by a
             server-minted item_key_id, replaced by the re-key pass — §6.2):
        │
        ├── HKDF("passwd-sso-item-enc-v1") ──► itemEncryptionKey
        │       └── encrypts entry blob + overview + history rows
        │           (AAD scope "OV": teamId, entryId, vaultType, itemKeyVersion)
        │
        └── HKDF("passwd-sso-item-cekwrap-v1", salt=32 zero bytes) ──► cekWrapKey
                └── wraps each attachment CEK (encryptionMode=2)
                    (AAD scope "TW": teamId, entryId, attachmentId,
                     itemKeyVersion, cekWrapAadVersion)

    CEK (random 256-bit, per team attachment, encryptionMode=2):
        └── encrypts the attachment body (AAD scope "AT": entryId, attachmentId)
```

Legacy team attachments are `encryptionMode = 1` (body encrypted directly under
`itemEncryptionKey`) or `encryptionMode = 0` (body under the team encryption key
at the attachment's `keyVersion`). New uploads are mode 2 only; the re-key pass
migrates modes 0/1 to mode 2 before it re-keys the entry (§6.2).

### 2.3 Recovery Key

```text
recoveryKey (random 256-bit, shown to user once)
    │
    ├── HKDF("passwd-sso-recovery-wrap-v1", salt=random)
    │       └── wraps secretKey
    │
    └── HKDF("passwd-sso-recovery-verifier-v1", salt=empty)
            └── verifierKey ──► SHA-256 ──► verifierHash
                (server stores HMAC(pepper, verifierHash))
```

### 2.4 Emergency Access

```text
Grantee requests access:
    ephemeralKeyPair = ECDH-P256.generate()

Owner escrows vault:
    ECDH(ephemeral, granteePublicKey) ──► sharedSecret
        │
        ▼
    HKDF("passwd-sso-emergency-v1", salt=random) ──► sharedKey (AES-256-GCM)
        │
        └── encrypts secretKey ──► stored as escrow in DB

Grantee activates (after waiting period):
    ECDH(granteePrivateKey, ephemeralPublicKey) ──► sharedSecret
        │
        ▼
    HKDF("passwd-sso-emergency-v1", salt=stored) ──► sharedKey
        │
        └── decrypts escrow ──► secretKey ──► can derive encryptionKey
```

## 3. KDF Specification

### 3.1 PBKDF2 (kdfType=0)

| Parameter | Value |
| --- | --- |
| Algorithm | PBKDF2-HMAC-SHA256 |
| Iterations | 600,000 (minimum enforced) |
| Salt | accountSalt (256-bit random, per user) |
| Output | 256-bit AES-GCM key |
| Extractable | false |

### 3.2 Argon2id (kdfType=1)

| Parameter | Default | Minimum |
| --- | --- | --- |
| Algorithm | Argon2id v1.3 |  |
| Memory | 65,536 KiB (64 MB) | 32,768 KiB (32 MB) |
| Parallelism | 4 | 1 |
| Iterations (time cost) | 3 | 2 |
| Salt | accountSalt (256-bit random) |  |
| Output | 256 bits |  |

Implementation: `hash-wasm` (WASM, RFC 9106-conformant per cross-impl agreement with `@noble/hashes/argon2id` in `src/lib/crypto/argon2-vectors.test.ts`) for web/extension; `argon2` (native) for CLI.

Fallback: If WASM instantiation fails (CSP, old browser), the client falls back to PBKDF2 and notifies the user. The selected kdfType is persisted to the user record.

### 3.3 Passphrase Verifier

Separate from the wrapping key to prevent correlation:

```text
verifierSalt = SHA-256("verifier" || accountSalt)
verifierKey  = PBKDF2(passphrase, verifierSalt, 600k, SHA-256, 256-bit)
verifierHash = SHA-256(verifierKey)
Server stores: HMAC(serverPepper, verifierHash)
```

## 4. Encryption Algorithms

| Context | Algorithm | Key size | IV | Auth tag |
| --- | --- | --- | --- | --- |
| Vault entry data | AES-256-GCM | 256 bits | 96 bits (random) | 128 bits |
| Secret key wrapping | AES-256-GCM | 256 bits | 96 bits (random) | 128 bits |
| Team key wrapping | AES-256-GCM | 256 bits | 96 bits (random) | 128 bits |
| ItemKey wrapping | AES-256-GCM | 256 bits | 96 bits (random) | 128 bits |
| Attachment data | AES-256-GCM | 256 bits | 96 bits (random) | 128 bits |
| Emergency access escrow | AES-256-GCM | 256 bits | 96 bits (random) | 128 bits |
| Recovery key wrapping | AES-256-GCM | 256 bits | 96 bits (random) | 128 bits |

All encryption uses the Web Crypto API (`crypto.subtle`). CryptoKey objects are created with `extractable: false` where possible.

### 4.1 HKDF Usage Notes

HKDF ([RFC 5869](https://www.rfc-editor.org/rfc/rfc5869)) is used for all key derivation from high-entropy input key material (IKM). Design rationale:

- **Zero salt**: Personal vault HKDF derivations use an empty (zero-length) salt. Per [RFC 5869 §2.2](https://www.rfc-editor.org/rfc/rfc5869#section-2.2), an absent salt is equivalent to "a string of HashLen zeros"; the skipped-extract rationale in [§3.3](https://www.rfc-editor.org/rfc/rfc5869#section-3.3) justifies using HKDF with such a salt when the IKM is already a uniformly random cryptographic key (256-bit `secretKey`). Domain separation is achieved exclusively via distinct `info` labels.
- **Non-zero salt**: Team key wrapping and recovery key wrapping use a random salt per operation. The salt is stored alongside the wrapped key and serves as a domain separator in addition to the `info` label.
- **Info labels**: Each derivation path uses a unique info string (e.g., `passwd-sso-enc-v1`, `passwd-sso-auth-v1`). The full ledger is maintained in [crypto-domain-ledger.md](crypto-domain-ledger.md).

## 5. AAD (Additional Authenticated Data) Binding

Every ciphertext is bound to its context via AAD. This prevents:
- Cross-entry ciphertext transplant
- Cross-user ciphertext reuse
- Cross-scope key confusion

### 5.1 AAD Binary Format

```text
[scope: 2B ASCII] [aadVersion: 1B uint8] [nFields: 1B uint8]
[field_len: 2B BE] [field: N bytes UTF-8] x nFields
```

### 5.2 AAD Scopes

| Scope | Purpose | Fields |
| --- | --- | --- |
| `PV` | Personal vault entry | userId, entryId |
| `OV` | Team vault entry | teamId, entryId, vaultType, itemKeyVersion |
| `AT` | Attachment | entryId, attachmentId |
| `IK` | ItemKey wrapping | teamId, entryId, teamKeyVersion |
| `AW` | Personal attachment CEK wrap | entryId, attachmentId, cekKeyVersion, cekWrapAadVersion |
| `TW` | Team attachment CEK wrap (CEK wrapped with HKDF-SHA256(ItemKey, salt = 32 zero bytes, info `passwd-sso-item-cekwrap-v1`)) | teamId, entryId, attachmentId, itemKeyVersion, cekWrapAadVersion |
| `OK` | Team member key wrapping | teamId, toUserId, keyVersion, wrapVersion |

The scopes above use the structured E2E AAD format. Separately, the **server-side**
(non-E2E) share-link / Send crypto under `SHARE_MASTER_KEY` (`crypto-server.ts`)
binds its ciphertext to the owning tenant with a plain-string AAD
`share-data:v1:<tenantId>`, preventing a ciphertext from being transplanted
across tenant rows under the shared master key. Decrypt falls back to no-AAD so
rows written before AAD binding still decrypt; a new (bound) ciphertext moved
across tenants fails both paths and is rejected.

## 6. Key Rotation

### 6.1 Personal Vault

#### 6.1.a Passphrase change (secretKey unchanged)

1. Derive new wrapping key from new passphrase
2. Re-wrap existing secret key with new wrapping key
3. Recompute auth hash and passphrase verifier
4. Entry data is NOT re-encrypted (secret key unchanged)

#### 6.1.b Vault key rotation (secretKey replaced)

A separate flow that replaces the user's `secretKey` and bumps `keyVersion`:

1. Client generates a fresh `secretKey` and derives the new encryption key.
2. Client re-encrypts every `PasswordEntry` and `PasswordEntryHistory` row,
   re-wraps the user's ECDH private key, and submits the bundle to
   `POST /api/vault/rotate-key`.
3. Server validates the submitted entry/history sets exactly match the user's
   current rows, then atomically (under `pg_advisory_xact_lock`) updates all
   rows + the user wrapping + creates a new `VaultKey` row.

#### 6.1.c Cleared at rotation (consumers of the previous secretKey)

To enforce "remove the previous `secretKey` from the trust boundary", the
rotation transaction also clears or invalidates every server-side artifact
that wrapped the previous `secretKey`:

| Consumer | Action |
|---|---|
| `User.recovery*` (Recovery Key wrapping) | All wrapping fields cleared. `recoveryKeyInvalidatedAt` set so the regenerate-flow UI distinguishes "lost via rotation" from "never set up". |
| `EmergencyAccessGrant` (escrow ECDH wrapping) | Status flipped to `STALE` for all grants in `IDLE` / `REQUESTED` / `ACTIVATED`. `ownerEphemeralPublicKey` is nulled — defeats grantee unwrap (`unwrapSecretKeyAsGrantee` requires it to derive the ECDH shared key) while preserving the wrapping ciphertext + `keyVersion` + `wrapVersion` for forensic trail. |
| `WebAuthnCredential.prfEncryptedSecretKey` | All wrapping fields cleared on every credential. `prfSupported` is intentionally NOT touched — it represents the authenticator's PRF capability, not wrapping presence. The user re-bootstraps via `POST /api/webauthn/credentials/[id]/prf` (separate Redis challenge namespace, advisory lock, keyVersion CAS). |
| `Session` / `ExtensionToken` / `ApiKey` / `McpAccessToken` / `McpRefreshToken` / `DelegationSession` | All revoked via `invalidateUserSessions`. `cacheTombstoneFailures` count is recorded in the audit metadata so silent Redis outages remain forensically visible. |

Previous `secretKey` is removed from the trust boundary. File bodies remain
encrypted under their stable, freshly-rewrapped CEK (the body is not
re-encrypted; only the CEK wrap is). An attacker who recovered the old
`secretKey` AND a pre-rotation snapshot of `cekEncrypted` rows would still
recover plaintext from the snapshot; rotation freshness is bound to backup
hygiene.

#### 6.1.d Personal attachments under CEK indirection

Each personal-entry attachment uses a randomly generated 256-bit AES-GCM
Content Encryption Key (CEK):

1. The file body is encrypted with the CEK using data AAD scope `"AT"`
   (fields: `entryId`, `attachmentId`). This AAD is stable across rotations —
   the body ciphertext is never re-encrypted.
2. The CEK is wrapped with the user's vault `secretKey` using wrap AAD scope
   `"AW"` (fields: `entryId`, `attachmentId`, `cekKeyVersion`,
   `cekWrapAadVersion`). Including `cekKeyVersion` in the wrap AAD prevents
   replay of a pre-rotation wrap blob after rotation, because the AAD bytes
   change with each new key version.
3. Vault rotation re-wraps each CEK with the new `secretKey` (under the new
   `cekKeyVersion`). File bodies are not re-encrypted.
4. Pre-Phase-B attachments (`encryptionMode = 0`, encrypted directly under the
   vault key without a CEK layer) migrate to mode-2 the first time their owner
   runs vault rotation: the client decrypts the body with the old `secretKey`,
   generates a fresh CEK, encrypts the body under the CEK, wraps the CEK under
   the old `secretKey`, and commits the result via `PUT .../migrate` before the
   rotation POST. After migration, the attachment behaves identically to a
   freshly uploaded mode-2 attachment.
5. **Snapshot-window risk**: Mode-2 wraps written by the legacy-migration flow
   under the OLD `secretKey` persist in the database and backup tape until the
   corresponding rotation POST commits and re-wraps them under the NEW
   `secretKey`. An operator who aborts mid-migration leaves these wraps in the
   OLD-key trust posture; the next rotation cycle clears them. Backup tape
   retains the OLD-key wrap forever — rotation freshness is bound to backup
   hygiene.
6. **Object keys and the migrate write**: on an external blob backend
   (S3/Azure/GCS) every object key carries a generation the server draws from
   its CSPRNG (`<prefix>personal/<entryId>/<attachmentId>/<generation>.bin`;
   team attachments use the same form under `team/<teamId>/`; the pre-generation
   form without `/<generation>` is still read). A rewrite never
   overwrites an existing object in place: upload and migrate write a fresh key
   before their transaction, delete it if the transaction fails, and delete the
   superseded object after commit. A stored ref is accepted only when every id
   segment equals the row's own (no `..`, percent-encoding or empty segment); an
   undecodable ref fails closed. The personal migrate verifies the client's hash
   against the stored body read through the blob store and writes the new
   ciphertext through it (previously it hashed and overwrote the DB column
   directly, which on an external backend holds the object ref, not the body).
   Objects orphaned by a crash between commit and the post-commit delete
   keep old ciphertext until removed by hand.

#### 6.1.e Known limitation: ECDH identity is NOT rotated (cross-domain attack surface)

`User.ecdhPublicKey` is stable across personal vault rotations. An attacker
who recovers the previous `secretKey` via any of the cleared consumers above
AND has access to a backup of the previous `User.encryptedEcdhPrivateKey`
(re-wrapped during rotation but the OLD wrapping persists in backups)
recovers the user's stable ECDH private key → unwraps every team's
`TeamMemberKey` row for this user → decrypts team entries.

Personal vault rotation does NOT defend against this cross-domain backup-
compromise scenario. A future "compromise rotation" mode that also rotates
`ecdhPublicKey` and reissues every `TeamMemberKey` row for the user is
tracked separately (Phase B+). For incident-response scenarios, contact
your tenant admin.

### 6.2 Team Key Rotation

A rotation replaces the team key; a **re-key pass** that follows it replaces
each entry's ItemKey. Rotation alone leaves an entry's live blob, history and
attachments under one ItemKey forever, so a departed member holding that ItemKey
(or an old team key plus an old wrap) would read the entry's later edits from any
ciphertext obtained later.

**Rotation** (one atomic POST, team row locked):

1. Generate new TeamKey; re-wrap it for each active member via ECDH.
2. For each entry with `itemKeyVersion >= 1`, open its ItemKey with the team key
   at the entry's own `teamKeyVersion` and re-wrap it under the new TeamKey (`IK`
   AAD with the new `teamKeyVersion`). The ItemKey, its `item_key_id`, the
   entry data, history and attachments are unchanged.
3. Entries with `itemKeyVersion = 0` (legacy, no ItemKey) are decrypted with the
   old TeamKey and re-encrypted under the new one.
4. An entry the rotating admin cannot open is **carried** unchanged with a
   reason: `not_held` (the server verifies the actor holds no key at that
   version), `undecryptable` (AES-GCM fails under a key the actor's own member-key
   wrap authenticated) or `key_invalid` (the actor's member-key row at that
   version fails to unwrap); the last two are accepted only from a holder of that
   version. Each carried entry is audited with its reason and the actor, and
   stays pending.

**Entry key state**: `item_key_team_key_version` (the "marker") is the team key
version at which the entry's current ItemKey was created; an entry is *pending*
while it is below the team's `teamKeyVersion` (trashed and archived entries
included). Only entry creation and the re-key POST raise it; an edit, a v0→v1
upgrade or a rotation never does. `item_key_version_high_water` is never
lowered; every new ItemKey takes `high_water + 1`, recomputed by the server under
the entry lock, so an `itemKeyVersion` (and therefore an `OV`/`TW` AAD) is never
reused for a different ItemKey. A new wrap whose IV equals the locked row's or a
history row's is refused. The marker records the client's claim to have re-keyed
the entry; the server checks set completeness and snapshots, not that the new
ItemKey differs from the old.

**Re-key pass** (client-driven, per entry, after rotation; any member with
`TEAM_UPDATE` who holds the needed keys can run or resume it):

1. A v0 entry is first upgraded to v1 by an ordinary entry update; legacy team
   attachments (`encryptionMode` 0/1) are migrated to mode 2 (body re-encrypted
   under a fresh CEK, CEK wrapped under the entry's ItemKey with `TW`).
2. The client generates a new ItemKey, re-encrypts the blob, overview and every
   history row it can open under it (a history row is opened by its own wrap,
   else by AES-GCM trial with every ItemKey the client holds for the entry), and
   re-wraps every attachment CEK under it. CEKs are re-wrapped, not replaced.
   An entry whose live row or an attachment no available key opens is skipped
   and reported, not posted.
3. The POST is refused unless the submitted history and attachment sets exactly
   match the locked rows, every snapshot (`blobIv`, `cekIv`, ItemKey IV) matches,
   the team key version is still current and no mode 0/1 attachment remains. It
   writes the new `item_key_id` into the entry, every re-keyed history row and
   every attachment, sets the marker to the current version, checks the result
   for consistency before commit, and writes a `TEAM_ENTRY_REKEY` audit row in
   the same transaction.
4. History rows the client cannot open are **retained** under their old wrap
   and old `item_key_id` (listed in the audit row). They are revisited only when
   the entry becomes pending again at the next rotation and a holder of their
   version re-keys it first.

After an entry is re-keyed, content written to it is unreadable with its
previous ItemKey. The stated limits are listed in §7.6.

**Legacy `aadVersion` 0 and history restore**: every client reader of a live
team entry (web, extension, iOS) verifies the `OV` AAD at the entry's
`itemKeyVersion`, whatever `aadVersion` the server reports, so a server cannot
drop the AAD by labelling an entry 0. The stored `aadVersion` is consulted only
by the paths that re-seal a legacy row at AAD 1 (the rotation's v0 re-encryption,
the v0→v1 upgrade and the re-key pass) and by the history view, which only
displays a history row. A history restore is not one of them: the client refuses
a history row below `aadVersion` 1 before decrypting it (nothing binds such a
row to the entry, so re-sealing it would turn a substituted ciphertext into an
AAD-bound live entry), and the server refuses it too (`HISTORY_ROW_LEGACY`).
The exit is restoring a more recent version. A restorable row is opened at
strict AAD and sent as the blob and the overview rebuilt from it, both re-sealed
under the row's key at AAD 1; the server writes them with `aadVersion = 1` (the
history row itself is unchanged), so no live entry is ever written at
`aadVersion` 0.

## 7. Threat Analysis (What-If Scenarios)

### 7.1 Server database compromised

**Attacker obtains**: Encrypted blobs, wrapped keys, account salts, KDF params, auth hashes, verifier hashes (peppered).

**Cannot obtain**: Plaintext passwords, secret keys, wrapping keys.

**Attack surface**: Offline brute force against passphrase via PBKDF2/Argon2id. Cost: ~$10M+ for a single strong passphrase at 600k PBKDF2 iterations (estimated 2026 GPU pricing).

### 7.2 Server actively malicious (evil server)

**Attacker can**: Serve modified client code, intercept passphrase entry, withhold or delete encrypted data.

**Mitigations**: CSP prevents inline script injection; SRI could be added for static assets. Client-side verification artifact ensures correct key derivation. Audit logs record all mutations.

**Limitation**: A fully compromised server that serves malicious JavaScript can capture passphrases at entry time. This is a fundamental limitation of web-based E2E encryption.

### 7.3 Extension compromised

**Attacker can**: Access vault secret key in memory during an active session. Stored ciphertext in `chrome.storage.session` is not directly usable without the ephemeral wrapping key.

**Mitigations**:
- Sensitive session fields are encrypted with an ephemeral AES-256-GCM key before storage. The wrapping key is non-extractable and held only in memory.
- On service worker full restart, the ephemeral key is lost and stored ciphertext becomes undecryptable, forcing re-authentication.
- `chrome.storage.session` is scoped to browser session (cleared on browser close) and restricted to `TRUSTED_CONTEXTS`.
- Token TTL limits exposure window. Content scripts run in isolated worlds.

**Residual risk**: An attacker with arbitrary code execution in the extension context can read the in-memory secret key during an active session. This is an inherent limitation of browser extension architecture.

### 7.4 IdP compromised (Google/SAML)

**Attacker can**: Authenticate as the user (gain session access).

**Cannot do**: Decrypt vault data (requires passphrase for KDF → wrapping key → secret key).

**Mitigations**: Vault passphrase is independent of SSO authentication. Two-factor: SSO + vault passphrase.

### 7.5 Recovery key compromised

**Attacker can**: Decrypt the user's secret key and access all vault data.

**Mitigations**: Recovery key is shown once and never stored on server. User is instructed to store securely offline. Server stores only HMAC(pepper, verifierHash) for recovery verification.

### 7.6 Team member removed but retains data

**Attacker has**: Previously decrypted team data, potentially cached keys.

**Mitigations**: Team key rotation issues a new TeamKey to the remaining members only, and the re-key pass that follows gives every entry a new ItemKey, re-encrypting its blob, overview and history and re-wrapping its attachment CEKs (§6.2). After an entry is re-keyed, content written to it is unreadable with the old team key or the old ItemKey. Previously accessed plaintext cannot be retroactively protected (inherent limitation of shared secrets).

**Stated limits** of the re-key pass:

- Until an entry is re-keyed, edits to it still use its old ItemKey. Admins see the pending count; the pass starts right after rotation.
- History rows the re-keyer cannot open are retained under their old wrap and stay readable to holders of the old key (no worse than before the pass).
- Entries no active member can open are carried unchanged and counted as unrecoverable.
- An entry carried on a holder's `undecryptable` or `key_invalid` claim stays readable by every holder of its old version, departed members included, until another holder re-keys it. The claim is unverifiable by the server; it is shown in the pending count and audited per entry with the reason and the actor.
- Attachment CEKs are re-wrapped, not replaced: a CEK the departed member already unwrapped, and any downloaded material, stay readable to them.
- Backups, WAL, versioned buckets and objects orphaned by a crash between commit and the post-commit delete keep the old ciphertext and wraps.
- Re-keyed history rows and migrated attachments keep their original attribution although an admin rewrote the ciphertext; the rewrite is attributed only in the audit log.
