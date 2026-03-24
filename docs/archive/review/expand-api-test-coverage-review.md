# Plan Review: expand-api-test-coverage
Date: 2026-03-23T00:00:00+09:00
Review round: 2 (final)

## Changes from Previous Round
Initial review

## Functionality Findings

### [F1] Major: seedUser/seedSession must include tenant_id
- **Problem**: Users table has tenant_id NOT NULL. All seedUser/seedSession calls need explicit tenant_id.
- **Impact**: FK constraint violation or tenant isolation logic mismatch for all 7 new users.
- **Recommended action**: Seed a test Tenant record first in global-setup, pass tenant_id to all user/session seeds.
- **Status**: To be addressed in plan update

### [F2] Major: cleanup() FK dependency order unspecified
- **Problem**: Plan says "add FK-ordered deletion" but doesn't list specific tables or order.
- **Impact**: Teardown FK violations, leftover data causing next-run seed failures.
- **Recommended action**: Add explicit ordered table list to plan.
- **Status**: To be addressed in plan update

### [F3] Major: Multi-user context switching strategy undefined
- **Problem**: Teams/EA tests need 2 sessions; plan doesn't specify which approach.
- **Impact**: Implementation variance, flaky tests.
- **Recommended action**: Specify browser.newContext() for multi-user, with sample pattern.
- **Status**: To be addressed in plan update

### [F4] Minor: seedPasswordEntry dummy data format unspecified
- **Problem**: PasswordEntry has NOT NULL columns for IV, authTag, etc.
- **Recommended action**: Use e2e/helpers/crypto.ts aesGcmEncrypt() for real encrypted data.
- **Status**: To be addressed in plan update

### [F5] Minor: auth-error test scenarios undefined
- **Problem**: No specifics on what auth-error.spec.ts should test.
- **Recommended action**: Add 1-3 concrete scenarios.
- **Status**: To be addressed in plan update

## Security Findings

### [S1] Major: assertTestDatabase() pattern matching too loose
- **Problem**: Regex matches anywhere in URL, not just hostname/dbname.
- **Impact**: Misconfigured DATABASE_URL could allow test operations on prod DB.
- **Recommended action**: Parse URL and validate hostname separately.
- **Status**: Out of scope for this plan (pre-existing issue, not introduced by this change). Note for future hardening.

### [S2] Minor: .auth-state.json contains plaintext tokens
- **Status**: Pre-existing behavior, not introduced by this plan. Note for future improvement.

### [S3] Minor: seedPasswordEntry should use real crypto
- **Status**: Same as F4 — addressed together.

### [S4] Minor: EA seed bypasses state transition guards
- **Recommended action**: Add at least one negative test (REQUESTED + future waitExpiresAt → 403).
- **Status**: To be addressed in plan update

## Testing Findings

### [T1] Critical: cleanup() missing tables for new specs
- **Status**: Same root cause as F2 — addressed together.

### [T2] Critical: Destructive tests (passphrase-change, key-rotation) leave user in altered state
- **Problem**: After passphrase change, getAuthState().passphrase is stale. CI retries will fail.
- **Impact**: Test suite instability on retry.
- **Recommended action**: Add vault re-seed function or ensure these specs are self-contained.
- **Status**: To be addressed in plan update

### [T3] Major: Infrastructure changes need more specifics
- **Status**: Same as F1 — addressed together.

### [T4] Major: EA state machine not tested through UI
- **Recommended action**: Test at least IDLE → REQUESTED → ACTIVATED via UI.
- **Status**: To be addressed in plan update (combined with S4)

### [T5] Major: tenantAdmin needs Tenant + TenantMember records
- **Status**: Already in plan but needs specifics — addressed with F1.

### [T6] Minor: share-link-public.spec.ts token dependency on share-link.spec.ts
- **Recommended action**: Seed known share link in global-setup for public tests.
- **Status**: To be addressed in plan update

## Round 2 Updates

### Resolved in Round 2
- [F1-F5] All Round 1 findings addressed in plan update
- [S3-S4] Security findings addressed (S4 partially — EA unit test added as minor item)
- [T1-T6] All Round 1 testing findings addressed

### New findings from Round 2 (all addressed in plan)
- seedSession() signature needs tenant_id (Critical → addressed)
- password_entry_histories missing from cleanup (Major → added)
- watchtower_alerts removed (doesn't exist in schema)
- personal_log_access_grants, webauthn_credentials added to cleanup
- seedShareLink token design: use randomBytes + SHA-256 hash (not hardcoded)
- ON CONFLICT DO NOTHING → UPSERT for idempotent re-runs

### Out of scope (pre-existing issues, not introduced by this plan)
- assertTestDatabase() URL pattern matching (S1)
- .auth-state.json plaintext tokens (S2)
- Existing vault-setup.spec.ts destructive test ordering
- Existing lockout test stale state with ON CONFLICT DO NOTHING

## Adjacent Findings
None reported.
