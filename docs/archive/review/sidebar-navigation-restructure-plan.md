# Plan: sidebar-navigation-restructure

## Objective

Restructure the dashboard sidebar navigation to improve UX consistency and remove empty/redundant sections:

1. **Split "Manage" into "Folders" + "Tags"** — separate collapsible sections (industry standard: 1Password, KeePassXC)
2. **Move "Audit Log" from VaultManagement to Security** — personal vault only
3. **Remove "Audit Log" from team sidebar** — already available in admin console
4. **Remove "Settings" section for team vaults** — renders empty (no child items)
5. **Remove "Security" section for team Viewers** — renders empty (Watchtower hidden for Viewers, Emergency Access hidden for teams)

## Requirements

### Functional

- F1: Folders section is an independent collapsible section with `[+]` button and tree structure
- F2: Tags section is an independent collapsible section with tree structure (NO `[+]` button — tags are created inline via TagInput in entry edit forms)
- F3: "Manage" section type and localStorage key are replaced by "folders" and "tags"
- F4: Audit Log appears inside Security section for personal vault only
- F5: Audit Log link is NOT rendered when vaultContext is team
- F6: Settings section is NOT rendered when vaultContext is team
- F7: Security section is NOT rendered when vaultContext is team AND role is VIEWER
- F8: Auto-expand behavior: navigating to a folder auto-expands Folders section; navigating to a tag auto-expands Tags section
- F9: Audit log auto-expand uses `isPersonalAuditLog` (not `isAuditLog`) to open Security section — prevents spurious auto-expand when navigating to team audit log URLs
- F10: Existing folder CRUD operations (create, edit, delete dialogs) work identically. Tag edit/delete via context menu remain; tag creation removed from sidebar (available via TagInput in entry forms)

### Non-functional

- NF1: No visual regression for personal vault sidebar (except Manage split + Audit Log move)
- NF2: No visual regression for team vault sidebar (except Manage split + removals)
- NF3: All existing tests updated or replaced to match new structure
- NF4: Production build passes (`npx next build`)
- NF5: All tests pass (`npx vitest run`)

## Technical Approach

### Section Structure Changes

**Before:**
```
VaultSection (non-collapsible)
CategoriesSection (collapsible: "categories")
ManageSection (collapsible: "manage")        ← folders + tags combined
VaultManagementSection (non-collapsible)     ← includes Audit Log
SecuritySection (collapsible: "security")
SettingsNavSection (collapsible: "settingsNav")
ToolsSection (collapsible: "tools")
```

**After:**
```
VaultSection (non-collapsible)
CategoriesSection (collapsible: "categories")
FoldersSection (collapsible: "folders")      ← NEW: extracted from ManageSection
TagsSection (collapsible: "tags")            ← NEW: extracted from ManageSection
VaultManagementSection (non-collapsible)     ← Audit Log REMOVED
SecuritySection (collapsible: "security")    ← Audit Log ADDED (personal only), hidden for team Viewers
SettingsNavSection (collapsible: "settingsNav") ← hidden for teams
ToolsSection (collapsible: "tools")
```

### Component-Level Changes

