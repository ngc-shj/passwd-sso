# Plan Review: errorresponse-helper-unification
Date: 2026-04-05
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F1 [Major] MCP_CLIENT_LIMIT_EXCEEDED missing from API_ERROR + details handling undefined
- Resolution: Added to new codes list with `errorResponse(code, status, { message })` pattern

### F2 [Major] TenantAuthError pattern replacement not specified
- Resolution: Added 6 instances in 2 files to scope — use `errorResponse(err.message as ApiErrorCode, err.status)`

### F3 [Major] "No tenant" mapping undecided
- Resolution: New `NO_TENANT` code — specific error for tenant membership check failure

### F4 [Minor] "Invalid session ID" mapping unspecified
- Resolution: New `INVALID_SESSION` code

### F5 [Minor] 503 error should use specific code, not INTERNAL_ERROR
- Resolution: New `DELEGATION_STORE_FAILED` code with status 503

## Security Findings

### S1 [Minor] Case inconsistency across codebase
- Resolution: All 16 target files in scope — full unification eliminates mixed case

## Testing Findings

### T1 [Critical] Test impact list incomplete — 10+ assertions missed
- Resolution: Expanded test update table to 14+ entries with exact line numbers

### T2 [Critical] 6 delegation-specific error codes missing from API_ERROR → build failure
- Resolution: All 8 new codes listed with i18n requirements

### T3 [Minor] Plan contradicts itself ("tests pass" vs "case changes")
- Resolution: Removed contradiction — explicitly states tests must be updated

## Adjacent Findings
None

## Quality Warnings
None
