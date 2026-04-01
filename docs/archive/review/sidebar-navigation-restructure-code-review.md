# Code Review: sidebar-navigation-restructure
Date: 2026-04-01T14:22:00+09:00
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

| ID | Severity | Problem | Resolution |
|----|----------|---------|------------|
| F-01 | Minor | FoldersSection header lacks icon (asymmetry with TagsSection) | Fixed — added FolderOpen icon |
| F-02 | Minor | FoldersSection test button selector fragile (merged with M2) | Fixed — use aria-label |
| F-03 | Minor | Dead code: auditTeamMatch/activeAuditTeamId still computed | Fixed — removed |
| F-04 | Major | Team context + `/dashboard/audit-logs` URL → security section auto-expands unnecessarily | Fixed — guard `isPersonalAuditLog` with `vaultContext.type !== "team"` in sidebar.tsx |

## Security Findings

No findings.

## Testing Findings

| ID | Severity | Problem | Resolution |
|----|----------|---------|------------|
| M1 | Major | `onCreateTag` remnant in sidebar-content.test.tsx baseProps | Fixed — removed |
| M2 | Major | FoldersSection test uses `getByRole("button")` without name filter | Fixed — use `{ name: "createFolder" }` |
| M3 | Major | TagsSection missing `showMenu={false}` test for Viewer guard | Fixed — added test + updated TagTreeNode mock |
| m1 | Minor | Redundant single-role audit log test (MEMBER) alongside all-roles loop | Fixed — removed redundant test |
| m2 | Minor | Missing `isPersonalAuditLog` auto-expand test | Fixed — added test case |
| m3 | Minor | `activeTeamId` assertion in navigation test — not an issue (separate prop) | No change needed |
| m4 | Minor | DropdownMenuItem mock comment recommendation | Skipped — unnecessary comment |

## Adjacent Findings
None

## Quality Warnings
None

## Resolution Status
All Critical and Major findings resolved. 5 of 7 Minor findings resolved, 2 skipped (no change needed / unnecessary).
