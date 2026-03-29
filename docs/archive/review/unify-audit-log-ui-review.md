# Plan Review: unify-audit-log-ui
Date: 2026-03-29T12:00:00+09:00
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F-1 [Major] `onDataReceived` not called during `handleLoadMore`
- **Problem**: Personal page merges `relatedUsers` on both initial fetch and load-more. Plan's `onDataReceived` only described for initial fetch.
- **Impact**: Page 2+ emergency access logs show "unknownUser" instead of resolved names.
- **Recommended action**: Specify that `onDataReceived` is called in both `fetchLogs` initial and `handleLoadMore`.

### F-2 [Major] Tenant scope change must reset `selectedActions`
- **Problem**: Current tenant code resets `selectedActions` when scope changes. After refactoring, `scopeFilter` is page-local but `selectedActions` is in the hook. Plan doesn't mention this coupling.
- **Impact**: Stale action filters after scope change cause invalid API queries and filter/fetch mismatch.
- **Recommended action**: Document that tenant scope change handler must call `clearActions()`. Consider adding `resetFilters()` to the hook API.

### F-3 [Minor] `getActionLabel` depends on translation function
- **Problem**: Plan describes `audit-action-label.ts` as "pure function" but it needs `t()`.
- **Impact**: Ambiguous API design; risk of calling `useTranslations` outside component.
- **Recommended action**: Clarify signature as `(t: TranslationFn, action: string) => string`.

## Security Findings

### S-1 [Minor] fetchEndpoint/downloadEndpoint as unvalidated strings
- **Problem**: Shared hook accepts endpoint URLs as strings without validation.
- **Impact**: Low — `fetchApi` enforces same-origin. Preventive concern.
- **Recommended action**: Add `/api/` prefix assertion or constrain type.

### S-2 [Minor] Decrypted entry titles displayed without sanitization note
- **Problem**: No documentation that return values are plain text, not HTML-safe.
- **Impact**: Low — React escapes by default. Future non-JSX reuse risk.
- **Recommended action**: Add JSDoc note to `audit-target-label.ts`.

### S-3 [Minor] downloadFilename without sanitization
- **Problem**: `downloadFilename` from config used directly in `a.download`.
- **Impact**: Low — browsers sanitize download filenames. Preventive.
- **Recommended action**: Sanitize or constrain to literal union type.

### S-4 [Minor] teamId from URL params without UUID validation
- **Problem**: `teamId` from route params passed without format check.
- **Impact**: Low — API server validates. Preventive.
- **Recommended action**: UUID format check before hook initialization.

## Testing Findings

### T-1 [Critical] Existing `audit-log-target-labels.test.ts` will break
- **Problem**: Test reads page source files with `readFileSync` and asserts string presence (e.g., `log.action === AUDIT_ACTION.ENTRY_BULK_TRASH`). After refactoring, these strings move to `audit-target-label.ts` and `use-audit-logs.ts`, breaking the test.
- **Impact**: `npx vitest run` fails. Blocks Phase 5.
- **Recommended action**: Rewrite test to import and unit-test `getCommonTargetLabel()` directly. Similarly update `audit-log-action-groups.test.ts`.

### T-2 [Major] E2E tests use Tailwind class selectors
- **Problem**: `e2e/tests/audit-logs.spec.ts` and page objects use `.divide-y`, `.px-4.py-3` etc. Component extraction may change class composition.
- **Impact**: E2E failures from selector mismatch, not actual regression.
- **Recommended action**: Add `data-testid` attributes to shared components. Update E2E selectors.

### T-3 [Major] No unit tests for shared hook
- **Problem**: Plan has no unit tests for `use-audit-logs.ts`. Hook contains URL param building, cursor management, filter state logic.
- **Impact**: Regressions in shared logic undetectable.
- **Recommended action**: Add `src/hooks/use-audit-logs.test.ts` with fetch mock tests for param building, pagination, filter reset.

### T-4 [Minor] No test for team page's actorTypeFilter absence
- **Problem**: Team page intentionally has no actor type filter. No test verifies this constraint post-refactoring.
- **Impact**: Accidental addition of actorType param to team API calls.
- **Recommended action**: Add assertion in hook config test.

## Adjacent Findings
None — all findings correctly routed to their respective experts.
