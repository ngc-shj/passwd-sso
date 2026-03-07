# Plan Review: p0-security-foundations

Date: 2026-03-07
Review round: 1

## Changes from Previous Round

Initial review.

## Pre-screening Findings (Local LLM)

9 issues raised, 8 reflected in plan update:

1. Backward compatibility — added fallback strategy
2. Existing data verification — added integration test
3. KDF params exposure — noted endpoints are authenticated
4. KDF downgrade prevention — raised min to 600,000
5. Argon2id migration — marked as P2 scope
6. Docs verification — added CI script + tests
7. Schema drift — noted export/backup independence
8. Rollback strategy — documented
9. Testing scope — expanded significantly

## Functionality Findings

### F1: VaultKey is wrong model for KDF params (RESOLVED)

- **Problem:** VaultKey has multiple rows per user (one per version). KDF params
  are per-user, like accountSalt.
- **Impact:** Requires unnecessary JOIN in vault/status which only queries User.
- **Action:** Changed to User model.

### F2: unlock/data HTTP method wrong (RESOLVED)

- **Problem:** Plan said POST, actual code is GET.
- **Action:** Corrected to GET.

### F3: setupSchema is inline, not in validations.ts (RESOLVED)

- **Problem:** Plan implied validations.ts but schema is inline in route handler.
- **Action:** Specified inline extension matching existing pattern.

### F4: vault/setup is one-time only, no KDF change API (RESOLVED)

- **Problem:** No way to change KDF params after initial setup.
- **Action:** Added to scope boundaries — KDF change API is P2.

## Security Findings

### S1: min(100,000) is 1/6 of OWASP recommendation (RESOLVED)

- **Problem:** OWASP 2023 recommends 600,000 for PBKDF2-SHA256.
- **Impact:** Allows significant downgrade of work factor.
- **Action:** Changed to `min(600_000)`.

### S2: Reset + re-setup downgrade path (RESOLVED)

- **Problem:** After vault reset, re-setup could accept low iterations.
- **Action:** Server applies defaults on omission, validates min(600_000),
  audit log on KDF param storage.

### S3: Extension token can access KDF params (ACCEPTABLE)

- **Problem:** KDF params returned via authOrToken() endpoints.
- **Impact:** Low — KDF params are cryptographically public (like salt).
- **Action:** No change. Documented as acceptable.

## Testing Findings

### T1: Existing test mocks need KDF fields (RESOLVED)

- **Problem:** Mock return values don't include KDF columns.
- **Action:** Listed specific test files to update.

### T2: No makeVaultKey fixture (RESOLVED — N/A)

- **Problem:** Originally for VaultKey model.
- **Action:** Changed to User model — update makeUser() instead.

### T3: check-crypto-domains.mjs needs its own tests (RESOLVED)

- **Problem:** No test for the CI script itself.
- **Action:** Added test plan following check-licenses.test.mjs pattern.

### T4: kdfType/kdfMemory edge case validation (RESOLVED)

- **Problem:** kdfType=1 accepted but Argon2id not implemented.
- **Action:** Changed to `z.literal(0)` for P0. P2 extends to discriminated union.

### T5: Client fallback test method unclear (RESOLVED)

- **Problem:** No concrete test approach for fallback behavior.
- **Action:** Specified `deriveWrappingKeyWithParams()` function with unit tests
  for both explicit params and undefined (fallback) paths.
