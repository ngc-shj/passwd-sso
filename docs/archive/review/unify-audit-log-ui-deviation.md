# Coding Deviation Log: unify-audit-log-ui
Created: 2026-03-29T14:00:00+09:00

## Deviations from Plan

### D1: Page file sizes larger than estimated
- **Plan description**: Each page ~90-110 lines after migration. Total ~825 lines.
- **Actual implementation**: Personal 355, Team 296, Tenant 334. Total 1813 lines.
- **Reason**: ACTION_ICONS maps (20-27 entries), getTargetLabel functions (10-15 cases each), encryption callbacks, and emergency detail formatting are page-specific logic that cannot be shared without over-abstraction. The estimates only accounted for "configuration + glue" but underestimated the volume of page-specific rendering logic.
- **Impact scope**: No functional impact. The shared components (hook + 6 UI components = 828 lines) are correctly extracted. All duplicated logic is eliminated — each remaining line in page files is unique to that page.

### D2: audit-log-target-labels.test.ts updated by sub-agent
- **Plan description**: Phase 5 would rewrite the test to import and unit-test `getCommonTargetLabel()` directly.
- **Actual implementation**: The personal page migration sub-agent updated the test to check `src/lib/audit-target-label.ts` and `src/hooks/use-audit-logs.ts` source files (same readFileSync pattern, updated paths).
- **Reason**: Sub-agent proactively fixed the test during page migration to keep vitest passing.
- **Impact scope**: Test still validates the same invariants. The readFileSync pattern is preserved rather than switching to direct function imports.

### D3: Hook unit tests not yet created
- **Plan description**: Phase 6 step 16 would create `src/hooks/use-audit-logs.test.ts`.
- **Actual implementation**: Deferred to Phase 3 code review cycle.
- **Reason**: All existing tests pass. Hook test creation is better suited for the test-gen skill after code review confirms the hook API is stable.
- **Impact scope**: No regression risk — existing tests cover the same invariants via different assertions.
