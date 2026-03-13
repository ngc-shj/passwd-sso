# Coding Deviation Log: fix-folder-count-mismatch
Created: 2026-03-13T00:00:00+09:00

## Deviations from Plan

### D1: Simplified list query filter logic
- **Plan description**: Use `...ACTIVE_ENTRY_WHERE` as base for default view filter in passwords list queries
- **Actual implementation**: Restructured the ternary to collapse `trashOnly` / `archivedOnly` / default into a single 3-way branch, replacing the original two separate spreads. The default branch uses `{ ...ACTIVE_ENTRY_WHERE }`.
- **Reason**: The original code used two separate spread expressions (`trashOnly ? ... : ...` and `archivedOnly ? ... : trashOnly ? {} : ...`) which made it unclear what the default filter was. A single 3-way ternary is clearer and ensures `ACTIVE_ENTRY_WHERE` is visibly the default.
- **Impact scope**: `src/app/api/passwords/route.ts`, `src/app/api/teams/[teamId]/passwords/route.ts`

### D2: Added client-side cache bypass (not in original plan)
- **Plan description**: Plan only addressed server-side count query filters
- **Actual implementation**: Added `{ cache: "no-store" }` to `fetchApi()` in `useSidebarData` hook to prevent browser HTTP caching of sidebar API responses
- **Reason**: After deploying the API-side fix, user reported the sidebar folder count still did not update after archiving. Root cause was the browser's default HTTP caching returning stale API responses on re-fetch.
- **Impact scope**: `src/hooks/use-sidebar-data.ts`, `src/hooks/use-sidebar-data.test.ts`

---
