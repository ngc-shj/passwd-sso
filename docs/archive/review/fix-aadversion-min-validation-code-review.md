# Code Review: fix-aadversion-min-validation
Date: 2026-04-05
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F3 — Minor: OpenAPI spec `aadVersion` constraints stale
- File: `src/lib/openapi-spec.ts:208,223`
- Problem: `CreatePasswordInput.aadVersion` had `minimum: 0` and `UpdatePasswordInput.aadVersion` lacked constraints, diverging from the actual schema (`min(1).max(1)`)
- Fix: Updated both to `minimum: 1, maximum: 1`

## Security Findings

### F1 — Major: Attachment endpoints accept arbitrary `aadVersion` via `parseInt` without validation
- File: `src/app/api/passwords/[id]/attachments/route.ts:185`, `src/app/api/teams/[teamId]/passwords/[id]/attachments/route.ts:198`
- Problem: `aadVersion` from multipart form data was parsed with `parseInt` and stored directly without range validation, allowing `aadVersion: 0` bypass via attachment upload
- Fix: Added `isNaN(aadVersion) || aadVersion < 1 || aadVersion > 1` guard returning `API_ERROR.VALIDATION_ERROR`

### F4 — Minor (skipped): refine condition `?? 0` is dead code
- File: `src/lib/validations/entry.ts:53`
- Problem: With `min(1)` + `default(1)`, `aadVersion` can never be 0, making the `?? 0` fallback unreachable
- Decision: **Skipped** — the refine provides defense-in-depth and is logically correct; changing the fallback value has no behavioral impact

## Testing Findings

### F2 — Major: `updateE2EPasswordSchema` lacked `aadVersion=0` rejection test
- File: `src/lib/validations.test.ts`, `src/lib/validations/validations.test.ts`
- Problem: Tests for `createE2EPasswordSchema` were updated but `updateE2EPasswordSchema` had no equivalent test
- Fix: Added `aadVersion=0` rejection tests to both files

## Adjacent Findings
None

## Quality Warnings
None

## Resolution Status

### F1 [Major] Attachment endpoint aadVersion validation
- Action: Added `isNaN || < 1 || > 1` guard in both personal and team attachment upload routes
- Modified files: `src/app/api/passwords/[id]/attachments/route.ts:186-188`, `src/app/api/teams/[teamId]/passwords/[id]/attachments/route.ts:199-201`

### F2 [Major] updateE2EPasswordSchema aadVersion=0 rejection test
- Action: Added "rejects aadVersion=0 in update" test to both validation test files
- Modified files: `src/lib/validations.test.ts:162-166`, `src/lib/validations/validations.test.ts:742-744`

### F3 [Minor] OpenAPI spec aadVersion constraints
- Action: Updated `minimum: 0` to `minimum: 1` in CreatePasswordInput; added `minimum: 1, maximum: 1` to UpdatePasswordInput
- Modified file: `src/lib/openapi-spec.ts:208,223`

### F4 [Minor] refine `?? 0` dead code
- Action: Skipped — defense-in-depth, no behavioral impact
