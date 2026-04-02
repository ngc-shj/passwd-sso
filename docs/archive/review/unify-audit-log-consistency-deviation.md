# Coding Deviation Log: unify-audit-log-consistency
Created: 2026-04-02

## Deviations from Plan

### D1: Added ENTRY_BULK_IMPORT icon (not in original plan)
- **Plan description**: Extract existing ACTION_ICONS as-is
- **Actual implementation**: Added ENTRY_BULK_IMPORT icon (Upload) that was missing from both original pages
- **Reason**: Code review found this gap — the action exists in TRANSFER group but had no icon
- **Impact scope**: All three audit log views now show Upload icon for bulk import actions

### D2: Added SectionLayout wrapper to team audit log page
- **Plan description**: Not in original plan — plan only addressed filter/badge/icon consistency
- **Actual implementation**: Wrapped team audit log page in SectionLayout to constrain width
- **Reason**: Team audit log page was full-width while all other team admin pages use SectionLayout
- **Impact scope**: Team audit log page layout

### D3: Added actorType filter/response to team audit log API
- **Plan description**: Plan only added UI filter — did not address backend support
- **Actual implementation**: Added actorType query param parsing and where clause to both list and download endpoints; added actorType to list response
- **Reason**: UI filter was non-functional without backend support
- **Impact scope**: src/app/api/teams/[teamId]/audit-logs/route.ts, src/app/api/teams/[teamId]/audit-logs/download/route.ts

### D4: Extracted VALID_ACTOR_TYPES and parseActorType to shared module
- **Plan description**: Not in original plan
- **Actual implementation**: Added VALID_ACTOR_TYPES constant and parseActorType function to src/lib/audit-query.ts; updated all 4 audit log API routes to use shared function; added tests
- **Reason**: Code review identified duplication across 4 API routes
- **Impact scope**: src/lib/audit-query.ts, src/app/api/audit-logs/route.ts, src/app/api/teams/[teamId]/audit-logs/route.ts, src/app/api/teams/[teamId]/audit-logs/download/route.ts, src/app/api/tenant/audit-logs/route.ts
