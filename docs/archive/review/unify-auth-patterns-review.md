# Plan Review: unify-auth-patterns
Date: 2026-03-14T05:30:00+09:00
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### [F1] Major — api-keys routes lack enforceAccessRestriction, checkAuth would silently add it
- Action: Use `skipAccessRestriction: true` for api-keys routes to preserve existing behavior
- Status: Resolved in plan update

### [F2] Major — passwords/[id] DELETE token support contradicts session-only migration
- Action: DELETE stays session-only. Token support deferred to Phase E with scope design
- Status: Resolved in plan update

### [F3] Minor — vault/status scope_insufficient returns UNAUTHORIZED instead of EXTENSION_TOKEN_SCOPE_INSUFFICIENT
- Action: Normalize to EXTENSION_TOKEN_SCOPE_INSUFFICIENT, update test
- Status: Resolved in plan update

## Security Findings

### [S1] Major — DELETE token support enables permanent deletion via extension tokens (merged with F2)
- Action: DELETE stays session-only in this PR
- Status: Resolved in plan update

### [S2] Minor — api-keys access restriction behavior change (merged with F1)
- Action: skipAccessRestriction: true preserves existing behavior
- Status: Resolved in plan update

### [S3] Minor — allowTokens: true without scope lacks safeguard
- Action: console.warn in development mode
- Status: Resolved in plan update

## Testing Findings

### [T1] Major — api-keys routes have no existing tests
- Action: Create baseline tests before Phase B migration
- Status: Resolved in plan update

### [T2] Major — { scope, allowTokens: false } throw test missing
- Action: Added to test plan
- Status: Resolved in plan update

### [T3] Major — passwords/[id] DELETE tests need mock wiring update
- Action: Accepted exception to "no test modifications" requirement
- Status: Resolved in plan update

### [T4] Minor — Integration test infeasible without DB
- Action: Renamed to "smoke test" with DB layer mocked
- Status: Resolved in plan update

### [T5] Minor — coverage.include should include auth-or-token.ts and access-restriction.ts
- Action: Added to plan
- Status: Resolved in plan update
