# Code Review: auth-session-improvements
Date: 2026-03-13T00:00:00+09:00
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F-1 [Minor] passkey test missing ip/userAgent value assertions
- **File**: `src/app/api/auth/passkey/verify/route.test.ts` L171-177
- **Problem**: Test used `expect.objectContaining` without asserting `ip` and `userAgent` values
- **Fix**: Added `ip: null, userAgent: null` to assertion

### F-2 [Minor] AsyncLocalStorage propagation not verified in integration
- **File**: `src/auth.ts` L286, L298
- **Problem**: `sessionMetaStorage.getStore()` propagation depends on Auth.js internals; unit test mocks bypass this
- **Decision**: Skipped — known risk, manual verification recommended

### F-3 [Minor] useEffect inline style inconsistency
- **File**: `src/lib/vault-context.tsx` L157
- **Problem**: `useEffect(() => { updateRef.current = update; }, [update])` was single-line, inconsistent with project style
- **Fix**: Expanded to multi-line format

## Security Findings

### S-1 [Minor] rotate-master-key scope should be TENANT not TEAM
- **File**: `src/app/api/admin/rotate-master-key/route.ts` L146
- **Problem**: MASTER_KEY_ROTATION uses AUDIT_SCOPE.TEAM but is a tenant-wide operation
- **Decision**: Skipped — existing design issue, out of scope for this PR

### S-2 [Minor] operatorId impersonation risk
- **File**: `src/app/api/admin/rotate-master-key/route.ts` L114-121
- **Problem**: operatorId from request body can be any user ID
- **Decision**: Skipped — existing design issue, out of scope for this PR

## Testing Findings

No findings specific to this branch's changes.

## Resolution Status

### F-1 [Minor] passkey test ip/userAgent assertions
- Action: Added `ip: null, userAgent: null` to `expect.objectContaining`
- Modified file: `src/app/api/auth/passkey/verify/route.test.ts:171-179`

### F-3 [Minor] useEffect style
- Action: Expanded to multi-line format
- Modified file: `src/lib/vault-context.tsx:157-159`
