# Coding Deviation Log: enhance-extension-options
Created: 2026-04-03

## Deviations from Plan

### DEV-01: theme.ts bundle size includes full React runtime
- **Plan description**: Create lightweight `applyTheme()` + `useTheme()` hook in `extension/src/lib/theme.ts`
- **Actual implementation**: Implementation as planned, but the React `useState`/`useEffect` imports cause the `theme-*.js` chunk to include React runtime (~196KB gzip:61KB). This is shared with other React-using pages so no actual size increase.
- **Reason**: React hooks are the natural pattern for the extension's React-based UI
- **Impact scope**: Build output chunk naming only; no runtime impact

### DEV-02: popup dark mode applied only to root container
- **Plan description**: Apply theme to `extension/src/popup/App.tsx`
- **Actual implementation**: Added `dark:bg-gray-900 dark:text-gray-100` only to the root `<div>` in popup/App.tsx. Child components (LoginPrompt, VaultUnlock, MatchList) retain their existing light styles and will need individual dark mode updates in a follow-up.
- **Reason**: Comprehensive popup dark mode touches 4+ component files beyond the plan scope. The root-level dark class + `initTheme()` establishes the foundation; child components can be updated incrementally.
- **Impact scope**: Popup sub-components will show mixed light/dark styling until updated

### DEV-03: Alarm fallback uses 2x multiplier instead of fixed 1min
- **Plan description**: Plan mentioned "alarm fallback (1min)" from existing code
- **Actual implementation**: Changed to `Math.max((clipboardClearSeconds * 2) / 60, 1)` — scales with setting but minimum 1 minute (Chrome alarms minimum)
- **Reason**: Fixed 1-minute fallback doesn't make sense when clipboardClearSeconds can be 5 minutes (300s). The 2x multiplier provides safety margin while scaling appropriately.
- **Impact scope**: `ALARM_CLEAR_CLIPBOARD` alarm timing only

---
