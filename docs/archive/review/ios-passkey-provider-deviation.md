# Coding Deviation Log: ios-passkey-provider

## D1 — Extracted `EncryptedEntry.toPersonalCacheEntry()` (refactor beyond the plan's literal C4)

- **What**: The plan's C4 said "HostSyncService populates entryType in its `personal.map { CacheEntry(...) }` block." During Phase 2 I instead extracted the mapping into a single source of truth `EncryptedEntry.toPersonalCacheEntry()` (in `EntryFetcher.swift`), used by both `HostSyncService.runSync` and the `StubHostSyncService` test double.
- **Why**: The test stub (`HostSyncServiceTests.StubHostSyncService`) had its OWN copy of the EncryptedEntry→CacheEntry mapping. Asserting `entryType` propagation against the stub (RT5/RT1) would have tested the stub's copy, not production. Extracting one mapping lets the S6 test (`testPersonalCacheEntryPropagatesEntryType`) verify the production primitive directly, and removes the duplication (R1).
- **Net**: stronger test fidelity + less duplication; no behavior change.

## D2 — Pre-existing UI-test failures (NOT introduced by this branch)

- `PasswdSSOUITests.testPrimaryButtonIsHittable` and `testAppLaunches` fail in the local simulator (launch-screen "passwd-sso" / primary button not found).
- **Verified pre-existing**: the SAME two failures reproduce on a pristine `ios-main` worktree with no passkey changes (run 2026-06-12). Environment-specific (local simulator launch state), not a regression.
- **Anti-Deferral check**: pre-existing in an UNCHANGED file (`PasswdSSOUITests.swift` is not in this diff). Worst case: local UI smoke test red; Likelihood: environmental (clean CI runners are expected to pass — CI on `ios-main` is the reference); Cost to fix: out of scope (launch-screen/simulator issue unrelated to passkeys). Routed as [Adjacent] to a separate UI-test-stability task.
- **TODO(ios-uitest-launch)**: investigate launch-screen UI test stability separately.

## D3 — `signCount` removed from `PasskeyAssertionMaterial`

- Per C7 (emit 0 always), the stored counter is never read, so `PasskeyAssertionMaterial` does not carry `signCount` (as locked in the plan after round 1). Documented here because the round-1 plan draft briefly carried it.
