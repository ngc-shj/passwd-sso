# P0: Security Foundations Plan

Source: [external-security-assessment-roadmap.md](../review/external-security-assessment-roadmap.md)

---

## Scope

Three documentation + schema items that establish the groundwork for future
security improvements. No cryptographic changes — only data model preparation
and reference documentation.

---

## Item 1: KDF Metadata Persistence

### Problem

`PBKDF2_ITERATIONS = 600_000` is hardcoded in 4 locations:

- `src/lib/crypto-client.ts:12,22`
- `cli/src/lib/crypto.ts:8,17`
- `extension/src/lib/crypto.ts:3`
- `src/lib/export-crypto.ts:10`

No per-user KDF parameters in DB. Future migration to Argon2id or iteration
increase requires all clients to be updated simultaneously.

### Solution

#### 1a. Schema Change

Add KDF metadata columns to the `User` model in `prisma/schema.prisma`.
KDF params belong on User because they represent "the current KDF config for
this user" — a single value per user, alongside `accountSalt` and `keyVersion`.
`VaultKey` stores per-version key material and would require JOIN to get
current params.

```prisma
model User {
  // ... existing fields (accountSalt, keyVersion, etc.) ...

  kdfType        Int @default(0) @map("kdf_type")
  // 0 = PBKDF2-SHA256 (only value accepted in P0)
  kdfIterations  Int @default(600000) @map("kdf_iterations")
  kdfMemory      Int? @map("kdf_memory")
  // Argon2id memory cost in KiB (future, P2)
  kdfParallelism Int? @map("kdf_parallelism")
  // Argon2id parallelism (future, P2)
}
```

#### 1b. Migration

Create Prisma migration that adds columns with defaults matching current config.
Existing rows get `kdfType=0, kdfIterations=600000` automatically.

#### 1c. API Changes

Return KDF params in vault status/unlock endpoints.
All endpoints that return KDF params are **authenticated** (session or
extension token via `authOrToken()`).
KDF params are not secret, but exposing them only to authenticated users
limits attacker reconnaissance of work factor.

- `GET /api/vault/status` — include `kdfType`, `kdfIterations` in response
  (already queries User model, no JOIN needed)
- `GET /api/vault/unlock/data` — include KDF params so client knows how to derive
  (already queries User, add KDF fields to select)
- `POST /api/vault/setup` — accept optional KDF params on initial setup.
  If omitted, server applies defaults (`kdfType=0, kdfIterations=600000`).

Note: Extension tokens can access `/api/vault/status` and `/api/vault/unlock/data`
via `authOrToken()`. KDF params are cryptographically public information
(like salt), so this is acceptable. No new unauthenticated endpoints expose
KDF params.

#### 1d. Client Changes

All clients read KDF params from server response instead of hardcoded constants.
For this phase, the values will match current hardcoded values — no behavioral change.

**Backward compatibility:** Hardcoded constants remain as fallback. If the server
response does not include KDF params (e.g., older API version), clients fall back
to the existing hardcoded `PBKDF2_ITERATIONS = 600_000`. This ensures older
clients and newer servers (or vice versa) remain interoperable.

- `src/lib/crypto-client.ts` — add `deriveWrappingKeyWithParams(passphrase, salt, params?)`.
  When `params` is undefined, use hardcoded constants. Existing `deriveWrappingKey()`
  unchanged (calls new function with defaults). Unit test: verify both paths produce
  identical keys.
- `cli/src/lib/crypto.ts` — read from API response, fallback to constants
- `extension/src/lib/crypto.ts` — read from API response, fallback to constants
- `src/lib/export-crypto.ts` — continue using constants (export format is independent)

#### 1e. Validation

Add KDF params validation inline in `src/app/api/vault/setup/route.ts`
(matching existing `setupSchema` pattern — inline in route handler).

```typescript
// P0: Only PBKDF2 (kdfType=0) is accepted.
// Argon2id (kdfType=1) support added in P2.
const kdfParamsSchema = z.object({
  kdfType: z.literal(0),
  kdfIterations: z.number().int().min(600_000).max(10_000_000),
  kdfMemory: z.undefined(),
  kdfParallelism: z.undefined(),
}).optional();
```

