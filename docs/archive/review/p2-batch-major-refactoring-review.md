# Plan Review: p2-batch-major-refactoring
Date: 2026-03-14
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### Finding 1 [Major] — isTeamMode detection fragile after prop grouping
- **Problem**: `isTeamMode` relies on `!!getPasswordProp` which becomes always truthy after fetchers grouping
- **Impact**: Personal mode misidentified as team mode, breaking E2E decryption flow
- **Recommended action**: Add explicit `mode: "personal" | "team"` prop
- **Resolution**: Reflected in plan — explicit mode prop added to Item 14 requirements and implementation steps

### Finding 2 [Major] — TeamAuthError.message type mismatch
- **Problem**: `TeamAuthError.message` is `string` but `errorResponse()` expects `ApiErrorCode`, causing 55+ type errors
- **Impact**: Build failures or unsafe `as` casts during migration
- **Recommended action**: Change `TeamAuthError.message` to `ApiErrorCode` type in Phase 1
- **Resolution**: Reflected in plan — added as pre-requisite step 1 in Phase 1

### Finding 3 [Minor] — withTenantRls() usage undocumented for services
- **Problem**: Service functions may call Prisma outside RLS context
- **Impact**: Multi-tenant data leakage risk
- **Recommended action**: Document RLS requirement in service files
- **Resolution**: Reflected in plan — RLS rule added to Item 15 section

## Security Findings

### Finding 1 [Major] — CryptoKey leak via runtime as-cast
- **Problem**: Discriminated union can be bypassed with runtime `as` cast, leaking CryptoKey to team path
- **Impact**: Encryption key compromise
- **Recommended action**: Ensure team callback type excludes `encryptionKey` field
- **Resolution**: Reflected in plan — explicit exclusion noted in Phase 4 step 19

### Finding 2 [Major] — Audit log gap between service completion and logging
- **Problem**: If execution is interrupted after service call but before audit log, no audit trail
- **Impact**: Compliance violation (SOC 2, ISO 27001)
- **Recommended action**: Use try/finally pattern
- **Resolution**: Reflected in plan — audit logging pattern added to Item 15 section and Phase 3 step 16

### Finding 3 [Minor] — tenantId omission risk
- **Already addressed**: Branded type `AuthenticatedTenantId` + required parameter

### Finding 4 [Minor] — Error code enumeration oracle
- **Skipped**: Authentication-related errors already use generic codes (UNAUTHORIZED, NOT_FOUND)

## Testing Findings

### Finding 1 [Major] — Missing generatorSettings change detection test
- **Problem**: `personal-login-form-derived.test.ts` lacks generatorSettings change test
- **Impact**: Regression risk for generator settings diff detection
- **Recommended action**: Add test case
- **Resolution**: Reflected in plan — added as Phase 4 step 17

### Finding 2 [Minor] — Snapshot test naming confusion
- **Skipped**: Will be addressed during implementation, not a plan-level issue

### Finding 3 [Major] — Service test mock granularity undefined
- **Problem**: No requirement for success + error test cases per service function
- **Impact**: Insufficient test coverage
- **Recommended action**: Require 2 test cases minimum per function
- **Resolution**: Reflected in plan — Phase 3 step 15 updated

### Finding 4 [Major] — VALIDATION_ERROR details not verified in route tests
- **Problem**: Most route tests only check `error === "VALIDATION_ERROR"` without details
- **Impact**: Silent details field breakage
- **Recommended action**: Add details.fieldErrors assertions
- **Resolution**: Reflected in plan — Phase 1 step 3 updated to include details verification

### Finding 5 [Major] — No password-card.test.tsx exists
- **Problem**: No baseline tests for PasswordCard before refactoring
- **Impact**: Regressions undetectable
- **Recommended action**: Create baseline test file with 3 minimum cases
- **Resolution**: Reflected in plan — Phase 2 step 7 added

### Finding 6 [Minor] — No password-list.test exists
- **Skipped**: Out of scope for Item 14, recommended as follow-up
