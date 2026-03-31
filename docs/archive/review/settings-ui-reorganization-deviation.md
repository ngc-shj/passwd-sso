# Coding Deviation Log: settings-ui-reorganization
Created: 2026-03-31

## Deviations from Plan

### D1: ShellBase extraction skipped — AdminShell created directly
- **Plan description**: Extract `ShellBase` from `DashboardShell` as shared layout primitive, then create `AdminShell` using `ShellBase`.
- **Actual implementation**: Created `AdminShell` as a standalone component following the same layout pattern as `DashboardShell` (22 lines), without extracting a shared base.
- **Reason**: `DashboardShell` is only 22 lines. Extracting a `ShellBase` would add an abstraction for minimal code sharing. The two shells have different provider stacks (vault providers vs none), making a shared base overly generic.
- **Impact scope**: `DashboardShell` is unchanged. `AdminShell` is self-contained. Future changes to layout (e.g., responsive behavior) would need updating in both shells.

### D2: `getTenantRole` reuses existing `getTenantMembership` instead of new implementation
- **Plan description**: Create `getTenantRole(userId)` server-side function in `src/lib/tenant-auth.ts` as a new DB query wrapper.
- **Actual implementation**: `getTenantRole` is a thin wrapper around existing `getTenantMembership(userId)` (which already uses `withBypassRls`), returning only the `role` field.
- **Reason**: `getTenantMembership` already existed with the correct RLS bypass and query pattern. Duplicating the DB query would violate DRY.
- **Impact scope**: None — same behavior, fewer lines of code.

### D3: `isTeamSettings` simplified to constant `false` instead of removed
- **Plan description**: Remove `isTeamSettings` from `useSidebarNavigationState`.
- **Actual implementation**: Set `isTeamSettings = false` as a constant, keeping the variable reference in `isSelectedVaultAll` calculation intact.
- **Reason**: `isTeamSettings` is used in the `isSelectedVaultAll` boolean expression (line ~118). Removing it entirely would require refactoring the expression. Setting it to `false` is semantically equivalent (team settings URL is no longer reachable via vault sidebar) and minimizes diff.
- **Impact scope**: `isSelectedVaultAll` logic unchanged. The dead code can be cleaned up in a follow-up.

### D4: E2E test updates deferred (not implemented)
- **Plan description**: Phase 2-4 each include E2E test update steps (Steps 22-24, 34-36, 46-47).
- **Actual implementation**: E2E test files were not modified. Only unit tests (vitest) were updated.
- **Reason**: E2E tests require a running application instance and cannot be verified within the `npx vitest run` + `npx next build` invariant. Updating E2E page objects and specs is a separate task that should be done with E2E test infrastructure running. The redirect pages ensure old URLs don't 404.
- **Impact scope**: E2E tests referencing old URLs will need updating before the E2E test suite is run. The redirects mitigate breakage for manual testing.

### D5: Admin layout uses `redirect()` with `return` for TypeScript narrowing
- **Plan description**: Pseudocode showed `redirect()` without `return`.
- **Actual implementation**: Used `return redirect(...)` pattern because the `redirect()` from `@/i18n/navigation` does not have a `never` return type, so TypeScript cannot narrow `session` after the call without `return`.
- **Reason**: TypeScript type narrowing requirement. The dashboard layout avoids this by not accessing `session.user.id` after the redirect check.
- **Impact scope**: None — same runtime behavior.
