# Code Review: ios-biometric-stale-cache-resync

Date: 2026-07-04
Review round: 1 (incremental — on top of Phase 2 self-R-check baseline)

## Changes from Previous Round

Initial code review. Phase 2 Step 2-5 self-R-check already returned "No findings"
from all three experts (R1-R42 + RS*/RT*). Phase 3 Round 1 targeted NOVEL angles
the rote R-check does not cover: SwiftUI data-flow, control-flow completeness on
the new early-return path, security composition with surrounding readers, and the
passphrase-path behavior change. The three Phase-3 sub-agents hit the session
token limit mid-review; their verified conclusions (captured before termination)
plus the orchestrator's direct verification of the remaining open questions are
consolidated below.

## Functionality Findings

- **F1 [Major] — Passphrase-path empty-vault regression.** `decidePostSync`
  returned `.failLocked` for `(syncReport=nil, cacheRecovered=true,
  persistedCache=nil)`. Since the passphrase path always sets `cacheRecovered=true`,
  a **valid passphrase unlock** that then fails to sync AND has no persisted cache
  (brand-new account with zero entries, or first unlock while offline) was routed
  to `.vaultLocked` — a correct passphrase landing on the locked screen with no
  data. The old code synthesized an empty vault here, which for the passphrase path
  is the correct success state. This violated the spirit of INV-C5.2 (passphrase
  offline behavior unchanged). The `.failLocked` fail-closed semantics belong ONLY
  to the biometric `cacheRecovered=false` case (stale/rolled-back cache).
  - **Fix (applied)**: added a distinct `.useEmptyCache` outcome. When
    `cacheRecovered==true && sync-failed && persistedCache==nil` → `.useEmptyCache`
    (synthesize empty vault, proceed to `.vaultUnlocked`). `.failLocked` now fires
    ONLY when `cacheRecovered==false`. S2 is untouched (the empty cache is
    synthesized, never read from disk; the `cacheRecovered==false` path still fails
    closed). `PostSyncDecision.swift`, `RootView.swift` switch, and the AC-C5.4 test
    updated; a new test pins the fail-closed direction for `cacheRecovered==false`.

- **F2 [verified clean] — `.failLocked` early-return control flow.** On the
  `.failLocked` path `handleVaultUnlocked` sets `appState=.vaultLocked` and returns
  `false` before `onVaultReady`/`tokenRefresher`/`autoLockService.startTimer`. The
  `autoLockService` created earlier is simply not started (no timer leak — it's a
  local that is deinitialized); `hostSyncService` was assigned but is harmless
  (overwritten on the next successful unlock). No resource leak that affects a
  retry.

- **F3 [verified clean] — SwiftUI data-flow for the error banner.** Setting the
  `@State biometricErrorText` after `handleVaultUnlocked` (which set
  `appState=.vaultLocked`) triggers one batched re-render; `body` → `.vaultLocked`
  → `vaultLockedScreen` → `VaultUnlockView(externalError: biometricErrorText)`
  reads the fresh value. The passphrase-attempt closure clears it (`:307`). Error
  is displayed, not set-but-lost.

- **F4 [verified clean] — zero-personal-entries keyVersion.** `syncedKeyVersion`
  returns `max(1, nil ?? 1) = 1` when the synced cache has no personal entry —
  consistent with the existing fresh-cache biometric path (`VaultUnlocker.swift:261`).
  Not a bug.

- **F5 [verified clean] — I/O error vs staleness in the catch.** `catch let error
  as EntryCacheError` catches BOTH `.rejection` (stale/counter/AAD) AND `.ioError`
  (corrupt/unreadable file). Degrading a corrupt local cache to `cacheRecovered=false`
  → resync is correct (rebuild from server), same as staleness. Catching both is
  intended.

## Security Findings

- **S1 [verified clean] — composition, no stale read on the resync path.**
  `HostSyncService.performSync` on the unlock path always returns a non-nil
  `cacheData` (`HostSyncService.swift:128,145-150`), so `syncReport != nil ⟹
  cacheData != nil` and `.useFreshCache` never presents empty. On the
  `cacheRecovered==false`→`.useFreshCache` path, `refreshCredentialIdentities`
  receives `cacheData = syncReport.cacheData` (freshly synced), NOT the stale file
  (`RootView.swift:451-453`). No other reader decodes the stale cache before the
  resync overwrites it. S2 gating (readCacheFile unreachable when
  `cacheRecovered==false`) re-confirmed in the committed code.
