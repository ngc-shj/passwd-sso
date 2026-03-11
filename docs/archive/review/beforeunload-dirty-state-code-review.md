# Code Review: beforeunload-dirty-state
Date: 2026-03-11
Review round: 2

## Changes from Previous Round
Round 1 addressed: unused `act` import, test title mismatch, missing afterEach spy restore.
Round 2 covers full branch including post-review commits (SPA navigation guard, watchtower refactor).

## Functionality Findings

### F1 [Major] Dialog state not cleared when dirty becomes false (resolved)
- File: `src/hooks/use-navigation-guard.ts`
- Problem: If dialog is open and `dirty` changes to `false`, dialog stays open
- Action: Added useEffect to clear dialogOpen, pendingHref, and allowLeaveRef when dirty=false

### F2 [Major] allowLeaveRef never reset after confirmLeave (resolved)
- File: `src/hooks/use-navigation-guard.ts`
- Problem: allowLeaveRef stays true permanently after confirmLeave, disabling future guards
- Action: Fixed via same useEffect as F1

### F3 [Minor] onOpenChange type signature mismatch (skipped)
- Problem: cancelLeave is `() => void` but onOpenChange expects `(open: boolean) => void`
- Action: Skipped — TypeScript allows this (parameter bivariance), runtime behavior is correct

## Security Findings

### S1 [Minor] sessionStorage documentation inaccuracy (resolved)
- File: `docs/security/considerations/en.md`, `ja.md`
- Problem: "No keys currently stored" was incorrect — PRF-related items still exist
- Action: Updated to list `psso:prf-output`, `psso:prf-data`, `psso:webauthn-signin`

### S2 [Minor] allowLeaveRef not reset (duplicate of F2, resolved)

## Testing Findings

### T1 [Major] No tests for useNavigationGuard (resolved)
- File: `src/hooks/use-navigation-guard.test.ts` (new)
- Problem: Core SPA navigation guard logic was untested
- Action: Created 7 tests covering: dirty=false no intercept, internal link intercept, external link skip, cancelLeave, confirmLeave, dirty→false dialog clear, unmount cleanup

### T2 [Minor] returnValue assertion missing (skipped)
- Problem: jsdom `Event` doesn't simulate `BeforeUnloadEvent.returnValue` correctly
- Action: Skipped — environment limitation, not a code issue

### T3 [Minor] dirty=true→true rerender test missing (skipped)
- Problem: React useEffect deps guarantee this behavior
- Action: Skipped — over-testing

## Resolution Status
### F1 [Major] Dialog not cleared on dirty=false
- Action: Added useEffect with dirty dependency
- Modified file: src/hooks/use-navigation-guard.ts:28-33

### F2 [Major] allowLeaveRef never reset
- Action: Reset in same useEffect
- Modified file: src/hooks/use-navigation-guard.ts:31

### S1 [Minor] sessionStorage docs inaccuracy
- Action: Listed actual sessionStorage items
- Modified file: docs/security/considerations/en.md:358-362, ja.md:358-362

### T1 [Major] No useNavigationGuard tests
- Action: Created test file with 7 tests
- Modified file: src/hooks/use-navigation-guard.test.ts (new)
