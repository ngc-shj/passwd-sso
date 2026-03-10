# Code Review: client-side-validation
Date: 2026-03-11T00:55:00+09:00
Review round: 4

## Changes from Previous Round
Extracted 18 validation constants in `validations.ts` as single source of truth. All Zod schemas and 14 UI components updated to use shared constants.

## Functionality Findings

### F1 [Minor] team-create-dialog.tsx — Missing `maxLength` on name and description inputs
- **Problem**: Team name and description inputs had no `maxLength` attribute despite server enforcing `NAME_MAX_LENGTH` (100) and `DESCRIPTION_MAX_LENGTH` (500). Other components properly set `maxLength`.
- **Status**: RESOLVED — added `maxLength={NAME_MAX_LENGTH}` and `maxLength={DESCRIPTION_MAX_LENGTH}`.

### F2 [Minor] tag-dialog.tsx — Hardcoded `maxLength={50}` not using constant
- **Problem**: `tag-dialog.tsx` used hardcoded `maxLength={50}` while sibling `tag-input.tsx` correctly imports `TAG_NAME_MAX_LENGTH`. Inconsistency in constants consolidation.
- **Status**: RESOLVED — imported and used `TAG_NAME_MAX_LENGTH`.

### F3 [Minor] api-key-manager.tsx:129-136 — 400 check ordering
- **Problem**: Status 400 check placed after body parsing. Works correctly but ordering is semantically confusing.
- **Status**: SKIPPED — no functional impact, style only.

## Security Findings

No findings. Detailed analysis confirmed:
- No internal error details exposed to users
- No validation bypass possibilities
- Constants export creates no security risk
- Client/server validation constants are consistent

## Testing Findings

### T5 [Minor] send-dialog.test.tsx — Mock values hardcoded instead of using real constants
- **Problem**: `vi.mock("@/lib/validations")` duplicated constant values as raw literals. If constants change, mock silently diverges.
- **Status**: RESOLVED — changed to `importOriginal` pattern. Also fixed `@/lib/constants` mock to use `importOriginal` to support transitive imports.

### T6 [Minor] team-policy-settings.test.ts, validations.test.ts — Boundary tests use hardcoded numbers
- **Problem**: Boundary tests use magic numbers (0, 128, 5, 43200, 50, 51) instead of imported constants. If constants change, tests would pass at old boundaries.
- **Status**: RESOLVED — imported constants and used `CONSTANT + 1` / `CONSTANT - 1` patterns for boundary testing.

## Resolution Status

Round 4: F1, F2, T5, T6 resolved. F3 skipped (no functional impact).
- Tests: 372 files, 4019 tests — ALL PASSED
- Build: production build — SUCCEEDED
