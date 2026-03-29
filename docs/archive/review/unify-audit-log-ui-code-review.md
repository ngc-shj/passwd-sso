# Code Review: unify-audit-log-ui
Date: 2026-03-29T14:30:00+09:00
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F-1 [Critical] `buildExtraParams` infinite fetch loop in tenant card
- File: `src/components/settings/tenant-audit-log-card.tsx`
- Problem: Inline arrow function caused new reference every render, triggering useCallback/useEffect chain
- Fix: Extracted to `useCallback` with `[scopeFilter, teamFilter]` deps
- Status: **Resolved**

### F-2 [Minor] `groupLabelResolver` dead property in hook config
- File: `src/hooks/use-audit-logs.ts`
- Problem: Property defined in interface but never used by hook
- Fix: Removed from `UseAuditLogsConfig`, kept only as `AuditActionFilter` prop
- Status: **Resolved**

### F-3 [Minor] Group checkbox allSelected during filter — existing behavior
- Status: **Skipped** — existing behavior maintained, not a regression

## Security Findings

### S-1 [Minor] Invalid date string could throw RangeError
- File: `src/hooks/use-audit-logs.ts` L121-124
- Status: **Deferred** — `<input type="date">` prevents invalid input in normal usage

### S-2 [Minor] userAgent in API response but unused in UI
- Status: **Deferred** — pre-existing, out of scope for UI refactoring

### S-3 [Minor] fetchEndpoint type constraint
- Status: **Deferred** — low priority, all call sites use constants

### S-4 [Minor] VALID_ACTOR_TYPES hardcoded in API routes
- Status: **Deferred** — pre-existing, out of scope for UI refactoring

## Testing Findings

### T-CRITICAL-1 E2E spec uses Tailwind class selectors directly
- File: `e2e/tests/audit-logs.spec.ts` L44, L103
- Problem: Spec bypassed page object and used `.divide-y`, `.px-4.py-3` selectors
- Fix: Updated to `[data-testid='audit-log-list']` and `[data-testid='audit-log-row']`
- Status: **Resolved**

### T-MAJOR-1 Hook unit tests not created
- File: `src/hooks/use-audit-logs.test.ts` (missing)
- Status: **Deferred** — to be created via test-gen skill. TODO: create use-audit-logs.test.ts

### T-MAJOR-2 readFileSync string matching in target-labels test
- File: `src/__tests__/ui/audit-log-target-labels.test.ts`
- Status: **Accepted** — fragile but existing pattern, works for current files

### T-MINOR-1 action-groups test doesn't check tenant
- Status: **Deferred** — low priority

### T-MINOR-2 logListCard precondition not documented
- Status: **Accepted** — minor documentation gap

## Adjacent Findings
None

## Resolution Status

### F-1 [Critical] buildExtraParams infinite loop
- Action: Added `useCallback` wrapper with `[scopeFilter, teamFilter]` dependencies
- Modified file: `src/components/settings/tenant-audit-log-card.tsx`

### F-2 [Minor] groupLabelResolver dead property
- Action: Removed from `UseAuditLogsConfig` interface
- Modified file: `src/hooks/use-audit-logs.ts`

### T-CRITICAL-1 E2E Tailwind selectors
- Action: Replaced with `data-testid` selectors
- Modified file: `e2e/tests/audit-logs.spec.ts`
