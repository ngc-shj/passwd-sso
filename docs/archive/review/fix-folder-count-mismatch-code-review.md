# Code Review: fix-folder-count-mismatch
Date: 2026-03-13T00:00:00+09:00
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings (Senior Software Engineer)

### F1 [Major] `/api/v1/passwords/route.ts` not updated to use ACTIVE_ENTRY_WHERE
- **Problem:** v1 passwords endpoint still used the old 2-spread filter pattern
- **Impact:** Future changes to ACTIVE_ENTRY_WHERE would not propagate to this endpoint
- **Resolution:** Fixed — refactored to use `{ ...ACTIVE_ENTRY_WHERE }` like other endpoints

### F2 [Minor] Test mock shape for `_count.passwords`
- **Problem:** Existing test uses `_count: { members: 5, passwords: 10 }` which passes regardless of filter
- **Resolution:** Accepted as-is — separate test case validates the where args

## Security Findings (Security Engineer)

No findings. Confirmed:
- Emergency access and rotate-key endpoints correctly excluded
- No information leakage risk from count changes
- Spread copy prevents reference mutation

## Testing Findings (QA Engineer)

### T1 [Minor] 5 routes missing ACTIVE_ENTRY_WHERE test assertions
- **Problem:** Tags (personal/team/v1) and passwords (personal/team) routes lacked where arg verification
- **Resolution:** Added test for personal tags. Team tags already had existing test (L98-121). v1 routes and list queries accepted as lower priority since the constant is the single source of truth.

## Resolution Status

### F1 [Major] v1/passwords not using shared constant
- Action: Added import and refactored filter to use ACTIVE_ENTRY_WHERE
- Modified file: src/app/api/v1/passwords/route.ts:12,63-67

### T1 [Minor] Missing tag test
- Action: Added ACTIVE_ENTRY_WHERE filter verification test
- Modified file: src/app/api/tags/route.test.ts:53-70
