# Coding Deviation Log: sidebar-navigation-restructure
Created: 2026-04-01T14:10:00+09:00

## Deviations from Plan

### D-01: FoldersSection [+] button added aria-label for accessibility
- **Plan description**: FoldersSection has a `[+]` button (direct button) calling `onCreate`
- **Actual implementation**: Added `aria-label={t("createFolder")}` to the button
- **Reason**: The button only contains a Plus SVG icon with no text. Without aria-label, tests cannot find the button by accessible name, and screen readers have no description.
- **Impact scope**: `sidebar-sections.tsx` (FoldersSection), `sidebar-folder-crud.test.tsx` (9 query selectors changed from `menuitem` to `button`)

### D-02: sidebar-folder-crud.test.tsx required query selector updates
- **Plan description**: Listed as "Verify no ManageSection dependency" (verify-only)
- **Actual implementation**: Changed 9 occurrences of `getByRole("menuitem", { name: "createFolder" })` to `getByRole("button", { name: "createFolder" })`
- **Reason**: ManageSection used a DropdownMenu (renders menuitem role), FoldersSection uses a direct Button (renders button role). The test was finding the create action via the DropdownMenuItem mock, which no longer exists.
- **Impact scope**: `sidebar-folder-crud.test.tsx` only

### D-03: `_isAuditLog` and `_handleTagCreate` unused variable prefixes in sidebar.tsx
- **Plan description**: Plan said to remove `activeAuditTeamId` from destructuring but didn't address `isAuditLog` and `handleTagCreate`
- **Actual implementation**: Prefixed with `_` (`isAuditLog: _isAuditLog`, `handleTagCreate: _handleTagCreate`) since they're still returned from their respective hooks but no longer used in sidebar
- **Reason**: `isAuditLog` is still computed in `useSidebarNavigationState` (used for `isSelectedVaultAll` computation on line 58). `handleTagCreate` is still returned from `useSidebarTagCrud` but not passed to the view model. Both are destructured but unused — TypeScript would flag them without `_` prefix.
- **Impact scope**: `sidebar.tsx` only

---
