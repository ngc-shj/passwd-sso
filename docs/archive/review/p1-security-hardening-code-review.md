# Code Review: p1-security-hardening

Date: 2026-03-07
Review round: 2

## Changes from Previous Round

Round 1 findings resolved:
- S2: tenantId made required in invalidateUserSessions() signature
- S4: persist-credentials: false added to CodeQL workflow
- T1: Error propagation test added
- T4-T7: SCIM audit metadata tests added (DELETE success counts, DELETE/PUT/PATCH failure flags)

Round 1 findings acknowledged (no code change):
- S1: fail-open monitoring — operational concern, documented
- S3: Trivy SHA pinning — documented as deviation D1
- T2: reason param test — low priority, unused parameter
- T3: counts non-leak test — low priority, implementation prevents this

## Functionality Findings

No findings.

## Security Findings

No findings.

## Testing Findings

No findings.

## Resolution Status

### S2: tenantId optional allows cross-tenant session deletion
- Action: Made tenantId required in function signature
- Modified file: src/lib/user-session-invalidation.ts:11-12

### S4: CodeQL checkout persist-credentials not set
- Action: Added persist-credentials: false
- Modified file: .github/workflows/codeql.yml:23-25

### T1: Error propagation test missing
- Action: Added test for error propagation from Promise.all
- Modified file: src/lib/user-session-invalidation.test.ts:74-79

### T4: SCIM DELETE success audit counts missing
- Action: Added test verifying invalidation counts in audit metadata
- Modified file: src/app/api/scim/v2/Users/[id]/route.test.ts

### T5: SCIM DELETE failure audit flag missing
- Action: Added assertion for sessionInvalidationFailed in existing test
- Modified file: src/app/api/scim/v2/Users/[id]/route.test.ts

### T6: SCIM PATCH invalidation failure test missing
- Action: Added full failure scenario test for PATCH deactivation
- Modified file: src/app/api/scim/v2/Users/[id]/route.test.ts

### T7: SCIM PUT invalidation failure test missing
- Action: Added full failure scenario test for PUT deactivation
- Modified file: src/app/api/scim/v2/Users/[id]/route.test.ts
