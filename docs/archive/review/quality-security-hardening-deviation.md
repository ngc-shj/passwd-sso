# Coding Deviation Log: quality-security-hardening
Created: 2026-03-18

## Deviations from Plan

### D1: IMPROVE comments cleanup
- **Plan description**: Not explicitly planned
- **Actual implementation**: Removed `IMPROVE(#37)` from `e2e/playwright.config.ts` and `IMPROVE(#38)` from `extension/src/lib/api.ts`
- **Reason**: These comments reference issues being resolved in this batch
- **Impact scope**: No functional impact — comment-only changes

### D2: Incident runbook hash algorithm correction
- **Plan description**: Not explicitly planned
- **Actual implementation**: Corrected `bcrypt` → `SHA-256` for `extension_tokens` and `api_keys` in `docs/operations/incident-runbook.md`
- **Reason**: Security code review identified documentation inaccuracy (actual implementation uses SHA-256)
- **Impact scope**: Documentation only — improves incident response accuracy

### D3: Refresh route create return value
- **Plan description**: Plan specified Zod validation for refresh route
- **Actual implementation**: Also changed `create()` to use `select: { expiresAt: true, scope: true }` and use DB-returned values instead of pre-computed values
- **Reason**: Functionality code review identified asymmetry with token/route.ts pattern
- **Impact scope**: `src/app/api/extension/token/refresh/route.ts` and its test file

### D4: passwords:write scope in triage doc
- **Plan description**: Triage doc included vault:unlock-data and passwords:read scopes
- **Actual implementation**: Added passwords:write scope classification
- **Reason**: Security code review identified missing scope
- **Impact scope**: Documentation only