Key design decisions:

- **`kdfType: z.literal(0)`** — Only PBKDF2 accepted in P0. Prevents storing
  `kdfType=1` (Argon2id) before the algorithm is implemented. P2 will extend
  this to a discriminated union.
- **`min(600_000)`** — Matches OWASP 2023 recommendation for PBKDF2-SHA256.
  Prevents downgrade even if session is hijacked.
- **`kdfMemory/kdfParallelism: z.undefined()`** — Rejected in P0 since only
  PBKDF2 is supported. These params are Argon2id-specific.
- **`.optional()`** — Entire object is optional. If omitted from setup request,
  server applies defaults.

Server-side enforcement: even if a client sends `kdfIterations: 100_000`,
the server rejects it. The minimum is hardcoded server-side to prevent
downgrade via API manipulation.

When KDF params are stored (setup or future re-key), emit an audit log entry
with `AUDIT_ACTION.VAULT_SETUP` metadata including `kdfType` and `kdfIterations`.

#### 1f. Scope Boundaries

- **Export format** (`src/lib/export-crypto.ts`): Uses its own KDF params for
  export file encryption. Independent of per-user vault KDF — no change needed.
- **Backup metadata**: Backups contain encrypted vault data but do not embed
  KDF params. On restore, params are read from the DB (populated by migration).
