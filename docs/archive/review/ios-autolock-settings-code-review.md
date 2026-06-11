# Code Review: ios-autolock-settings (PR #535)

Date: 2026-06-11
Review round: 1 (converged)
Base: `ios-main` (= origin/main). Scope: `git diff ios-main...HEAD` — 12 files, the Settings screen +
auto-lock minutes / vault timeout action / clipboard seconds / theme + `.loggedOut` state.

## Functionality Findings
- **F1 (Minor) — FIXED**: dead no-op `if state == .unlocked {}` block in `AutoLockService.recordActivity()`
  removed (AutoLockService.swift). Behavior identical.
- **F2 (Minor) — no action**: clipboard picker getter reads `store` (a struct over UserDefaults) rather
  than a live `@Observable` — functionally benign (the sheet is the only writer; SwiftUI re-renders on
  set). No backing observable for clipboard seconds exists; nothing to change.
- Verified correct: `.loggedOut` routing (exhaustive switch; manual Lock still → `.vaultLocked`; no
  double-transition flicker), all SettingsView bindings (live service + persist + recordActivity),
  gear entry, clipboard default 30 at both sites, theme @AppStorage reactivity, fail-closed getters,
  both unlock sites apply minutes+timeoutAction, suite-name consistency.

## Security Findings
- **No findings.** Fail-closed throughout; logout strictly ⊇ lock; clipboard max 300s acceptable
  (opt-in, `.localOnly` + hard expiration); App Group tamper cannot disable auto-lock (clamps to
  secure default); per-fill biometric + bridge_key unchanged; AutoFill extension / Shared untouched.
- **N1 (informational) — accepted, no change**: service `autoLockMinutes` setter clamps `[1,60]`
  while the store/UI clamp `[5,60]`. The `[1,60]` floor matches `LockState`/`LockStateReducer` (an
  intentional two-layer design: service = absolute floor matching the reducer, store = stricter UI
  floor). Floor-1 is unreachable from any real input (store + picker only emit ≥5). Changing it would
  diverge from the reducer contract and churn `testAutoLockMinutesClamped`. Anti-Deferral: worst case
  = a hypothetical future caller bypassing the store could set 1–4 min (still locks, just sooner — not
  a weakening); likelihood low (no such caller); cost-to-fix non-trivial (breaks the reducer-aligned
  contract + a test). Accepted.

## Testing Findings (all Minor — FIXED)
- **T1**: clipboard boundary coverage — added `testClipboardAcceptsBoundaryOptions` (10/300 kept) and
  `testClipboardJustOutsideOptionsReturnsThirty` (9/301 → 30).
- **T2**: `testMinutesRawStoredZeroClampsToMin` — present raw 0 → 5 (proves stored-0 ≠ absent-15).
- **T3**: `testTimeoutActionInvalidRawValueReturnsLock` — garbage rawValue → `.lock`.
- **T4**: `testSignOutDeletesEverything` now asserts final state `.loggedOut`.
- **T5**: `testTickLocksAtBoundary` now asserts the wrapped key SURVIVES a `.lock` timeout (mirror of
  the logout test's clear assertion).
- Confirmed sound: TestClock+tick injection (no real-timer race), default-15 direct construction,
  per-test UserDefaults isolation, no vacuous/async-unawaited red flags. Regression-clean
  (LockStateReducer + service clamp tests unaffected by 5→15 and the new state case).

## Resolution Status
All Functionality (F1) and Testing (T1–T5) findings fixed; Security clean (N1 accepted with
quantified justification). Build clean; **261 unit tests pass** (+4 net). Round 1 converged
(remaining items were test-only additions + a no-op dead-code removal — tightening-only termination).