1. **`sidebar-sections.tsx`**: Split `ManageSection` into `FoldersSection` + `TagsSection`. Remove Audit Log from `VaultManagementSection`. `FoldersSection` has a `[+]` button (direct button, NOT dropdown) calling `onCreate`. `TagsSection` has NO create button — tags are created inline via `TagInput` in entry edit forms; sidebar shows tree view + edit/delete context menu only.
2. **`sidebar-section-security.tsx`**: Add Audit Log to `SecuritySection` (personal vault only, gated by `vaultContext.type !== "team"`). Add `isPersonalAuditLog` prop for active highlighting.
3. **`sidebar-content.tsx`**: Replace `ManageSection` with `FoldersSection` + `TagsSection`. **Guard `<SettingsNavSection>` with `{vaultContext.type !== "team" && ...}`** (F6). **Guard `<SecuritySection>` to hide when vaultContext is team AND role is VIEWER** (F7). Both guards at the render site in `sidebar-content.tsx`, NOT inside the child components.
4. **`use-sidebar-sections-state.ts`**: Replace `"manage"` with `"folders"` | `"tags"` in `SidebarSection` type. Update `COLLAPSE_DEFAULTS`. Update auto-expand: `selectedFolderId` → `toOpen.push("folders")`, `selectedTagId` → `toOpen.push("tags")`. **Change `isAuditLog` trigger to `isPersonalAuditLog`** for Security section auto-expand.
5. **`use-sidebar-navigation-state.ts`**: Remove `activeAuditTeamId` from return value.
6. **`use-sidebar-view-model.ts`**: Update props — remove `activeAuditTeamId`, add `isPersonalAuditLog`. Match new `SidebarContentProps`.
7. **`sidebar.tsx`**: Remove `activeAuditTeamId` from `useSidebarNavigationState()` destructuring (line 103). Update `useSidebarSectionsState` params: change `isAuditLog` to `isPersonalAuditLog`. Update `useSidebarViewModel` params accordingly.

### New Prop Interfaces (after split)

```typescript
interface FoldersSectionProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  t: (key: string) => string;
  canCreate: boolean;       // false for team Viewers
  folders: SidebarFolderItem[];
  activeFolderId: string | null;
  linkHref: (folderId: string) => string;
  showMenu: boolean;        // false for team Viewers
  onNavigate: () => void;
  onCreate: () => void;
  onEdit: (folder: SidebarFolderItem) => void;
  onDelete: (folder: SidebarFolderItem) => void;
}

interface TagsSectionProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  t: (key: string) => string;
  // NO canCreate / onCreate — tags are created inline via TagInput in entry edit forms
  tags: SidebarTeamTagItem[];
  activeTagId: string | null;
  tagHref: (tagId: string) => string;
  showMenu: boolean;        // false for team Viewers (controls edit/delete context menu)
  onNavigate: () => void;
  onEdit: (tag: SidebarTeamTagItem) => void;
  onDelete: (tag: SidebarTeamTagItem) => void;
}
```

### i18n Changes

- Verify "folders" and "tags" keys exist in Dashboard namespace (both already present: en "Folders"/"Tags", ja "フォルダ"/"タグ"). **No changes needed — verify only.**
- Existing "manage" key can remain (no harm, will be unused)

## Implementation Steps

1. Update `SidebarSection` type in `use-sidebar-sections-state.ts`: replace `"manage"` with `"folders"` | `"tags"`
2. Update `COLLAPSE_DEFAULTS` and auto-expand logic in `use-sidebar-sections-state.ts`: split folder/tag auto-expand, change `isAuditLog` → `isPersonalAuditLog`
3. Split `ManageSection` into `FoldersSection` and `TagsSection` in `sidebar-sections.tsx` (see new prop interfaces above)
4. Remove Audit Log from `VaultManagementSection` in `sidebar-sections.tsx`: remove `isPersonalAuditLog`, `activeAuditTeamId` from `VaultManagementSectionProps` interface; remove Audit Log `<Button>` + `<Link>`; remove `auditLogHref` and `isAuditActive` computed values
5. Add Audit Log to `SecuritySection` in `sidebar-section-security.tsx` (personal vault only, with `isPersonalAuditLog` prop)
6. Add conditional rendering in `sidebar-content.tsx`: wrap `<SecuritySection>` to hide for team Viewers, wrap `<SettingsNavSection>` to hide for all teams
7. Update `sidebar-content.tsx` to use `FoldersSection` + `TagsSection` instead of `ManageSection`
8. Update `SidebarContentProps` interface: remove `activeAuditTeamId`, remove `onCreateTag`, add `isPersonalAuditLog`. Update `use-sidebar-view-model.ts` params and return to match. Remove `activeAuditTeamId` from `VaultManagementSection` call site in `sidebar-content.tsx`
9. Update `use-sidebar-navigation-state.ts`: remove `activeAuditTeamId` from return value
10. Update `sidebar.tsx`: remove `activeAuditTeamId` from destructuring (line 103), update `useSidebarSectionsState` params (`isAuditLog` → `isPersonalAuditLog`), update `useSidebarViewModel` params
11. Verify i18n keys in `messages/en/Dashboard.json` and `messages/ja/Dashboard.json` (already present — no changes needed)
12. Update all sidebar-related tests (15 files identified — see updated test table)
13. Run `npx vitest run` — all tests pass
14. Run `npx next build` — production build passes

