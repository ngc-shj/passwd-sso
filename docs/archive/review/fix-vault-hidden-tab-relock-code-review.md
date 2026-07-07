# Code Review: fix-vault-hidden-tab-relock
Date: 2026-07-08
Review round: 1

## Changes from Previous Round
Initial review. Note: a human reviewer (external) had already found the fail-open
regression in `handleVisibility` before this triangulate round; it was fixed prior
to launching the three experts, so the experts reviewed the corrected diff.

## Functionality Findings
No Critical/Major findings. All edge cases traced clean:
- First render (lastActivityRef=0): the reset effect runs before the auto-lock
  effect registers the interval, and the auto-lock effect early-returns unless
  UNLOCKED — no spurious lock.
- autoLockMinutes null → 15-min default correctly applies.
- Live prop change: ref read at call time + separate update effect keeps it
  current; no stale-closure bug despite the missing dep (intentional).
- Team vault has no timer; follows personal lock(). No dependency on removed logic.
- Fail-open fix confirmed correct and complete (absolute-timestamp comparison,
  robust to timer throttling).
- [Adjacent → test] document.hidden restored in test bodies, not afterEach.

## Security Findings
No Critical/Major findings.
- Item 1 (fail-open fix): CONFIRMED CLOSED. handleVisibility evaluates the
  threshold against wall-clock lastActivity before any updateActivity, so OS
  sleep/resume, mobile backgrounding, laptop-lid-close all lock on resume.
- Item 2 (other silent age-out paths): bfcache/discard covered by untouched
  pagehide/pageshow guards in vault-context.tsx; not weakened.
- Item 3 (background dormancy): fail-closed — enforcement runs on the resume
  event, not on a background timer.
- Item 4 (tenant bound): unaffected; cross-bound (vaultAutoLock ≤ session idle)
  still caps key residency server-side. This is the mitigation making the
  lengthened window acceptable.

- [S1] [Minor] Default-config gap when vaultAutoLockMinutes is null — PRE-EXISTING,
  in src/app/api/tenant/policy/route.ts (NOT in this diff). See Resolution Status.
- [S2] [Minor/informational] Lengthened in-memory exposure window is a deliberate,
  bounded (≤ session idle) tradeoff — acceptable. No action.
- [Adjacent → test] Regression test should assert lock-first ordering, not merely
  eventual lock.

## Testing Findings
- [T1] [Major] document.hidden can leak hidden=true to a later test on any
  assertion failure — restore was in test bodies (skippable on throw), not in
  teardown. Independently flagged by all three experts.
- [T2] [Minor] Missing coverage — autoLockMinutes changing mid-session via prop
  (incl. the "null does not reset to default" quirk).
- setSystemTime + fake-timers mechanism confirmed sound; no vacuous-pass /
  async-without-await / before-all-state red flags.

## Adjacent Findings
- [F-A / S-A → test] document.hidden teardown + lock-first ordering assertion —
  routed into T1 and the throttled-suspend test respectively; both applied.

## Resolution Status

### [T1] [Major] document.hidden test-isolation leak — FIXED
- Action: Added a `setHidden(boolean)` helper; reset `document.hidden=false` in
  both beforeEach and afterEach (teardown runs even on throw). Removed all
  in-body trailing restore lines and switched every mutation to `setHidden(...)`.
- Modified file: src/lib/vault/auto-lock-context.test.tsx:11-13 (helper), 12-24
  (before/afterEach), and all hidden-tab tests.

### [T2] [Minor] Missing mid-session prop-change coverage — FIXED (30-min rule)
- Action: Added test "applies a mid-session autoLockMinutes prop change on the
  next tick" using RTL `rerender` (mount at 10 min, lower to 1 min, assert the
  new threshold governs locking).
- Modified file: src/lib/vault/auto-lock-context.test.tsx.

### [Adjacent → test] Lock-first ordering assertion — FIXED
- Action: The throttled/suspended regression test now asserts
  `toHaveBeenCalledTimes(1)` on the visibilitychange event with no interval tick
  in between — proving lock fires synchronously on return (lock-first), not a
  reset-then-later-lock. The fresh-return test asserts lock is NOT called on
  return, jointly pinning the branch (aged-out → lock, fresh → updateActivity).
- Modified file: src/lib/vault/auto-lock-context.test.tsx.

### [S1] [Minor] Default-config gap when vaultAutoLockMinutes is null — Pre-existing
- **Anti-Deferral check**: pre-existing in an UNCHANGED file (tenant/policy/route.ts
  is not in `git diff main...HEAD`).
- **Justification** (Adjacent routing): Security expert scope. File:line
  src/app/api/tenant/policy/route.ts:742-745 — the cross-bound check
  (vaultAutoLock ≤ sessionIdle) is skipped when vaultAutoLock is null, but the
  client default (15 min) is then never validated against a lower sessionIdle.
  Worst case: a tenant sets sessionIdle=10 and leaves vaultAutoLock null → a
  never-navigated visible tab keeps the key ~5 min past session-idle. Likelihood:
  low (requires sessionIdle < 15 AND null vaultAutoLock AND a never-touched tab;
  pageshow/session-refresh re-locks on any navigation/resume). Cost to fix: small
  but touches a security-boundary validation path out of this PR's scope.
  TODO(vault-null-autolock-default): resolve null to the concrete client default
  (15) before the cross-field comparison in tenant/policy/route.ts, or reject
  null when sessionIdleTimeoutMinutes < 15.
- **Orchestrator sign-off**: pre-existing-in-unchanged-file exception satisfied;
  routed to Security scope with a grep-able TODO marker. Not introduced by this
  change (the old 5-min hidden cap did not address it either).

## Recurring Issue Check
Scope is a single client-side timer module + its test + docs. Relevant R-rules:
- R23 (numeric-input per-keystroke clamp): N/A — no input handler.
- R26 (disabled-state visible cue): N/A — no UI controls added.
- R28 (toggle label grammar): N/A.
- R29 (citation hallucination): N/A — no spec citations in code.
- R42 (class-membership): the "removed hidden-timeout" is a single-site change;
  verified no other file references DEFAULT_HIDDEN_TIMEOUT_MS / hiddenAtRef /
  hiddenLockMsRef (grep clean). Team vault has its own independent visibilitychange
  handler (key redistribution) — unrelated, not a member of this class.
- Fail-open/background-dormancy (common-rules "runtime environment constraints"):
  addressed — design fails closed on resume.

## Environment Verification Report
N/A — no environment constraints declared in Phase 1. Manual verification of the
lock-on-resume behavior in a real browser is recommended but the automated
regression test (setSystemTime throttled-interval path) covers the core invariant.
