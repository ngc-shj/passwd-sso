# Emergency Access — PQC Migration Design

## 1. Background

Emergency Access uses ECDH (P-256) key exchange to wrap the owner's `secretKey` for a grantee.
While ECDH-P256 is secure against classical computers, it is vulnerable to quantum attacks
("harvest now, decrypt later"). This document defines the migration path to a hybrid
ECDH + ML-KEM (FIPS 203) scheme, with all necessary specifications locked down.

## 2. Wrap Version Registry

| wrapVersion | keyAlgorithm | Description | Status |
|-------------|-------------|-------------|--------|
| 1 | `ECDH-P256` | ECDH P-256 → HKDF(SHA-256, random salt) → AES-256-GCM | **Active** |
| 2 | `HYBRID-ECDH-P256-MLKEM768` | ECDH P-256 + ML-KEM-768 hybrid → KDF → AES-256-GCM | **Planned** |

### Version semantics

- `wrapVersion` is immutable per escrow — re-escrow creates a new version
- `keyAlgorithm` is a human-readable label stored alongside `wrapVersion`
- Decryption must always use the `wrapVersion` recorded in the grant
- New escrows always use the latest version (`CURRENT_WRAP_VERSION`)

## 3. AAD Canonicalization Specification

AAD (Additional Authenticated Data) binds ciphertext to grant context, preventing
ciphertext transplant attacks between grants.

### Format (v1, v2 共通)

```text
UTF-8 encoded pipe-separated string:
  "{grantId}|{ownerId}|{granteeId}|{keyVersion}|{wrapVersion}"
```

### Rules

1. Fields are concatenated in **fixed order** (grantId, ownerId, granteeId, keyVersion, wrapVersion)
2. Separator: ASCII pipe `|` (0x7C)
3. Integer fields (`keyVersion`, `wrapVersion`) are decimal string representations (`String(n)`)
4. Encoding: UTF-8 via `TextEncoder.encode()`
5. No trailing separator, no padding, no JSON

### Example

```text
Input:
  grantId    = "clxyz123abc"
  ownerId    = "clusr_owner_001"
  granteeId  = "clusr_grantee_002"
  keyVersion = 1
  wrapVersion = 1

AAD string: "clxyz123abc|clusr_owner_001|clusr_grantee_002|1|1"
AAD bytes:  UTF-8 encoding of above string
```

### Why not JSON
- `JSON.stringify()` key order is implementation-defined for numeric keys
- Object property ordering varies across environments
- Pipe-separated fixed-order format guarantees byte-identical AAD

## 4. Cryptographic Specification

### v1: ECDH-P256 (Current)

```
1. Owner generates ephemeral ECDH key pair (P-256)
2. salt ← random(32 bytes)
3. sharedBits ← ECDH(ownerEphemeralPrivate, granteePublic)    // 256 bits
4. hkdfKey ← HKDF-Extract(sharedBits)
5. wrappingKey ← HKDF-Expand(hkdfKey, salt, "passwd-sso-emergency-v1")  // AES-256
6. iv ← random(12 bytes)
7. aad ← buildAAD({grantId, ownerId, granteeId, keyVersion=1, wrapVersion=1})
8. ciphertext‖authTag ← AES-256-GCM(wrappingKey, iv, aad, secretKey)
```

Storage:

- `ownerEphemeralPublicKey`: JWK JSON string
- `encryptedSecretKey`: hex(ciphertext)
- `secretKeyIv`: hex(iv) — 24 chars
- `secretKeyAuthTag`: hex(authTag) — 32 chars
- `hkdfSalt`: hex(salt) — 64 chars
- `wrapVersion`: 1
- `keyAlgorithm`: "ECDH-P256"

### v2: Hybrid ECDH-P256 + ML-KEM-768 (Planned)

```text
1. Owner generates ephemeral ECDH key pair (P-256)
2. ecdhSharedBits ← ECDH(ownerEphemeralPrivate, granteePublic)  // 256 bits
3. (kemCiphertext, kemSharedSecret) ← ML-KEM-768.Encapsulate(granteeKemPublicKey)
4. salt ← random(32 bytes)
5. combinedSecret ← ecdhSharedBits ‖ kemSharedSecret             // 256 + 256 bits
6. hkdfKey ← HKDF-Extract(combinedSecret)
7. wrappingKey ← HKDF-Expand(hkdfKey, salt, "passwd-sso-emergency-v2")  // AES-256
8. iv ← random(12 bytes)
9. aad ← buildAAD({grantId, ownerId, granteeId, keyVersion=1, wrapVersion=2})
10. ciphertext‖authTag ← AES-256-GCM(wrappingKey, iv, aad, secretKey)
```

Storage (v1 fields + additional):

- `kemCiphertext`: base64(kemCiphertext) — ML-KEM-768 ciphertext (~1088 bytes)
- `kemPublicKey`: base64(granteeKemPublicKey) — stored on grant acceptance
- `wrapVersion`: 2
- `keyAlgorithm`: "HYBRID-ECDH-P256-MLKEM768"

### Hybrid design rationale

