# Code Review: client-side-validation
Date: 2026-03-11T00:20:00+09:00
Review round: 3

## Changes from Previous Round
Added leading-zero stripping and min/max clamping to all numeric inputs (team-policy-settings, send-dialog, share-dialog, tenant-session-policy-card).

## Functionality Findings

### F1 [Minor] team-policy-settings.tsx:153,206 — `e.target.value` mutation in React controlled input
- **Problem**: Mutating `e.target.value` is a no-op in a React controlled input (React overwrites from state on re-render).
- **Status**: RESOLVED — removed `e.target.value = String(value)` lines.

### F2 [Minor] team-policy-settings.tsx:201 — maxSessionDurationMinutes allows 1-4 but validation rejects < 5
- **Problem**: onChange accepts `parsed >= 1` but `validatePolicy` rejects `< 5`, and HTML `min={5}`. User can type "3", see it accepted, then get error on save.
- **Status**: RESOLVED — changed clamp lower bound from `< 1` to `< 5`.

### F3 [Minor] api-key-manager.tsx:129-136 — 400 check ordering
- **Problem**: Status 400 check placed after body parsing. Works correctly but ordering is semantically confusing.
- **Status**: SKIPPED — no functional impact, style only.

## Security Findings

### S1 [Minor] team-webhook-card.tsx:102 — Client-side validateUrl doesn't block localhost/internal
- **Problem**: Server blocks SSRF (localhost, IP literals, .local, .internal) but client doesn't. User can type `https://localhost/hook`, pass client validation, then get server 400.
- **Status**: SKIPPED — server-side SSRF protection is authoritative. UX-only improvement, out of scope.

### S2 [Minor] team-policy-settings.tsx:43 — validatePolicy doesn't guard against NaN
- **Problem**: `NaN < 0` and `NaN > 128` are both `false`, so NaN bypasses validation. onChange handler prevents NaN reaching state, but function is exported and could be called directly.
- **Status**: RESOLVED — added `Number.isNaN()` guards to both fields in `validatePolicy`.

## Testing Findings

### T1 [Major] validatePolicy NaN input not tested
- **Problem**: `validatePolicy({ minPasswordLength: NaN, ... })` returns `{}` (no errors) because NaN comparisons are false. Exported pure function should handle this edge case.
- **Status**: RESOLVED — added `Number.isNaN()` guards to `validatePolicy` + 2 NaN test cases.

### T2 [Major] send-dialog, share-dialog, tenant-session-policy-card clamp logic has no tests
- **Problem**: Numeric clamping logic in onChange handlers has no test coverage. No test files exist for these components.
- **Status**: SKIPPED — inline `parseInt` → `Math.min` is trivial; no test file exists for these components. Extracting pure functions would be over-engineering. Server-side validation is authoritative.

### T3 [Minor] team-webhook-card.test.tsx — No test for empty URL input
- **Problem**: `validateUrl("")` returns `t("urlRequired")` but this path is not tested.
- **Status**: SKIPPED — button is disabled when URL is empty (`!url.trim()`), so validateUrl is unreachable via UI. Correct behavior by design.

### T4 [Minor] validations.test.ts — slugRegex 2-char boundary could use clarifying comment
- **Problem**: `slugRegex` with `[a-z0-9-]*` (0+) matches 2 chars. Test exists but could be more explicit.
- **Status**: SKIPPED — existing test coverage is sufficient.

## Resolution Status

Round 3: F1, F2, S2, T1 resolved. F3, S1, T2, T3, T4 skipped (no functional/security impact).
- Tests: 372 files, 4019 tests — ALL PASSED
- Build: production build — SUCCEEDED
