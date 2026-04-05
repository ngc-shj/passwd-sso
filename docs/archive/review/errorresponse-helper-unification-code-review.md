# Code Review: errorresponse-helper-unification
Date: 2026-04-05
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F1 [Major] notifications/route.ts L51-53 INVALID_CURSOR catch not migrated
- Resolution: Fixed — replaced with `errorResponse(API_ERROR.INVALID_CURSOR, 400)`

### F2 [Major] DELEGATION_ENTRIES_NOT_FOUND status changed 403→404
- Problem: Original 403 intentionally avoided confirming entry existence. 404 creates an ID enumeration oracle.
- Resolution: Reverted to 403

### F3 [Minor] validationError(parsed.error) not using .flatten()
- Resolution: Changed to `validationError(parsed.error.flatten())` matching codebase pattern

## Security Findings

### S1 [Minor] 403→404 status change (same as F2)
- Resolution: Merged with F2 — reverted to 403

## Testing Findings
No findings — all 4 updated test files verified correct, no remaining old assertions

## Adjacent Findings
None

## Quality Warnings
None

## Resolution Status
### F1 — notifications INVALID_CURSOR
- Action: Replaced NextResponse.json with errorResponse
- File: src/app/api/notifications/route.ts:51

### F2 — DELEGATION_ENTRIES_NOT_FOUND status
- Action: Reverted 404→403, updated test assertion
- Files: src/app/api/vault/delegation/route.ts:148, route.test.ts:246-250

### F3 — validationError flatten
- Action: Changed parsed.error → parsed.error.flatten()
- File: src/app/api/vault/delegation/route.ts:83