## Testing Strategy

### Unit Tests to Update

| File | Changes Required |
|------|-----------------|
| `sidebar-sections.test.tsx` | Replace ManageSection tests with FoldersSection + TagsSection tests; remove Audit Log from VaultManagementSection tests; add [+] button test for FoldersSection; verify TagsSection has NO [+] button |
| `sidebar-section-security.test.tsx` | Add Audit Log rendering tests: personal vault shows link, **all team roles** (Owner/Admin/Member/Viewer) do NOT show Audit Log link; add `isPersonalAuditLog` active highlighting test |
| `sidebar-content.test.tsx` | Replace ManageSection mock with FoldersSection/TagsSection mocks; add test: team vault → SettingsNavSection NOT rendered (F6); add test: team Viewer → SecuritySection NOT rendered (F7); add test: personal vault → both sections rendered |
| `use-sidebar-sections-state.test.ts` | Replace `mockCollapsed.manage` with `folders`/`tags`; replace `expect(next.manage)` with `expect(next.folders)` and `expect(next.tags)`; add independent auto-expand tests for `selectedFolderId` → `"folders"` and `selectedTagId` → `"tags"`; change `isAuditLog` to `isPersonalAuditLog` in test params |
| `use-sidebar-navigation-state.test.ts` | Remove `activeAuditTeamId` assertions; update team audit log path expectations |
| `use-sidebar-view-model.test.ts` | Update prop shape: remove `activeAuditTeamId`, add `isPersonalAuditLog` |
| `sidebar-folder-crud.test.tsx` | Verify no ManageSection dependency; update if needed |
| `sidebar-shared.test.tsx` | Verify FolderTreeNode/TagTreeNode still work after split (verify only) |

### Test Scenarios

- Personal vault: Folders renders as collapsible section with [+] button; Tags renders as collapsible section (tree + edit/delete menu, no [+] button)
- Personal vault: Audit Log appears inside Security section with correct link `/dashboard/audit-logs`
- Personal vault: Audit Log link highlights when `isPersonalAuditLog` is true
- Team vault (Owner/Admin): Folders and Tags sections visible; no Audit Log in any section; no Settings; Security shows Watchtower
- Team vault (Member): Same as Owner/Admin but without Watchtower if role lacks TEAM_UPDATE
- Team vault (Viewer): Folders section visible (read-only, no [+] button); Tags section visible (no context menu); Security section NOT rendered; Settings section NOT rendered
- Auto-expand: navigating to folder expands Folders section (not Tags)
- Auto-expand: navigating to tag expands Tags section (not Folders)
- Auto-expand: navigating to personal audit log expands Security section
- Auto-expand: navigating to team audit log does NOT expand Security section (isPersonalAuditLog is false)
- Folder CRUD: create, edit, delete dialogs still triggered correctly from FoldersSection
- Tag CRUD: edit/delete context menu still works from TagsSection; no create button in sidebar
- Vault switch: switching from personal to team hides Audit Log and Settings; switching back restores them

## Considerations & Constraints

