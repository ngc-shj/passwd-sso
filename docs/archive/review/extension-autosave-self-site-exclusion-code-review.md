# Code Review: extension-autosave-self-site-exclusion
Date: 2026-03-27
Review rounds: 4 (all findings resolved at round 4)

## Round 1 — Initial Review

### Functionality Findings
#### [F-1] Minor: Function name mismatch
- **Problem:** `shouldSuppressInlineMatches` no longer accurately describes its full purpose after being reused for auto-save banner suppression.
- **Resolution:** Renamed to `isOwnAppPage` across all 3 call sites.

### Security Findings
No findings.

### Testing Findings
#### [T-1] Major: No test for LOGIN_DETECTED + self-site suppression
- **Problem:** No test exercised the new `isOwnAppPage` check in `LOGIN_DETECTED`.
- **Resolution:** Added 2 tests in `describe("LOGIN_DETECTED suppresses on own app")`.

#### [T-2] Minor: Function name in test descriptions
- **Resolution:** No change needed — existing tests specifically test inline match suppression.

## Round 2 — Incremental Review

### Functionality Findings
#### [N-1] Major: SAVE_LOGIN handler missing isOwnAppPage check
- **Problem:** `SAVE_LOGIN` could accept credentials from own app if called directly.
- **Resolution:** Added `isOwnAppPage` defense-in-depth check to both `SAVE_LOGIN` and `UPDATE_LOGIN`.

#### [N-2] Minor: Test serverUrl mock implicit dependency
- **Resolution:** Skipped — consistent with existing test patterns across the file.

### Testing Findings
#### [T-3] Minor: Test name "returns save/update action" inaccurate
- **Resolution:** Renamed to "does not suppress login on non-app URLs".

#### [T-4] Minor: No test for message.url vs sender.tab.url trust model
- **Resolution:** Skipped — out of scope for this fix (pre-existing design).

## Round 3 — Incremental Review

### Functionality Findings
#### [N-3] Minor: UPDATE_LOGIN null check asymmetric with SAVE_LOGIN
- **Problem:** `UPDATE_LOGIN` used `if (url && ...)` while `SAVE_LOGIN` used `if (!url) return`.
- **Resolution:** Aligned `UPDATE_LOGIN` to same `NO_TAB` guard pattern as `SAVE_LOGIN`.

### Testing Findings
#### [T-5] Major: No tests for SAVE_LOGIN / UPDATE_LOGIN OWN_APP checks
- **Problem:** Defense-in-depth guards added but untested.
- **Resolution:** Added 2 test cases: "rejects SAVE_LOGIN from own app pages", "rejects UPDATE_LOGIN from own app pages".

## Round 4 — Final Review

No findings from any expert (functionality, security, testing).

## Additional Fixes
### Pre-existing TS error at background.test.ts:1029
- **Problem:** `resolveSessionGet` typed as `((value: unknown) => void) | null` — TS narrowed to `never` after `new Promise` callback.
- **Resolution:** Changed to definite assignment assertion (`let resolveSessionGet!: ...`) and removed optional chaining.

## Resolution Status

| ID | Severity | Status | Action |
|----|----------|--------|--------|
| F-1 | Minor | Resolved | Renamed function to `isOwnAppPage` |
| T-1 | Major | Resolved | Added 2 tests for LOGIN_DETECTED |
| N-1 | Major | Resolved | Added isOwnAppPage to SAVE_LOGIN + UPDATE_LOGIN |
| N-2 | Minor | Skipped | Consistent with existing patterns |
| T-3 | Minor | Resolved | Fixed test name |
| T-4 | Minor | Skipped | Out of scope |
| N-3 | Minor | Resolved | Aligned UPDATE_LOGIN null check pattern |
| T-5 | Major | Resolved | Added 2 tests for SAVE_LOGIN + UPDATE_LOGIN |
| Pre-existing | — | Resolved | Fixed TS error at L1029 |