- **Not KEM-only**: If ML-KEM is broken, ECDH still provides classical security
- **Concatenated secrets**: Both shared secrets contribute to HKDF input
- **HKDF info version bump**: `"passwd-sso-emergency-v2"` ensures domain separation from v1
- **AAD includes wrapVersion**: Prevents downgrade — v2 ciphertext cannot be passed off as v1

## 5. DB Schema (PQC-Ready)

### EmergencyAccessGrant — New nullable columns

```prisma
// ML-KEM fields (v2, nullable until PQC migration)
kemCiphertext  String? @map("kem_ciphertext") @db.Text
kemPublicKey   String? @map("kem_public_key") @db.Text
```

- `kemCiphertext`: ML-KEM-768 encapsulated ciphertext (base64), set during key escrow (v2)
- `kemPublicKey`: Grantee's ML-KEM-768 public key (base64), set during grant acceptance (v2)
- Both `null` for v1 grants — presence indicates v2 escrow

## 6. STALE Trigger Conditions

A grant transitions to `STALE` when existing escrow data becomes invalid:

| Trigger | From states | Description |
|---------|-------------|-------------|
| Owner keyVersion bump | IDLE, ACTIVATED | Owner changed passphrase → secretKey unchanged but keyVersion incremented |
| Algorithm upgrade (v1 → v2) | IDLE, ACTIVATED | System requires re-escrow with new algorithm |
| Owner secretKey rotation | IDLE, ACTIVATED | Future: full key rotation support |

### STALE → Re-escrow flow

```text
1. System detects trigger condition
2. Grant status: IDLE/ACTIVATED → STALE
3. STALE grants appear in `GET /api/emergency-access/pending-confirmations`
4. Owner vault unlock → auto-confirm runs `confirmPendingEmergencyGrants()`
5. createKeyEscrow() uses CURRENT_WRAP_VERSION (may be v2 now)
6. POST /api/emergency-access/[id]/confirm → STALE → IDLE
7. New wrapVersion/keyAlgorithm stored on grant
```

### State machine rules for STALE

```text
IDLE → STALE (trigger detected)
ACTIVATED → STALE (trigger detected, access revoked until re-escrow)
STALE → IDLE (re-escrow completed)
STALE → REVOKED (owner cancels)
STALE ✗ REQUESTED (cannot request while stale — grantee must wait)
STALE ✗ ACTIVATED (cannot access while stale)
```

## 7. v1 → v2 Migration Path

### Phase 1: Foundation (current)

- [x] `keyAlgorithm` field (default "ECDH-P256")
- [x] `wrapVersion` field (default 1)
- [x] HKDF with random salt (domain separation ready)
- [x] AAD canonicalization with wrapVersion included
- [x] STALE status and transitions
- [x] `kemCiphertext` / `kemPublicKey` nullable DB columns
- [x] `buildAAD` canonicalization tests with known vectors

### Phase 2: ML-KEM Integration (future, when Web Crypto supports ML-KEM or via wasm)

1. Bump `CURRENT_WRAP_VERSION` to 2
2. Update `HKDF_EMERGENCY_INFO` to `"passwd-sso-emergency-v2"`
3. Update `createKeyEscrow()`:
   - Generate ECDH + ML-KEM key pairs
   - Concatenate both shared secrets as HKDF input
   - Store `kemCiphertext` in DB
4. Update `unwrapSecretKeyAsGrantee()`:
   - ML-KEM.Decapsulate + ECDH → combined secret
5. Update grant acceptance flow:
   - Generate ML-KEM key pair alongside ECDH
   - Store `kemPublicKey` on grant
6. Mark all existing IDLE/ACTIVATED grants as STALE → re-escrow with v2
7. Add tests for v2 round-trip and v1↔v2 rejection

### Phase 3: PQC-Only (far future, post ML-KEM standardization)

- Optional: remove ECDH, use ML-KEM only (`wrapVersion=3`)
- Requires confidence in ML-KEM security

## 8. Compatibility Matrix

| Escrow version | Decrypt with v1 code | Decrypt with v2 code |
|----------------|---------------------|---------------------|
| v1 (ECDH-P256) | Yes | Yes (backward compatible) |
| v2 (Hybrid) | No (fails: no KEM support) | Yes |

- v2 code MUST support v1 decryption (read `wrapVersion` from grant, branch accordingly)
- v1 ciphertext with `wrapVersion=1` → ECDH-only path
- v2 ciphertext with `wrapVersion=2` → hybrid path

## 9. Security Considerations

- **Downgrade prevention**: AAD includes `wrapVersion`, so v2 ciphertext cannot be replayed as v1
- **Hybrid security**: Security level = max(ECDH-P256, ML-KEM-768). If either is secure, so is the hybrid
- **Key independence**: ECDH and ML-KEM key pairs are independent; compromise of one doesn't affect the other
- **Forward secrecy**: Each escrow uses fresh ephemeral ECDH + fresh KEM encapsulation
- **STALE enforcement**: Once STALE, grantee cannot access vault until re-escrow completes with current algorithm
