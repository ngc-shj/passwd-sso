# Plan Review: quality-security-hardening
Date: 2026-03-18
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F1 [Major] resetValidation user requires db.ts + global-setup.ts changes
- **Problem**: Plan lists only `fixtures.ts` as Key file, but `e2e/helpers/db.ts` (TEST_USERS) and `e2e/global-setup.ts` also need changes
- **Impact**: Missing changes cause `_authState.resetValidation` to be undefined → runtime crash
- **Recommended action**: Add both files to Key files and implementation steps

### F2 [Minor] beforeEach handling unspecified for test.step consolidation
- **Problem**: When consolidating 4 tests into test.step, beforeEach runs once instead of per-test
- **Impact**: Minor — vault unlock only needed once for the chain anyway
- **Recommended action**: Move beforeEach content into test body setup

### F3 [Minor] Coverage threshold may drop below 60% with components added
- **Problem**: Adding src/components/** to coverage.include may drop global coverage below threshold
- **Impact**: CI coverage gate could block all changes
- **Recommended action**: Run coverage check before committing; adjust threshold if needed

## Security Findings

### S1 [Minor] Zod schema not applied to refresh endpoint
- **Problem**: `/api/extension/token/refresh` returns same shape as POST but not mentioned in plan
- **Impact**: Future response shape drift in refresh endpoint goes unvalidated
- **Recommended action**: Share Zod schema between token and token/refresh routes

### S2 [Minor] Key material docs may duplicate existing sections 14.2/14.4
- **Problem**: `considerations/en.md` Section 14.2/14.4 already covers vaultSecretKey risk
- **Impact**: Documentation inconsistency
- **Recommended action**: Update existing sections rather than adding new duplicative content

### S3 [Minor] Vulnerability triage should include extension token scope severity
- **Problem**: Token with `vault:unlock-data` scope warrants higher severity classification
- **Impact**: Delayed triage response for high-impact token leaks
- **Recommended action**: Include scope-based severity mapping in triage doc

## Testing Findings

### T1 [Major] ESLint rule must be separate block scoped to e2e files
- **Problem**: If rule is added to existing component-scoped block, it won't apply to e2e tests
- **Impact**: Rule never fires on e2e tests, defeating its purpose
- **Recommended action**: Add as independent block with `files: ["e2e/**/*.spec.ts"]`

### T2 [Minor] Zod test should verify full response shape
- **Problem**: Existing tests check individual fields but not overall shape
- **Impact**: Schema definition errors could slip through
- **Recommended action**: Add full-shape assertion or Zod safeParse test

## Adjacent Findings
None reported.
