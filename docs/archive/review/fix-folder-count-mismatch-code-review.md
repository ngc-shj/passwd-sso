# Code Review: fix-folder-count-mismatch
Date: 2026-03-13T00:00:00+09:00
Review round: 3

## Round 1: Initial review

### Functionality Findings (Senior Software Engineer)

#### F1 [Major] `/api/v1/passwords/route.ts` not updated to use ACTIVE_ENTRY_WHERE
- **Problem:** v1 passwords endpoint still used the old 2-spread filter pattern
- **Impact:** Future changes to ACTIVE_ENTRY_WHERE would not propagate to this endpoint
- **Resolution:** Fixed — refactored to use `{ ...ACTIVE_ENTRY_WHERE }` like other endpoints

#### F2 [Minor] Test mock shape for `_count.passwords`
- **Problem:** Existing test uses `_count: { members: 5, passwords: 10 }` which passes regardless of filter
- **Resolution:** Accepted as-is — separate test case validates the where args

### Security Findings (Security Engineer)

No findings. Confirmed:
- Emergency access and rotate-key endpoints correctly excluded
- No information leakage risk from count changes
- Spread copy prevents reference mutation

### Testing Findings (QA Engineer)

#### T1 [Minor] 5 routes missing ACTIVE_ENTRY_WHERE test assertions
- **Problem:** Tags (personal/team/v1) and passwords (personal/team) routes lacked where arg verification
- **Resolution:** Added test for personal tags. Team tags already had existing test (L98-121). v1 routes and list queries accepted as lower priority since the constant is the single source of truth.

## Round 2: Client-side cache fix

#### F3 [Major] Browser HTTP cache causing stale sidebar counts
- **Problem:** `fetchApi()` in useSidebarData used browser default cache, returning stale responses
- **Resolution:** Added `{ cache: "no-store" }` to all fetchApi calls in sidebar hook

#### F4 [Major] Team mutation handlers not dispatching `team-data-changed` event
- **Problem:** Team page archive/delete/create/edit handlers did not notify sidebar to re-fetch
- **Resolution:** Added `window.dispatchEvent(new CustomEvent("team-data-changed"))` to all team mutation handlers

## Round 3: Missing event dispatches

### Functionality Findings (Senior Software Engineer)

#### F5 [Major] `team-archived-list.tsx` — `onSaved` callback missing event dispatch
- **Problem:** TeamEditDialogLoader's onSaved in archived list did not fire `team-data-changed`
- **Resolution:** Fixed — added event dispatch after `setExpandedId(null)`

#### F6 [Minor] `team-trash-list.tsx` — `handleEmptyTrash` missing event dispatch
- **Problem:** Empty trash operation did not notify sidebar
- **Resolution:** Fixed — added event dispatch after `clearSelection()`

#### F7 [Minor] Personal `trash-list.tsx` — restore/bulk operations missing `vault-data-changed`
- **Problem:** Personal trash restore and bulk actions did not notify sidebar to re-fetch counts
- **Resolution:** Fixed — added `vault-data-changed` dispatch to `handleRestore` and bulk `onSuccess`

#### F8 [Minor] Team page bulk action `onSuccess` missing event dispatch
- **Problem:** Bulk archive/trash on team page did not notify sidebar
- **Resolution:** Fixed — added event dispatch to bulk `onSuccess`

### Security Findings (Security Engineer)

No findings (Critical/Major). Minor note: DOM CustomEvent could be spoofed via XSS, but this is an existing pattern and XSS prevention is the primary defense.

### Testing Findings (QA Engineer)

No actionable findings for round 3 changes.

## Resolution Status

### F1 [Major] v1/passwords not using shared constant
- Action: Added import and refactored filter to use ACTIVE_ENTRY_WHERE
- Modified file: src/app/api/v1/passwords/route.ts:12,63-67

### T1 [Minor] Missing tag test
- Action: Added ACTIVE_ENTRY_WHERE filter verification test
- Modified file: src/app/api/tags/route.test.ts:53-70

### F3 [Major] Browser HTTP cache causing stale sidebar counts (Round 2)
- Action: Added `{ cache: "no-store" }` to fetchApi calls in useSidebarData
- Modified file: src/hooks/use-sidebar-data.ts:58
- Modified file: src/hooks/use-sidebar-data.test.ts:13,46-51

### F4 [Major] Team mutation handlers missing event dispatch (Round 2)
- Action: Added team-data-changed dispatch to team page handlers
- Modified files: src/app/[locale]/dashboard/teams/[teamId]/page.tsx, src/components/team/team-archived-list.tsx, src/components/team/team-trash-list.tsx

### F5 [Major] team-archived-list onSaved missing event dispatch (Round 3)
- Action: Added team-data-changed dispatch after edit save
- Modified file: src/components/team/team-archived-list.tsx:557

### F6 [Minor] team-trash-list handleEmptyTrash missing event dispatch (Round 3)
- Action: Added team-data-changed dispatch after empty trash
- Modified file: src/components/team/team-trash-list.tsx:241

### F7 [Minor] Personal trash-list missing vault-data-changed (Round 3)
- Action: Added vault-data-changed dispatch to handleRestore and bulk onSuccess
- Modified file: src/components/passwords/trash-list.tsx:155,146

### F8 [Minor] Team page bulk onSuccess missing event dispatch (Round 3)
- Action: Added team-data-changed dispatch to bulk onSuccess
- Modified file: src/app/[locale]/dashboard/teams/[teamId]/page.tsx:575
