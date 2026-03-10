# Code Review: client-side-validation
Date: 2026-03-10T23:56:00+09:00
Review round: 2 (all findings resolved)

## Changes from Previous Round
Initial review

## Functionality Findings

### F1 [Major] team-create-dialog.tsx:103-104 — `finally` block indentation
- **Problem**: `teamKey.fill(0)` inside `finally` block had incorrect indentation.
- **Status**: RESOLVED — fixed indentation.

### F2 [Minor] directory-sync-card.tsx:188-190 — Update path missing 400 error handling
- **Problem**: Create path had 400 handling, but Update path did not.
- **Status**: RESOLVED — added `res.status === 400` branch to Update error handling.

## Security Findings

### S1 [Minor] directory-sync-card.tsx:516-519, 701-703 — `lastSyncError` may leak internal details
- **Problem**: Pre-existing issue. Server-side sync errors displayed in admin-only UI.
- **Status**: SKIPPED — out of scope (pre-existing, admin-only, server-side fix needed).

### S2 [Minor] team-policy-settings.tsx:140 — Negative value settable via keyboard
- **Problem**: Input allows negative values into state before submit-time validation.
- **Status**: SKIPPED — submit-time validation catches it, no security impact.

## Testing Findings

### T1 [Critical] SLUG_REGEX duplicated in client and server
- **Problem**: Same regex defined in `validations.ts` and `team-create-dialog.tsx`.
- **Status**: RESOLVED — exported `slugRegex` from `validations.ts`, imported in dialog. Added slug regex tests.

### T2 [Critical] No test coverage for webhook URL validation
- **Problem**: `validateUrl` and 400 handling had no tests.
- **Status**: RESOLVED — added 5 test cases (HTTP URL, malformed URL, 400 response, error clearing, general failure).

### T3 [Major] No test for slug validation
- **Problem**: `createTeamSchema` had no tests.
- **Status**: RESOLVED — added 9 test cases covering boundary values and edge cases.

### T4 [Major] No tests for tag name length validation
- **Problem**: 50-char limit had no tests.
- **Status**: RESOLVED — added 7 tag schema tests covering boundary values, color validation, and empty color string.

### T5 [Major] No tests for policy numeric range validation
- **Problem**: `validate()` had no test coverage.
- **Status**: RESOLVED — extracted `validatePolicy` as pure exported function, created `team-policy-settings.test.ts` with 8 test cases.

### T6 [Major] Existing webhook test mock missing `status` property
- **Problem**: Mock `{ ok: false }` didn't set `status`.
- **Status**: RESOLVED — added `status: 500` to existing mock.

## Resolution Status

All Critical and Major findings resolved. 2 Minor findings skipped (pre-existing/out-of-scope).
Round 2: All three experts returned "No findings" (Critical/Major). Minor suggestion (color: "" test) applied.
- Tests: 372 files, 4016 tests — ALL PASSED
- Build: production build — SUCCEEDED
