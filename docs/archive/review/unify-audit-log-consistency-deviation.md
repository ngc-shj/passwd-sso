# Coding Deviation Log: unify-audit-log-consistency
Created: 2026-04-02

## Deviations from Plan

### D1: Added ENTRY_BULK_IMPORT icon (not in original plan)
- **Plan description**: Extract existing ACTION_ICONS as-is
- **Actual implementation**: Added ENTRY_BULK_IMPORT icon (Upload) that was missing from both original pages
- **Reason**: Code review found this gap — the action exists in TRANSFER group but had no icon
- **Impact scope**: All three audit log views now show Upload icon for bulk import actions

No other deviations.
