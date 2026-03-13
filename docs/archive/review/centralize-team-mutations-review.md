# Plan Review: centralize-team-mutations
Date: 2026-03-13T00:00:00+09:00
Review round: 1

## Functionality Findings (Senior Software Engineer)

### F1 [Major] Error path dispatch behavior unspecified
- **Problem:** Current code dispatches `team-data-changed` unconditionally (outside try/catch). Plan says "optimistic update → API call → error rollback → notifyTeamDataChanged()" but doesn't clarify that dispatch happens on both success and error paths.
- **Impact:** If accidentally changed to success-only, sidebar won't refresh after failed mutations.
- **Recommended action:** Specify "always dispatch (success and error)" in the hook design. Use end-of-function placement (not inside try/catch).

### F2 [Major] Intermediate double-dispatch during refactoring
- **Problem:** After Step 3 (useBulkAction auto-dispatch) but before Steps 5-7 (removing manual dispatches from onSuccess), team-data-changed fires twice per bulk action.
- **Impact:** Extra sidebar re-fetch, functionally harmless but wasteful.
- **Recommended action:** Implement Steps 3-7 atomically in a single commit. Update useBulkAction JSDoc simultaneously.

### F3 [Minor] Multi-team case in team-archived-list / team-trash-list
- **Problem:** `team-archived-list.tsx` and `team-trash-list.tsx` have `scopedTeamId` which can be undefined (global view). When undefined, each entry has a different `teamId`. The hook's single `teamId` option doesn't cover this case.
- **Impact:** Hook cannot be used for the global view case.
- **Recommended action:** Use `notifyTeamDataChanged()` utility for archived-list and trash-list instead of the full hook, since their mutation patterns are entry-scoped.

### F4 [Minor] handleSaved additional cleanup not documented
- **Problem:** page.tsx onSaved callbacks also call `setRefreshKey((k) => k + 1)` which isn't part of the hook's `handleSaved`.
- **Recommended action:** Note in plan that `setRefreshKey` remains in component code after calling `handleSaved`.

## Security Findings (Security Engineer)

### S1 [Minor] use-sidebar-data.ts internal dispatch functions not migrated
- **Problem:** `use-sidebar-data.ts` has inline `notifyDataChanged` / `notifyTeamDataChanged` functions that would remain as hardcoded strings.
- **Recommended action:** Step 12 should replace these with imports from `events.ts`.

### S2 [Minor] Import pages use `new Event()` instead of `new CustomEvent()`
- **Problem:** `src/app/[locale]/dashboard/teams/[teamId]/import/page.tsx` and `src/app/[locale]/dashboard/import/page.tsx` use `new Event("vault-data-changed")` — different constructor from the new utility.
- **Recommended action:** Include these in Step 11 scope.

### S3 [Minor] Dispatch ordering in useBulkAction
- **Problem:** Whether `notifyTeamDataChanged()` fires before or after `onSuccess()` is unspecified.
- **Recommended action:** Specify "dispatch after onSuccess()" in implementation.

## Testing Findings (QA Engineer)

### T1 [Critical] Missing useBulkAction auto-dispatch test
- **Problem:** No existing test verifies team-scope auto-dispatch or personal-scope non-dispatch in `use-bulk-action.test.ts`.
- **Impact:** Regression risk for the core behavioral change.
- **Recommended action:** Add two test cases to `use-bulk-action.test.ts`: (1) team scope dispatches, (2) personal scope does not dispatch.

### T2 [Major] Error path dispatch verification
- **Problem:** Test plan doesn't specify whether error-path tests should verify dispatch occurs or doesn't occur.
- **Impact:** Depends on resolution of F1.
- **Recommended action:** After resolving F1 ("always dispatch"), test plan should verify dispatch on both success and error paths.

### T3 [Minor] Test files hardcoded event name strings
- **Problem:** `use-sidebar-data.test.ts` uses hardcoded `"vault-data-changed"` / `"team-data-changed"` strings.
- **Recommended action:** Include test files in Step 12 constant migration scope.
