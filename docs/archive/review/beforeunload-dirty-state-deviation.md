# Coding Deviation Log: beforeunload-dirty-state
Created: 2026-03-11

## Deviations from Plan

### D1: Added SPA navigation guard (import page + shared hook)
- **Plan description**: SPA navigation interception was explicitly listed as "out of scope"
- **Actual implementation**: Created `src/hooks/use-navigation-guard.ts` combining beforeunload + SPA link interception + AlertDialog state. Applied to `password-import.tsx` with confirmation dialog.
- **Reason**: User requested SPA navigation guard for import page during implementation ("import中、他のメニューをクリックしたとき。watchtowerと同じようにダイアログを表示させたいですね。")
- **Impact scope**: New hook, import page UI changes, i18n message additions

### D2: Refactored watchtower to use shared useNavigationGuard hook
- **Plan description**: Plan stated "Watchtower already has its own guard — leave it unchanged"
- **Actual implementation**: Replaced 59 lines of inline beforeunload + click interception logic in `watchtower-page.tsx` with `useNavigationGuard(loading)`
- **Reason**: User suggested sharing the hook ("watchtoerもこのuse-navigation-guard.tsを使用、ですかね？"). DRY principle — watchtower had identical logic.
- **Impact scope**: `watchtower-page.tsx` refactored, no behavioral change
