# Plan Review: auth-session-improvements
Date: 2026-03-13T00:00:00+09:00
Review round: 2

## Round 1 Findings and Resolution

### F1 [Major] `useSession()` double-call and `update` ref instability → **Resolved**
- Changed to single `useSession()` call with `update` in existing destructure
- Added `useRef` pattern to stabilize reference
- Removed `update` from useEffect dependency array

### F2 [Minor] Missing note about passkey signIn bypass → **Resolved**
- Added to Considerations section

### S1 [Major] `rotate-master-key` userAgent in non-browser context → **Resolved**
- Changed Step 3 to NOT add `userAgent`; only fix `ip` duplication in `metadata`

### S2 [Minor] AsyncLocalStorage context fragility → **Skipped**
- Existing `?? null` fallback is sufficient

### T1 [Major] Existing tests will break → **Resolved**
- Step 5 now explicitly includes updating existing test assertions

### T2 [Minor] React component test infrastructure → **Resolved**
- Confirmed `@testing-library/react` and `jsdom` are in devDependencies
- Existing `.test.tsx` files use `// @vitest-environment jsdom` annotation

## Round 2 Changes
- Applied all Round 1 fixes to plan
- Added note about NextAuth mocking requirements for auth.ts events tests

## Round 2 Functionality Findings
No findings.

## Round 2 Security Findings
No findings.

## Round 2 Testing Findings

### T-R2-1 [Minor] auth.ts events test requires NextAuth mocking
- **Severity**: Minor
- **Problem**: Testing `events.signIn`/`events.signOut` directly requires mocking `NextAuth` internals, which adds complexity.
- **Impact**: Test implementation may be more complex than anticipated.
- **Recommended action**: Added note to Step 5 suggesting integration test path as alternative. → **Resolved in plan**