- **Argon2id migration**: Out of scope for P0. This phase only adds the schema
  columns and API plumbing. Actual algorithm switching is P2 (roadmap item #10).
- **KDF parameter change API**: `POST /api/vault/setup` is one-time only
  (`vaultSetupAt` check). A dedicated KDF change API (e.g., `POST /api/vault/rekey`)
  is P2 scope. Vault reset + re-setup uses server defaults, preventing
  downgrade through the reset path.

#### 1g. Migration Rollback

The migration only adds nullable/defaulted columns. Rollback:

- Drop the added columns via a reverse migration
- No data loss — existing columns are untouched
- Clients fall back to hardcoded constants automatically

### Testing

#### Existing test updates

- `src/app/api/vault/status/route.test.ts` — add `kdfType`, `kdfIterations`
  to response assertions
- `src/app/api/vault/unlock/data/route.test.ts` — add KDF fields to
  `mockPrismaUser` return value + response assertions
- `src/app/api/vault/setup/route.test.ts` — add KDF params to `validBody`,
  verify stored in DB via mock transaction assertions
- `src/__tests__/helpers/fixtures.ts` — add `kdfType: 0`, `kdfIterations: 600000`
  to `makeUser()` defaults

#### New tests

- Unit: vault setup stores KDF params when provided
- Unit: vault setup applies defaults when KDF params omitted
- Unit: vault status returns KDF params from User model
- Unit: vault unlock/data returns KDF params
- Unit: validation rejects `kdfType=1` (Argon2id not yet supported)
- Unit: validation rejects `kdfIterations < 600_000` (downgrade prevention)
- Unit: validation rejects `kdfIterations` as float
- Unit: validation rejects `kdfMemory` when `kdfType=0`
- Unit: `deriveWrappingKeyWithParams()` with explicit params produces same
  key as `deriveWrappingKey()` with hardcoded constants
- Unit: `deriveWrappingKeyWithParams()` without params falls back to constants
- Integration: full setup -> unlock flow with KDF params from DB

#### CI script tests

- `scripts/__tests__/check-crypto-domains.test.mjs` — test the ledger
  verification script with fixture files (matching, mismatching, missing entries)

### Risk

Low — columns have defaults, no crypto behavior changes.
Rollback is a simple column drop with no data loss.

---

## Item 2: Crypto Domain Separation Ledger

### Problem

HKDF `info` strings and AAD scopes are scattered across multiple files.
No single reference to verify scope collision or missing separation.

### Solution

Create `docs/security/crypto-domain-ledger.md` documenting all crypto domains.

Must be verified against actual code in:

- `src/lib/crypto-client.ts`
- `src/lib/crypto-team.ts`
- `src/lib/crypto-emergency.ts`
- `src/lib/crypto-aad.ts`
- `src/lib/crypto-server.ts`
- `src/lib/export-crypto.ts`

Document format:

| Domain | HKDF info | AAD scope | Salt strategy | File |
|---|---|---|---|---|
| Vault wrapping | `passwd-sso-v1` | `PE` | accountSalt | crypto-client.ts |
| Vault verifier | (verifierSalt derived) | — | SHA-256("verifier" \|\| accountSalt) | crypto-client.ts |
| Team key wrap | `passwd-sso-team-v1` | `OK` | random per-wrap | crypto-team.ts |
| Team entry enc | `passwd-sso-team-enc-v1` | `TE` | empty (teamKey is unique) | crypto-team.ts |
| ECDH priv wrap | `passwd-sso-ecdh-v1` | — | empty | crypto-team.ts |
| Emergency access | (verify actual info) | `EA` | (verify) | crypto-emergency.ts |
| Export | (verify actual info) | — | (verify) | export-crypto.ts |
| Server-side | (verify) | — | (verify) | crypto-server.ts |

### Automated Verification

Add a CI script `scripts/check-crypto-domains.mjs` that:

- Greps all `crypto-*.ts` files for HKDF `info` strings and AAD scope constants
- Compares against the ledger document
- Fails CI if any undocumented domain is found or if a documented domain is missing

This ensures the ledger stays in sync as new crypto features are added.

### Testing

- `scripts/__tests__/check-crypto-domains.test.mjs` — test the CI script itself
  with fixture data: normal ledger+code match, undocumented domain in code,
  documented domain missing from code. Follows existing pattern from
  `scripts/__tests__/check-licenses.test.mjs`.
- No application code changes.

### Risk

None.

---

## Item 3: Key Retention/Deletion Policy

### Problem

No documented policy for how long old key material is retained,
when it can be safely deleted, or how revoked member keys are handled.

### Solution

Create `docs/security/key-retention-policy.md` covering:

1. **TeamMemberKey retention**
   - Old versions retained indefinitely while team has history entries
     encrypted with that version
   - Cleanup: safe to delete after all history re-encrypted with newer version

2. **History decryption key lifetime**
   - Minimum retention: as long as any history entry references that teamKeyVersion
   - Maximum history entries per entry: 20 (existing trim logic)

3. **Revoked member key handling**
   - TeamMemberKey for revoked user: mark as revoked, do not delete
     (audit trail + potential dispute resolution)
   - Team key rotation mandatory after revoke
   - Revoked user cannot obtain new TeamMemberKeyEnvelope

4. **Backup key metadata**
   - Encrypted backups may contain old key versions
   - Restore must handle version mismatch gracefully
   - Document: backup does NOT include TeamMemberKey (server-side only)

5. **Personal vault key retention**
   - masterKeyVersion tracked in env/schema
   - Old wrapped secret keys: retained for recovery scenarios
   - Recovery key: independent lifecycle

### Testing

No code changes — documentation only.

### Risk

None.

---

## Acceptance Criteria

- [ ] Migration adds KDF columns to User model with correct defaults
- [ ] `GET /api/vault/status` returns KDF params
- [ ] `POST /api/vault/setup` accepts and stores KDF params (optional, defaults applied)
- [ ] `GET /api/vault/unlock/data` returns KDF params
- [ ] Validation rejects `kdfType != 0` and `kdfIterations < 600_000`
- [ ] All existing tests pass (updated mocks/assertions for new fields)
- [ ] New tests cover KDF param storage, retrieval, validation, and client fallback
- [ ] `deriveWrappingKeyWithParams()` produces identical keys with default params
- [ ] `docs/security/crypto-domain-ledger.md` created and verified against code
- [ ] `scripts/check-crypto-domains.mjs` added with tests
- [ ] `docs/security/key-retention-policy.md` created
- [ ] No hardcoded iteration constants removed (backward compatibility maintained)
- [ ] Audit log emitted when KDF params stored during vault setup
