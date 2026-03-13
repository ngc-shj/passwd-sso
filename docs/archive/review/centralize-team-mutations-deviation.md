# Coding Deviation Log: centralize-team-mutations
Created: 2026-03-13T00:00:00+09:00

## Deviations from Plan

### D1: useTeamEntryMutations scope narrower than planned
- **Plan description**: Hook provides `toggleArchive`, `deleteEntry`, `restoreEntry`, `emptyTrash`, `handleSaved`
- **Actual implementation**: Hook provides `toggleArchive`, `deleteEntry`, `handleSaved` only. `restoreEntry` and `emptyTrash` were not needed because these mutations only exist in `team-trash-list.tsx`, which uses `notifyTeamDataChanged()` utility directly (per-entry teamId pattern).
- **Reason**: `team-trash-list.tsx` entries have per-entry `teamId` (multi-team view), making a fixed-teamId hook unsuitable. The utility function approach is simpler and sufficient.
- **Impact scope**: `src/hooks/use-team-entry-mutations.ts`

### D2: toast.error removed from handleDelete in page.tsx
- **Plan description**: Plan did not mention toast behavior changes
- **Actual implementation**: The original `handleDelete` in `page.tsx` had `toast.error(t("networkError"))` on catch. The hook's `deleteEntry` does not call toast — it only does rollback + dispatch.
- **Reason**: The hook is designed for the common optimistic-update pattern (rollback on error, always dispatch). Adding toast would require passing `t()` and toast dependency to the hook, increasing complexity. The `toggleArchive` handler also did not toast on error, so this aligns with the existing pattern.
- **Impact scope**: `src/app/[locale]/dashboard/teams/[teamId]/page.tsx` — error toast for delete no longer shown

---
