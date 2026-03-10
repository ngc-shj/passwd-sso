# Code Review: fix-sso-tenant-first-signin
Date: 2026-03-11
Review round: 3

## Round 1-2 (prior session)
Initial implementation reviewed. Two Major testing findings (T-1, T-2) fixed.
All three agents returned "No findings" in Round 2.

## Round 3 (full re-review after all commits)

### Local LLM Pre-screening Results
No issues found.

### Functionality Findings

#### F-1 [Minor] Missing warning log when tenantClaimStorage context is not active
- **Problem**: Silent fallback to bootstrap tenant if ALS store is undefined.
- **Action**: Skipped — route handler correctly wraps with `tenantClaimStorage.run()`.

#### F-2 [Minor] check-bypass-rls: function reference passing pattern
- **Problem**: Changing `includes` to `BYPASS_CALL_RE.test` could miss `withBypassRls` passed as function reference.
- **Action**: Skipped — no such pattern exists in codebase.

### Security Findings

#### S-1 [Major] Bootstrap migration missing ApiKey table
- **Problem**: `apiKey` rows not migrated during bootstrap→SSO tenant migration. API keys become inaccessible after migration.
- **Action**: **Fixed** — added `tx.apiKey.updateMany` to migration transaction.

#### S-2 [Major] Bootstrap migration missing WebAuthnCredential table
- **Problem**: `webAuthnCredential` rows not migrated. Passkey auth and PRF vault unlock break after migration.
- **Action**: **Fixed** — added `tx.webAuthnCredential.updateMany` to migration transaction.

#### S-3 [Minor] Bootstrap migration missing Notification table
- **Problem**: `notification` rows not migrated. Old notifications become invisible after migration.
- **Action**: **Fixed** — added `tx.notification.updateMany` to migration transaction.

### Testing Findings

#### T-1 [Minor] Double P2002 collision path untested
- **Problem**: The code path where both `create` calls fail with P2002 (returning `null`) was untested.
- **Action**: **Fixed** — added test "returns null on double P2002 collision" to `tenant-management.test.ts`.

#### T-2 [Minor] signIn test missing upsert assertion
- **Problem**: Test "stores tenant claim" didn't assert that `ensureTenantMembershipForSignIn` was skipped.
- **Action**: **Fixed** — added `expect(mockPrisma.tenantMember.upsert).not.toHaveBeenCalled()`.

## Resolution Status

### S-1 [Major] ApiKey migration
- Action: Added `tx.apiKey.updateMany` to bootstrap→SSO migration in `src/auth.ts`
- Modified file: src/auth.ts:128-131

### S-2 [Major] WebAuthnCredential migration
- Action: Added `tx.webAuthnCredential.updateMany` to bootstrap→SSO migration in `src/auth.ts`
- Modified file: src/auth.ts:132-135

### S-3 [Minor] Notification migration
- Action: Added `tx.notification.updateMany` to bootstrap→SSO migration in `src/auth.ts`
- Modified file: src/auth.ts:125-128

### T-1 [Minor] Double P2002 test
- Action: Added test in `src/lib/tenant-management.test.ts`
- Modified file: src/lib/tenant-management.test.ts:111-125

### T-2 [Minor] signIn upsert assertion
- Action: Added assertion in `src/auth.test.ts`
- Modified file: src/auth.test.ts:483

## Round 4 (Round 2 of re-review)
Functionality: No findings
Security: S-4 (Major) Team-related models not migrated — **Skipped (pre-existing, out of PR scope)**. Team migration requires complex logic (teams have no userId) and should be a separate PR.
Testing: No findings

All findings within PR scope resolved. Review complete.