- **S2 [verified clean] — F1 fix does not weaken fail-closed.** `.useEmptyCache`
  fires only when `cacheRecovered==true`; the empty cache is synthesized, never read
  from disk. The `cacheRecovered==false` path is unchanged (`.failLocked`). The
  rollback/replay invariant is preserved.
- **S3 [verified clean] — persisted userId integrity.** `recoveredUserId` flows to
  `runSync`'s userId param + cache-header AAD + `refreshCredentialIdentities`. A
  tampered App-Group userId causes self-healing AAD drift only; server authz is
  DPoP-token-bound, not userId-bound (plan S3 confirmed in code).
- **S4 [verified clean] — no sensitive log/state leak.** The `handleVaultUnlocked`
  `Logger.error` line is pre-existing and logs a `MobileAPIError` description (no
  token/userId/key). `biometricErrorText` only ever holds the static localized
  "session out of date" string or `nil`.

## Testing Findings

- **T1 [addressed by F1 fix]** — AC-C5.4 was updated from `.failLocked` to
  `.useEmptyCache` and a new `testDecidePostSync_failedSync_cacheless_stillFailsClosed`
  pins the fail-closed direction for `cacheRecovered==false`. The passphrase-empty-vault
  behavior is covered at the `decidePostSync` seam (the RootView switch only maps
  `.useEmptyCache → emptyCacheData`, a trivial glue not independently testable
  without a SwiftUI host — VC2-deferred, acceptable).
- **T2 [verified clean]** — Phase 2 self-R-check already confirmed fails-before for
  the three biometric regression tests, adequate coverage of the 4 new pure symbols,
  and determinism (fixed `now` injection). No new gap introduced by the F1 fix.

## Adjacent Findings

None.

## Quality Warnings

None.

## Recurring Issue Check

Phase 2 Step 2-5 self-R-check ran the full R1-R42 (+ RS1-RS5 / RT1-RT7) pass with
all three experts returning "No findings" (recorded in the Phase 2 completion
report). Phase 3 incremental review surfaced one novel behavior-change finding
(F1) outside the rote checklist and confirmed the rest clean. No R-rule regression
introduced by the F1 fix (the `.useEmptyCache` addition is a pure-function branch +
one switch case + two test updates).

## Environment Verification Report

Per the Phase 1 `Verification environment constraints`:
- **VC1 (real Face ID/Touch ID prompt)**: `blocked-deferred (VC1)` — the biometric
  keychain read is exercised via `MockKeychainAccessor`; the real Secure-Enclave
  prompt requires a physical device (Anti-Deferral cost-justification recorded in
  Phase 1). Everything downstream of the keychain read is `verified-local`.
- **VC2 (SwiftUI state transitions)**: `blocked-deferred (VC2)` — RootView
  `appState` transitions verified by code review + the pure-function tests
  (`decidePostSync`/`biometricUnlockError`/`resolveDisplayError`); no SwiftUI test
  host in the target (Anti-Deferral recorded in Phase 1).
- All non-VC1/VC2 paths: `verified-local` — `xcodebuild test -scheme PasswdSSOApp`,
  683 unit + 2 UI tests, 0 failures.

## Resolution Status

### F1 [Major] Passphrase-path empty-vault regression — FIXED
- Action: added `.useEmptyCache` outcome to `PostSyncOutcome`; `decidePostSync`
  returns it for `(nil, cacheRecovered=true, nil)` instead of `.failLocked`;
  RootView switch maps it to `emptyCacheData`. Fail-closed (`.failLocked`) now fires
  only for `cacheRecovered==false`.
- Modified: `ios/PasswdSSOApp/Vault/PostSyncDecision.swift`,
  `ios/PasswdSSOApp/Views/RootView.swift`,
  `ios/PasswdSSOTests/PostSyncDecisionTests.swift`.
- Verified: 683 unit tests pass.

All other Phase-3 angles (F2-F5, S1-S4, T2) verified clean — no action needed.
