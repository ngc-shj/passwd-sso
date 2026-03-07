# Code Review: p0-security-foundations

Date: 2026-03-07
Review rounds: 2

## Round 1

### Functionality Findings

#### F1: `deriveWrappingKeyWithParams()` ignores `kdfType` (RESOLVED)

- **File:** `src/lib/crypto-client.ts:104-131`
- **Problem:** Function only used `kdfIterations`, silently ignored `kdfType`.
  Future Argon2id migration could produce wrong keys without error.
- **Action:** Added guard that throws on `kdfType !== 0`.
- **Modified:** `src/lib/crypto-client.ts:109-111`

#### F2: Vault setup uses `getLogger()` instead of `logAudit()` (RESOLVED)

- **File:** `src/app/api/vault/setup/route.ts:146-149`
- **Problem:** Plan required audit log with `AUDIT_ACTION.VAULT_SETUP`.
  Other vault endpoints use `logAudit()` for DB persistence.
- **Action:** Added `VAULT_SETUP` to Prisma enum, audit constants, i18n,
  and `logAudit()` call in route handler.
- **Modified:** `prisma/schema.prisma`, `src/lib/constants/audit.ts`,
  `src/app/api/vault/setup/route.ts`, `messages/en/AuditLog.json`,
  `messages/ja/AuditLog.json`

#### F3: Unused `globSync` import (RESOLVED)

- **File:** `scripts/check-crypto-domains.mjs:12`
- **Action:** Removed unused import.

#### F4: Missing `deriveWrappingKeyWithParams` unit tests (RESOLVED)

- **Action:** Created `src/lib/crypto-client.test.ts` with 5 test cases.

#### F5: Missing `check-crypto-domains` tests (RESOLVED)

- **Action:** Created `scripts/__tests__/check-crypto-domains.test.mjs`
  with 10 test cases covering extraction, comment skipping, and deduplication.

### Security Findings

#### S1: `deriveWrappingKeyWithParams()` ignores `kdfType` (RESOLVED)

- Same as F1. Added defensive guard.

#### S2: Missing `logAudit()` in vault setup (RESOLVED)

- Same as F2. Added audit logging.

#### S3: Client-side KDF params not consumed from server (ACCEPTABLE)

- **Problem:** `vault-context.tsx` still uses `deriveWrappingKey()` (hardcoded).
- **Decision:** Deferred to P2. Current DB defaults match hardcoded values.
  No behavioral change until KDF params are user-configurable.

### Testing Findings

#### T1: Missing `logAudit` mock in setup tests (RESOLVED)

- **Action:** Added `logAudit` and `extractRequestMeta` mocks.

#### T2: Missing `deriveWrappingKeyWithParams` tests (RESOLVED)

- Same as F4.

#### T3: Missing `kdfIterations` upper bound test (RESOLVED)

- **Action:** Added test rejecting `kdfIterations: 20_000_000`.

#### T4: Missing `check-crypto-domains` tests (RESOLVED)

- Same as F5.

#### T5: Missing `kdfMemory` ignore behavior test (RESOLVED)

- **Action:** Added test verifying extra fields are silently ignored.

## Round 2

### Changes from Round 1

All 7 actionable findings resolved. 1 finding (S3) accepted as P2 scope.

### Functionality Findings

#### F6: Unused `KNOWN_HKDF_INFO`/`KNOWN_AAD_SCOPES` constants (RESOLVED)

- **File:** `scripts/check-crypto-domains.mjs:15-28`
- **Problem:** Dead code — `main()` uses dynamic ledger parsing, not these constants.
- **Action:** Removed both unused `Set` declarations.

### Security Findings

#### S4: No client-side minimum iterations guard (RESOLVED)

- **File:** `src/lib/crypto-client.ts:112`
- **Problem:** Defense-in-depth — if server is compromised and returns low
  iterations, client would derive weak key.
- **Action:** Added `iterations < PBKDF2_ITERATIONS` guard that throws.
- **Modified:** `src/lib/crypto-client.ts:113-115`

### Testing Findings

No findings.

## Resolution Status

All findings resolved across 2 rounds:
- Round 1: 7 actionable findings fixed, 1 deferred (S3 → P2)
- Round 2: 2 actionable findings fixed
- Total tests: 3701 passing (361 test files)