- **localStorage migration**: Users with `sidebar-collapsed` in localStorage have `{ manage: boolean }`. After this change, `manage` key is unused and `folders`/`tags` keys are new. The `COLLAPSE_DEFAULTS` fallback handles this gracefully — new keys default to their specified values. The stale `manage` key in localStorage is harmless (ignored by the new code) and will be naturally overwritten on next toggle.
- **`"manage"` reference audit**: Grep confirmed `"manage"` appears in sidebar code (4 locations, all in files listed in "Files to Modify") and in team admin pages (4 locations using a different i18n namespace — NOT affected). No other sidebar-related references exist.
- **No route changes**: All routes (`/dashboard/audit-logs`, `/dashboard/teams/[id]/audit-logs`, etc.) remain unchanged. Only sidebar link visibility changes.
- **Admin sidebar unaffected**: The admin console sidebar (`admin-sidebar.tsx`) is NOT part of this refactor.
- **`activeAuditTeamId` removal scope**: This value is currently used only in `VaultManagementSection` to highlight the team audit log link. Since team audit log is removed from sidebar, this must be removed from the entire prop chain: `use-sidebar-navigation-state.ts` (return) → `sidebar.tsx` (destructuring) → `use-sidebar-view-model.ts` (params + return) → `SidebarContentProps` (interface) → `sidebar-content.tsx` (prop to VaultManagementSection) → `VaultManagementSectionProps` (interface). `isPersonalAuditLog` is still needed for Security section highlighting.
- **SettingsNavSection dual guard**: `SettingsNavSection` already hides its inner links via `!scopedTeam` (line 113). The new outer `{vaultContext.type !== "team" && ...}` guard in `sidebar-content.tsx` prevents the empty collapsible header from rendering. Both guards serve different purposes: inner = link visibility, outer = section visibility.
- **Team audit log RBAC**: Verified that `/api/teams/[teamId]/audit-logs` requires `TEAM_PERMISSION.TEAM_UPDATE` (ADMIN/OWNER only). Member/Viewer cannot access the endpoint, so removing the sidebar link has no access regression — ADMIN/OWNER use admin console instead.

## User Operation Scenarios

1. **Personal vault user navigates sidebar**: Sees Folders and Tags as separate sections. Clicks Audit Log inside Security section. Section auto-expands correctly.
2. **Team Owner views team sidebar**: Sees Folders/Tags sections, Archive/Trash/Share Links, Watchtower under Security, Export/Import under Tools. No Audit Log, no Settings. Accesses audit log via admin console.
3. **Team Viewer views team sidebar**: Same as Owner minus Watchtower (Security hidden), minus folder/tag create buttons.
4. **User switches between personal and team vault**: Sidebar sections update correctly. Audit Log appears/disappears. Settings section appears/disappears.
5. **User with existing localStorage**: `sidebar-collapsed` with old `manage` key — no crash, new `folders`/`tags` keys use defaults.

## Files to Modify

| File | Purpose |
|------|---------|
| `src/hooks/use-sidebar-sections-state.ts` | SidebarSection type, defaults, auto-expand |
| `src/components/layout/sidebar-sections.tsx` | Split ManageSection, remove Audit Log from VaultManagement |
| `src/components/layout/sidebar-section-security.tsx` | Add Audit Log, conditional rendering |
| `src/components/layout/sidebar-content.tsx` | Section composition, conditional rendering |
| `src/hooks/use-sidebar-view-model.ts` | Props update |
| `src/hooks/use-sidebar-navigation-state.ts` | Remove activeAuditTeamId (if safe) |
| `src/components/layout/sidebar.tsx` | Prop threading |
| `messages/en/Dashboard.json` | i18n keys (if needed) |
| `messages/ja/Dashboard.json` | i18n keys (if needed) |
| `src/hooks/use-sidebar-sections-state.test.ts` | Test updates |
| `src/hooks/use-sidebar-navigation-state.test.ts` | Test updates |
| `src/hooks/use-sidebar-view-model.test.ts` | Test updates |
| `src/components/layout/sidebar-content.test.tsx` | Test updates |
| `src/components/layout/sidebar-sections.test.tsx` | Test updates |
| `src/components/layout/sidebar-section-security.test.tsx` | Test updates |
| `src/components/layout/sidebar-folder-crud.test.tsx` | Verify no ManageSection dependency |
| `src/components/layout/sidebar-shared.test.tsx` | Verify FolderTreeNode/TagTreeNode still work after split (verify only) |
| `src/hooks/use-sidebar-folder-crud.test.ts` | Verify onCreate handler path unchanged (verify only) |
| `src/hooks/use-sidebar-tag-crud.test.ts` | Verify onCreate handler path unchanged (verify only) |
