# Code Review: centralize-team-mutations
Date: 2026-03-13T00:00:00+09:00
Review round: 1

## Functionality Findings (Senior Software Engineer)

### F1 [Major] notifyTeamDataChanged not in finally block
- **Problem:** `notifyTeamDataChanged()` placed after try/catch but not in `finally`. If `refetchEntries()` throws in the catch block, dispatch is skipped.
- **Resolution:** Fixed — moved to `finally` block in both `toggleArchive` and `deleteEntry`.

### F2 [Minor] useSidebarData notifyTeamDataChanged alias confusion
- **Problem:** Hook returned `notifyDataChanged` and `notifyTeamDataChanged` (same function) with confusing semantics — name collision with `events.ts` export.
- **Resolution:** Fixed — removed both from hook return value (unused by any consumer). Cleaned up unused imports.

### F3 [Minor] archived-list/trash-list same finally pattern
- **Problem:** Same risk as F1 in components using `notifyTeamDataChanged()` directly.
- **Impact:** Low — `refetchEntries`/`fetchArchived` etc. are stable async functions that don't throw synchronously.
- **Resolution:** Accepted as-is. The direct `notifyTeamDataChanged()` calls in these components are placed identically to the original `window.dispatchEvent` calls before refactoring.

### F4 [Minor] Team import page only dispatches vault event
- **Problem:** `teams/[teamId]/import/page.tsx` calls `notifyVaultDataChanged()` but not `notifyTeamDataChanged()`.
- **Impact:** None — `useSidebarData` refreshes on both event types.
- **Resolution:** Accepted as-is — no behavioral impact.

## Security Findings (Security Engineer)

No findings.

## Testing Findings (QA Engineer)

### T1 [Major] Missing deleteEntry network error test
- **Problem:** `toggleArchive` had a network error test case but `deleteEntry` did not.
- **Resolution:** Fixed — added network error test for `deleteEntry`.

### T2 [Minor] Plan/implementation deviation for restoreEntry/emptyTrash
- **Problem:** Plan listed `restoreEntry`/`emptyTrash` in hook but implementation omitted them.
- **Resolution:** Documented in deviation log (D1). These operations only exist in trash-list which uses per-entry teamId and `notifyTeamDataChanged()` utility directly.

### T3 [Major] Missing useBulkAction auto-dispatch tests
- **Problem:** No tests verified team-scope auto-dispatch or personal-scope non-dispatch.
- **Resolution:** Fixed — added two test cases to `use-bulk-action.test.ts`.

## Resolution Status

### F1 [Major] notifyTeamDataChanged not in finally
- Action: Moved to `finally` block
- Modified file: src/hooks/use-team-entry-mutations.ts:42-44,59-61

### F2 [Minor] useSidebarData alias confusion
- Action: Removed `notifyDataChanged`/`notifyTeamDataChanged` from return value, removed unused imports
- Modified files: src/hooks/use-sidebar-data.ts:6-9,174-191, src/hooks/use-sidebar-data.test.ts:85-102

### T1 [Major] Missing deleteEntry network error test
- Action: Added test case
- Modified file: src/hooks/use-team-entry-mutations.test.ts:126-139

### T3 [Major] Missing useBulkAction auto-dispatch tests
- Action: Added two test cases (team dispatch + personal non-dispatch)
- Modified file: src/hooks/use-bulk-action.test.ts:359-389
