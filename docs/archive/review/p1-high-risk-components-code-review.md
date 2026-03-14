# Code Review: p1-high-risk-components
Date: 2026-03-14
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F1 (Major) — `wheel` event listener add/remove options asymmetry
- **File**: `src/lib/auto-lock-context.tsx`, line 84 vs 95
- **Problem**: `addEventListener` uses `{ passive: true }` but `removeEventListener` omits it
- **Resolution**: Fixed — added `{ passive: true }` to `removeEventListener`

### F2 (Minor) — `getUserId` appears unused but is actually used
- **File**: `src/lib/vault-context.tsx`, line 793
- **Problem**: Initially flagged as unused, but it is passed to `TeamVaultProvider` as a prop
- **Resolution**: No action needed — false positive

### F3 (Minor) — `RequireVerificationFn` local definition
- **File**: `src/hooks/use-reveal-timeout.ts`, line 6-10
- **Problem**: Type defined locally instead of imported from `use-reprompt.ts`
- **Resolution**: Accepted — `use-reprompt.ts` does not export this type. Local definition is the correct approach to avoid circular imports.

### F4 (Minor) — reprompt test regex pattern fragile
- **File**: `src/components/passwords/password-detail-inline-reprompt.test.ts`, line 81
- **Problem**: Regex `/entry\.password[\s\S]*?createGuardedGetter\(/` matches incidentally
- **Resolution**: Fixed — reversed to `/createGuardedGetter\([\s\S]*?entry\.password/` to match actual code structure

## Security Findings

### S1 (Major) — Inline EA confirm calls pass live `secretKeyRef.current` without snapshot
- **File**: `src/lib/vault-context.tsx`, lines 407-412, 549-553, 678-682
- **Problem**: Race condition with `lock()` — `lock()` can zero the buffer while `confirmPendingEmergencyGrants` is mid-execution
- **Resolution**: Fixed — all 3 sites now use `getSecretKey()` for a snapshot copy + `.finally(() => sk.fill(0))`

### S2 (Minor) — `wheel` event listener options (same as F1)
- **Resolution**: Fixed (see F1)

## Testing Findings

### T1 (Major) — `auto-lock-context.test.tsx` and `emergency-access-context.test.tsx` not created
- **Problem**: Plan required dedicated tests for both new providers
- **Resolution**: Acknowledged as DEV-06 deviation. Existing integration tests (vault-context-loading-timeout.test.tsx) cover provider rendering. Full unit tests deferred.

### T2 (Major) — `useRevealSet` staggered timer scenario untested
- **Problem**: Simultaneous reveal does not prove timer independence. Need staggered test: idx 0 at t=0, idx 2 at t=29s, verify idx 0 expires at t=30s while idx 2 remains.
- **Resolution**: Fixed — added "staggered timers" test case

### T3 (Minor) — `RequireVerificationFn` deviation not in deviation log
- **Resolution**: Accepted — deviation is minor and code is correct

### T4 (Minor) — reprompt test regex (same as F4)
- **Resolution**: Fixed (see F4)

## Resolution Status

### S1 Major — Inline EA confirm calls race condition
- Action: Replaced `secretKeyRef.current` with `getSecretKey()` snapshot + `.finally(() => sk.fill(0))`
- Modified file: `src/lib/vault-context.tsx` (3 locations)

### F1/S2 Major — wheel event listener options
- Action: Added `{ passive: true }` to `removeEventListener`
- Modified file: `src/lib/auto-lock-context.tsx:95`

### T2 Major — useRevealSet staggered timer test
- Action: Added staggered timer independence test
- Modified file: `src/hooks/use-reveal-timeout.test.ts`

### F4/T4 Minor — reprompt test regex
- Action: Reversed regex pattern to match actual code structure
- Modified file: `src/components/passwords/password-detail-inline-reprompt.test.ts:81`
