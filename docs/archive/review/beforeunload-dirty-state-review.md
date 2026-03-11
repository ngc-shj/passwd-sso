# Plan Review: beforeunload-dirty-state
Date: 2026-03-11
Review round: 1

## Changes from Previous Round
Initial review

## Local LLM Pre-screening (addressed before expert review)
- [Major] SPA navigation guard -> out of scope (documented in considerations)
- [Major] Keyboard shortcut blocking -> not needed (documented in considerations)
- [Minor] Stray references audit -> addressed
- [Minor] Unit test quality -> e.preventDefault verification added
- [Minor] Documentation update -> added as step 5

## Functionality Findings

### F1 [Major] auto-extension-connect.tsx dead code after global guard removal
handleCloseTab sets SKIP_BEFOREUNLOAD_ONCE_KEY and useEffect sets/clears ALLOW_BEFOREUNLOAD_WHILE_CONNECTED_KEY. After global guard removal, these become dead code. Must clean up handleCloseTab to just call window.close() and remove the ALLOW useEffect entirely.
- **Resolution:** Accepted. Step 4 description updated to explicitly include full cleanup of handleCloseTab and ALLOW useEffect.

### F2 [Major] Team forms are dialog-only — Step 8 is unnecessary
Team forms (team-login-form.tsx etc.) do not have a page variant. They are always rendered inside TeamEntryDialogShell. Adding useBeforeUnloadGuard contradicts the "dialog variants don't need it" consideration.
- **Resolution:** Accepted. Step 8 removed entirely. Team forms excluded from scope.

### F3 [Minor] Security docs update description too vague
Step 5 should explicitly mention removing psso:skip-beforeunload-once entry from sessionStorage section.
- **Resolution:** Accepted. Step 5 clarified.

### F4 [Minor] Personal forms need variant guard on hook call
useBeforeUnloadGuard(hasChanges) should be useBeforeUnloadGuard(!isDialogVariant && hasChanges) to avoid triggering in dialog variant.
- **Resolution:** Accepted. Implementation example updated.

## Security Findings

### S1 [Minor] e.returnValue = "" pattern is acceptable
Both e.preventDefault() and e.returnValue = "" should be kept for browser compatibility.
- **Resolution:** No change needed. Current approach is correct.

### S2 [Minor] Import done state guard-off is correct but undocumented
When done === true, guard is removed. Data is already server-side so no loss risk.
- **Resolution:** Will add code comment during implementation.

### S3 [Minor] handleCloseTab cleanup is straightforward
After global guard removal, sessionStorage operations in handleCloseTab are unnecessary. Just keep window.close().
- **Resolution:** Same as F1.

## Testing Findings

### T1 [Major] auto-extension-connect.tsx lacks test for window.close()
When cleaning up handleCloseTab, there's risk of accidentally removing window.close() call. No existing test covers this.
- **Resolution:** Accepted but deferred — auto-extension-connect.tsx already has comprehensive tests. The cleanup is trivial (remove sessionStorage lines, keep window.close()). Adding a specific test for window.close() is out of scope for this PR.

### T2 [Major] Team forms are dialog-only (duplicate of F2)
- **Resolution:** Same as F2. Step 8 removed.

### T3 [Major] Import guard misses encrypted file decryption state
When user selects an encrypted file and is entering decryption password (encryptedFile !== null, entries.length === 0), guard is not active.
- **Resolution:** Accepted. Guard condition updated to include encryptedFile state.

### T4 [Minor] Unit test should cover dirty state transitions
Test should verify: (a) dirty=false -> no listener, (b) false->true -> listener added, (c) true->false -> listener removed, (d) unmount -> cleanup.
- **Resolution:** Accepted. Test specification expanded.

### T5 [Minor] Security docs may have other stale references
docs/setup/docker mentions "reload confirmation dialog" in HMR context.
- **Resolution:** Will check during implementation but likely unrelated (HMR dev-only behavior).
