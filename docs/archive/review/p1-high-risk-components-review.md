# Plan Review: p1-high-risk-components
Date: 2026-03-14
Review round: 1 (converged)

## Changes from Previous Round
Initial review — all findings addressed in plan update.

## Functionality Findings

### F1 (Critical) — useRevealTimeout missing timer cleanup spec
- **Problem**: Plan didn't specify `clearTimeout` on rapid toggle or `useEffect` unmount cleanup
- **Impact**: Stale `setTimeout` callbacks could fire after component unmount (React state update on unmounted)
- **Resolution**: Added `timerRef` + `clearTimeout` spec and `useEffect` cleanup to Phase 9a

### F2 (Critical) — password-detail-inline-reprompt.test.ts will break
- **Problem**: Test uses `readFileSync` to count `handleReveal` occurrences in the source file. After extraction, parent file has fewer occurrences.
- **Impact**: Test assertion fails silently — false pass or false fail
- **Resolution**: Added explicit step in Step 3 to update the test assertion target

### F3 (Critical) — useRevealSet needs independent timer management
- **Problem**: Plan described `useRevealSet` as a variant of `useRevealTimeout`, but Set-based reveal (history/fields) needs per-index independent timers
- **Impact**: Using single timer for multiple indices would cause all to hide when any one expires
- **Resolution**: Specified `useRevealSet` as independent hook with `Map<number, TimerId>` for per-index timers. Added test cases for multi-index independence and stale-setTimeout.

### F4 (Major) — EA secret key snapshot not zeroed after use
- **Problem**: `confirmPendingEmergencyGrants()` calls `getSecretKey()` which returns a copy. The copy stays in memory after use.
- **Impact**: Secret key material persists longer than necessary
- **Resolution**: Added `.finally(() => snapshot.fill(0))` zeroing spec to Step 6

### F5 (Major) — EA missing inFlight guard test
- **Problem**: EA auto-confirm runs on 2-minute interval. If a confirm request is still in-flight when next interval fires, concurrent requests could occur.
- **Impact**: Duplicate EA confirmations or race conditions
- **Resolution**: Added `inFlight` guard continuation test to EA test plan

## Security Findings

### S1 (Major) — keyVersion passed as ref to EmergencyAccessContext
- **Problem**: Plan showed `keyVersion={keyVersionRef}` passing the ref object instead of the value
- **Impact**: EA context could read stale or mutated ref value
- **Resolution**: Changed to `keyVersion={keyVersionRef.current}` (number value) and specified `keyVersion: number` in EA props

### S2 (Major) — autoLockMsRef initialization coupling
- **Problem**: Original plan used callback pattern for timeout setter between contexts
- **Impact**: Unnecessary coupling between VaultUnlockContext and AutoLockContext
- **Resolution**: Changed to props-down pattern — VaultUnlockContext stores values as state, passes as props

## Testing Findings

### T1 (Major) — useReprompt ownership ambiguity
- **Problem**: Plan didn't specify which component owns `useReprompt()` after section extraction
- **Impact**: Multiple `useReprompt()` calls could create duplicate dialogs or broken reprompt flow
- **Resolution**: Explicitly specified parent-only ownership. Sections receive `requireVerification` + `createGuardedGetter` as props. Parent renders `repromptDialog`.

### T2 (Major) — vault-context-loading-timeout.test.tsx may need provider mock update
- **Problem**: After splitting VaultContext, the loading timeout test may need updated mocks for new provider nesting
- **Impact**: Test could fail or not properly test the loading timeout path
- **Resolution**: Added note in Testing Strategy that this test may need provider mock updates

### T3 (Minor) — RequireVerificationFn import source unspecified
- **Problem**: `useRevealTimeout` uses `RequireVerificationFn` type but import source not specified
- **Impact**: Could lead to circular imports if imported from wrong module
- **Resolution**: Specified import from `@/hooks/use-reprompt`

### T4 (Minor) — useRevealSet test coverage gaps
- **Problem**: Plan only listed basic test cases for useRevealSet
- **Impact**: Edge cases in multi-index timer management could go untested
- **Resolution**: Added specific test cases: multi-index independent timers, stale-setTimeout prevention, unmount clears all map entries
