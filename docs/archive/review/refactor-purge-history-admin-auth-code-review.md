# Code Review: refactor-purge-history-admin-auth
Date: 2026-03-20
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F1 [Major] — operatorId tenantId non-deterministic with findFirst
- **Problem**: findFirst without ORDER BY may return unpredictable tenantId for multi-tenant admins
- **Impact**: Audit log tenantId could vary
- **Action**: Skipped — users belong to one tenant in practice; adding tenantId body param is scope creep

### F3 [Minor] — userAgent not passed to logAudit
- **Action**: Fixed — added `userAgent` to audit log call

## Security Findings

### S1 [Minor] — userAgent missing from audit (same as F3)
- **Action**: Fixed

### S2 [Minor] — operatorId format validation
- **Action**: Skipped — existing pattern (rotate-master-key) doesn't validate cuid format

### S3 [Conditional] — multi-tenant operatorId (same as F1)
- **Action**: Skipped

## Testing Findings

### T1 [Major] — MEMBER/deactivated tests don't verify WHERE args
- **Action**: Fixed — added `where.role` and `where.deactivatedAt` assertions

### T2 [Major] — dryRun doesn't verify count WHERE clause
- **Action**: Fixed — added cutoffDate verification to dryRun test

### T4 [Minor] — auth order test missing
- **Action**: Fixed — added "checks rate limit after auth" test

## Adjacent Findings
None

## Resolution Status
### F3/S1 [Minor] userAgent missing from audit
- Action: Added `userAgent` to `extractRequestMeta` destructuring and `logAudit` call
- Modified file: src/app/api/maintenance/purge-history/route.ts:86-99

### T1 [Major] WHERE arg verification
- Action: Added assertions for `where.role` and `where.deactivatedAt` in MEMBER/deactivated tests
- Modified file: src/app/api/maintenance/purge-history/route.test.ts:151,162

### T2 [Major] dryRun cutoffDate
- Action: Added `mockCount.mock.calls[0][0].where.changedAt.lt` assertion
- Modified file: src/app/api/maintenance/purge-history/route.test.ts:246-249

### T4 [Minor] auth order test
- Action: Added "checks rate limit after auth" test case
- Modified file: src/app/api/maintenance/purge-history/route.test.ts:253-263
