# Code Review: fix-sso-tenant-first-signin
Date: 2026-03-11
Review round: 2 (final)

## Changes from Previous Round
Initial review

## Local LLM Pre-screening Results
No issues found.

## Functionality Findings

### F-1 [Minor] Missing warning log when tenantClaimStorage context is not active
- **Problem**: In `src/auth.ts` signIn callback, when `tenantClaimStorage.getStore()` returns `undefined` but a tenant claim exists, the claim is silently lost. User ends up in bootstrap tenant.
- **Impact**: Silent fallback; hard to diagnose misconfigurations.
- **Recommended action**: Not addressed — route handler correctly wraps with `tenantClaimStorage.run()`. Logging improvement is out of scope for this bug fix.

### F-2 [Minor] `withSessionMeta` naming no longer accurate
- **Problem**: Function in `route.ts` now sets up both session metadata and tenant claim storage, but name only mentions session meta.
- **Impact**: Readability only.
- **Recommended action**: Skipped — minimal change policy. Not a functional issue.

## Security Findings

### S-1 [Major] Bootstrap migration `passwordEntryHistory` missing userId filter (pre-existing)
- **Problem**: In `src/auth.ts` L91, `passwordEntryHistory.updateMany` lacks `userId` filter. Same for `emergencyAccessKeyPair` and `shareAccessLog`.
- **Impact**: If bootstrap tenant had multiple users (shouldn't by design), cross-user data migration could occur.
- **Action**: Skipped — pre-existing code not modified by this PR. Bootstrap tenants are single-user by design.

### S-2 [Minor] `tenantClaimStorage` cleanup after consumption
- **Problem**: Consumed claim is not reset to null after `createUser` reads it.
- **Impact**: No practical risk — `AsyncLocalStorage.run()` scope is request-scoped and auto-cleaned.
- **Action**: Skipped — unnecessary.

## Testing Findings

### T-1 [Major] Missing test: `findOrCreateSsoTenant` throws in `createUser`
- **Problem**: No test verifying error propagation (not fallback) when `findOrCreateSsoTenant` rejects.
- **Action**: **Fixed** — added test "propagates error when findOrCreateSsoTenant throws" to `src/lib/auth-adapter.test.ts`.

### T-2 [Major] Missing test: `getStore()` returns undefined in signIn callback
- **Problem**: No test for when `tenantClaimStorage` context is not active.
- **Action**: **Fixed** — added test "returns true without storing claim when tenantClaimStorage is not active" to `src/auth.test.ts`. Required changing mock from static object to `vi.fn()` for dynamic control.

### T-3 [Major] Missing AsyncLocalStorage integration test
- **Problem**: No end-to-end test verifying signIn → createUser ALS propagation.
- **Action**: Skipped — each unit is tested individually. ALS is a Node.js core API. Integration testing belongs in E2E scope.

## Resolution Status
### T-1 [Major] findOrCreateSsoTenant error propagation test
- Action: Added test in `src/lib/auth-adapter.test.ts`
- Modified file: src/lib/auth-adapter.test.ts:262-281

### T-2 [Major] getStore() undefined test for signIn callback
- Action: Added test in `src/auth.test.ts`; refactored mock to use `vi.fn()` for dynamic getStore control
- Modified files: src/auth.test.ts:9,81,119,415,495-510

## Round 2 Results
All three expert agents (functionality, security, testing) returned **"No findings"**.
All Round 1 fixes verified as correct and complete. No regressions detected.
