# External Security Assessment — ChatGPT Review Summary

Date: 2026-03-07
Reviewer: ChatGPT (GPT-4.5)
Scope: Full repository review — architecture, crypto design, key lifecycle, operations

---

## 1. Overall Evaluation

| Category | vs Mature SaaS (5pt) | vs OSS/Individual (5pt) |
|---|---|---|
| Features | 4 | 5 |
| Design | 4 | 5 |
| Implementation quality | 4 | 5 |
| Operations | 3.5 | 4 |
| Security design | 4.5 | 5 |
| **Overall** | **4.0** | **5.0** |

> "This is well beyond what an individual developer typically produces."

---

## 2. Strengths Identified

### Security Design
- Client-side encryption with AEAD + AAD
- HKDF domain separation
- RLS + tenant isolation
- Bearer bypass allowlist
- Extension token separation

### Key Lifecycle (rated highly)
- `teamKeyVersion` versioning across entries, history, and member keys
- Full re-encryption on rotation (Bitwarden-style)
- Old key retention for history decryption
- AAD version embedding prevents cross-version transplant attacks
- Optimistic lock prevents concurrent rotation

### Implementation
- ~410 test files including e2e, load tests, and extension tests
- RLS enforcement scripts in CI (`check-team-auth-rls.mjs`, `check-bypass-rls.mjs`)
- Structured logging with requestId, audit forwarding, FluentBit
- Health probes (live/ready) with DB + Redis checks

### Crypto Primitives
- `deriveWrappingKey()` / `computePassphraseVerifier()` properly separated
- Auth, enc, and verifier domains isolated
- Server stores `HMAC(pepper, verifierHash)`, not raw verifier
- HKDF `info` strings well-organized
- IV always randomly generated
- AAD uses binary length-prefix format

---

## 3. Action Items — Priority Classification

### 3.1 Fix Now (High Priority)

#### A. Attachment Key Hierarchy

**Problem:** Attachments are encrypted directly with teamKey. Key rotation requires
re-encrypting all attachments (expensive, failure-prone for large files).

**Current:** `teamKey -> attachment data`

**Target (1Password-style):**
```
TeamKey
  -> ItemKey (per entry)
       -> Entry Data
       -> Attachment Data
```

Benefits:
- Rotation only rewraps ItemKey, not attachment data
- Consistent key boundary for entries + attachments
- Reduces rotation transaction size and failure risk

**Files affected:**
- `src/lib/crypto-team.ts` (encryptTeamAttachment/decryptTeamAttachment)
- `src/app/api/teams/[teamId]/passwords/[id]/attachments/route.ts`
- `src/app/api/teams/[teamId]/rotate-key/route.ts`
- `prisma/schema.prisma` (TeamPasswordEntry — add itemKey fields)

#### B. Revoke + Session/Token Kill Enforcement

**Problem:** Member revoke does not guarantee automatic session/token invalidation.
"Revoked but still connected" is the most dangerous state.

**Required linkage on member revoke:**
- Database session deletion
- Refresh token invalidation
- Extension token revocation
- API key boundary check
- Background sync termination

**Files to audit:**
- `src/app/api/teams/[teamId]/members/[memberId]/route.ts`
- `src/lib/extension-token.ts`
- `src/app/api/sessions/route.ts`

#### C. KDF Metadata Persistence

**Problem:** `PBKDF2_ITERATIONS = 600_000` is hardcoded in 4 locations
(crypto-client.ts, CLI, extension, export-crypto). No per-user KDF parameters in DB.

**Required schema addition:**
```
kdfType        Int    @default(0)   // 0=PBKDF2, 1=Argon2id
kdfIterations  Int    @default(600000)
kdfMemory      Int?                 // for Argon2id
kdfParallelism Int?                 // for Argon2id
```

**Migration path:**
1. Add columns with defaults matching current PBKDF2 config
2. Return KDF params in `/api/vault/status` and `/api/vault/unlock/data`
3. All clients read params from server instead of hardcoded constants
4. Future: new users get Argon2id, existing users migrate on next login

**Hardcoded locations to update:**
- `src/lib/crypto-client.ts:12,22`
- `cli/src/lib/crypto.ts:8,17`
- `extension/src/lib/crypto.ts:3`
- `src/lib/export-crypto.ts:10`

