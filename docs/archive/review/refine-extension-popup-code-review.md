# Code Review: refine-extension-popup
Date: 2026-03-28
Review rounds: 2 (all findings resolved at round 2)

## Round 1

### Functionality Findings
#### [F-1] Major: Stale badges on other tabs after unlock
- **Resolution:** Added `await clearAllTabBadges()` to unlock branch of `updateBadge()`

#### [F-2] Major: Fire-and-forget race in clearAllTabBadges
- **Resolution:** Changed to `await` + `Promise.all` for per-tab clears

### Testing Findings
#### [T-1] Major: No coverage for onActivated/onUpdated listeners
- **Resolution:** Extended test harness with `tabActivatedHandlers`/`tabUpdatedHandlers`, added 3 tests

#### [F-3] Minor: urlHost null-safety assumption
- **Resolution:** Skipped (type guarantees via DecryptedEntry interface)

#### [T-2] Minor: Narrow autofill button test
- **Resolution:** Skipped (button removed from all states)

## Round 2

#### [T-3] Minor: unlock branch clearAllTabBadges not asserted
- **Resolution:** Added `{ text: "", tabId: 1 }` assertion to unlock badge test

## Resolution Status

| ID | Severity | Status | Action |
|----|----------|--------|--------|
| F-1 | Major | Resolved | await clearAllTabBadges in unlock branch |
| F-2 | Major | Resolved | Promise.all + await |
| T-1 | Major | Resolved | 3 tab event tests added |
| F-3 | Minor | Skipped | Type guarantee sufficient |
| T-2 | Minor | Skipped | Button removed entirely |
| T-3 | Minor | Resolved | Assertion added to unlock test |
