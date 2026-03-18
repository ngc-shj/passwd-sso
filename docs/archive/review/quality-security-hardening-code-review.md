# Code Review: quality-security-hardening
Date: 2026-03-18
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F1 [Minor] password-crud delete step uses regex instead of updatedTitle
- File: e2e/tests/password-crud.spec.ts:86
- Action: Changed to use `dashboard.entryByTitle(updatedTitle)` for consistency

### F2 [Major] refresh route create return value unused — asymmetric with token route
- File: src/app/api/extension/token/refresh/route.ts:73-83
- Action: Added `select` to create, use DB-returned `expiresAt` and `scope`

### F3 [Minor] scope empty array passes validation
- File: src/lib/validations/extension-token.ts:7
- Action: Changed to `z.array(z.string()).min(1)`

### F4 [Minor] ESLint nested if not caught — skipped (unlikely pattern)

## Security Findings

### S1 [Minor] scope enum validation — skipped (requires constant type changes, out of scope)

### S2 [Minor] refresh route new token ID not tracked — resolved via F2

### S3 [Minor] runbook bcrypt → SHA-256 misstatement
- File: docs/operations/incident-runbook.md:64-65
- Action: Corrected to SHA-256 with entropy note

### S4 [Minor] triage doc missing passwords:write scope
- File: docs/security/vulnerability-triage.md:91
- Action: Added passwords:write row

## Testing Findings

### T1 [Minor] password-crud delete regex — resolved via F1

### T2 [Minor] vault-reset URL precision — skipped (functionally correct)

### T3 [Minor] component coverage threshold — skipped (verified passing at 60%)

## Adjacent Findings
None reported.

## Resolution Status

### F1 [Minor] password-crud delete locator
- Action: Changed to `dashboard.entryByTitle(updatedTitle)` and `entryPage.deleteEntry(updatedTitle)`
- Modified file: e2e/tests/password-crud.spec.ts:86-100

### F2 [Major] refresh route DB values
- Action: Added `select` clause to create, use `created.expiresAt` and `created.scope`
- Modified file: src/app/api/extension/token/refresh/route.ts:71-83
- Modified file: src/app/api/extension/token/refresh/route.test.ts (mock updates)

### F3 [Minor] scope min(1)
- Action: Added `.min(1)` to scope array schema
- Modified file: src/lib/validations/extension-token.ts:7

### S3 [Minor] bcrypt → SHA-256
- Action: Corrected hash algorithm in runbook table
- Modified file: docs/operations/incident-runbook.md:64-65

### S4 [Minor] passwords:write scope
- Action: Added row to triage severity table
- Modified file: docs/security/vulnerability-triage.md:91