---

### 3.2 Improve Later (Medium Priority)

#### D. Argon2id Migration Path

PBKDF2-SHA256 is acceptable given Web Crypto API constraints, but the migration
infrastructure (item C above) should be in place before attempting this.

Implementation options:
- WASM-based Argon2id (e.g., `argon2-browser`)
- New users default to Argon2id, existing users migrate on login
- Old KDF remains read-only compatible during transition

#### E. History Lazy Re-encryption

History entries retain old `teamKeyVersion`. Old `TeamMemberKey` records must be
kept indefinitely to support decryption.

Improvement: on history access, decrypt with old key and re-encrypt with current key.
This allows eventual cleanup of old key material.

Note: Bitwarden also does NOT do this — old key retention is their approach too.

#### F. Key Retention/Deletion Policy Documentation

Define explicit policies for:
- How long old TeamMemberKey versions are retained
- Minimum retention period for history decryption
- Handling of revoked member re-joining
- Old key metadata in backups

#### G. Crypto Domain Separation Ledger

Document all HKDF `info` strings and AAD scopes in a single reference:

| Purpose | HKDF info | AAD scope |
|---|---|---|
| Vault wrapping | `passwd-sso-v1` | `PE` |
| Vault verifier | (verifierSalt) | — |
| Team key wrap | `passwd-sso-team-v1` | `OK` |
| Team entry enc | `passwd-sso-team-enc-v1` | `TE` |
| ECDH priv wrap | `passwd-sso-ecdh-v1` | — |
| Emergency access | `passwd-sso-ea-v1` | `EA` |
| Export | (export-specific) | — |

This prevents accidental scope collision when adding new features.

---

### 3.3 No Change Needed

| Item | Rationale |
|---|---|
| PBKDF2 adoption | Correct trade-off for Web Crypto API compatibility across browser/extension/CLI |
| Wrapping/verifier separation | Auth and enc domains properly isolated |
| AAD version embedding | Prevents cross-version transplant — uncommon in OSS projects |
| Optimistic lock on rotation | Prevents concurrent rotation race conditions |
| Bitwarden-style full re-encryption | Simpler than 1Password key wrapping, easier to audit and debug |
| IV generation | Always random, no reuse risk |
| Server-side verifier storage | HMAC(pepper, hash) — not raw |

---

## 4. Product-Level Findings (Non-Technical)

### Trust Establishment Gap

Password managers require social proof beyond code quality:
- External security audit (Cure53, Trail of Bits, NCC Group)
- Bug bounty program (HackerOne, Bugcrowd)
- Cryptography whitepaper
- Threat model publication (STRIDE / attack surface)
- Reproducible builds (especially for browser extension)

This is a **product stage issue**, not a design flaw. The engineering foundation
is strong enough to support trust-building activities.

### Operations Gaps

| Gap | Impact |
|---|---|
| Incident runbook | No documented response procedures |
| Error tracking | No Sentry or equivalent |
| Redis HA | Single-point-of-failure for sessions/rate-limiting |
| Concurrent session management | No forced logout capability |
| Automated security scanning | npm audit non-blocking, no SAST/container scan |

---

## 5. Comparison with Commercial Products

### How Bitwarden Solves Key Lifecycle
- Full re-encryption on org key rotation (same as this project)
- Old org keys retained for history (same approach)
- Revoke = key rotation + future secrecy only (no backward secrecy)
- Attachments are part of Cipher, re-encrypted via background job + chunk streaming

### How 1Password Solves Key Lifecycle
- `VaultKey -> ItemKey -> Data/Attachment` hierarchy
- Rotation only rewraps ItemKey (attachments untouched)
- Session key short-lived + device key binding + SRP + secret key
- Vault access = session + device + account key (multi-factor decryption)

### This Project's Position
- Key versioning and rotation: on par with Bitwarden
- AAD binding: exceeds typical OSS implementations
- Attachment key hierarchy: gap vs both (fix item A)
- Revoke enforcement: gap vs both (fix item B)

---

## 6. Reviewer's Key Quote

> "The most critical weakness is not features, design, implementation, or operations.
> It is **trust establishment** — and that is a product stage issue, not a technical flaw."

> "The crypto implementation is not 'fix it because it's broken' — it's already at the
> stage of 'maturation and design refinement.'"
