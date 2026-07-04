# Plan Review: ios-biometric-stale-cache-resync

Date: 2026-07-04
Review round: 1

## Changes from Previous Round

Initial review. Three expert agents (functionality, security, testing) reviewed
the Round-0 plan against the actual source (`VaultUnlocker`, `RootView`,
`EntryCacheFile`, `WrappedKeyStore`, `HostSyncService`, `VaultViewModel`,
`CredentialResolver`, `VaultUnlockerTests`).

**Convergent structural insight (all three experts):** the plan reasoned and
proposed tests at the `unlockWithBiometrics` seam, but the load-bearing logic —
the actual cache healing (FR1), the fail-closed guarantee (INV-C5.1), and
keyVersion correctness — all live in `handleVaultUnlocked` (`RootView.swift:345-397`),
which is the VC2-blocked, untested layer. The Round-2 plan must push that logic
into pure, tested functions and lock the sharp edges.

## Functionality Findings

- **F1 [Critical]** Legacy-vault bootstrapping gap. C4's optional `userId` field
  is decode-compatible but NOT behavior-compatible: a user who set up their vault
  before this ships has `userId=nil` in `wrapped-vault-key.json`. First
  post-upgrade biometric unlock **with a stale cache** → C1 failure branch reads
  `userId=nil` → throws `.cacheUnreadable`. The reported bug is only partially
  fixed for existing users until they do one passphrase unlock. Undocumented,
  untested. Offline+legacy+stale is an unavoidable hard-fail. (Verified:
  `VaultUnlocker.swift:168` producer, `WrappedKeyStore.swift:84-94` store.)
- **F2 [Major]** `keyVersion=1` on the `cacheRecovered=false` branch reaches
  `.vaultUnlocked` (`RootView.swift:419` uses `unlockResult.keyVersion`, not the
  synced value) and is **written back to the server** on create/edit
  (`VaultViewModel.swift:263,268,335,339` — `liveKeyVersion = max(1, keyVersion)`;
  `VaultListView.swift:18` threads it in). No decrypt/read problem (entry AAD is
  `userId+entryId+vaultType`, not keyVersion), but a wrong-low keyVersion is
  persisted on any mutation in that session. Plan's claim "sync supplies
  authoritative keyVersion" is false for the app-level value. **Confirmed against
  code.**
- **F3 [Major]** `WrappedVaultKey` memberwise `init` must add `userId: String? = nil`
  (default) or 15 call sites break (2 production + 13 test constructors). Plan's
  sweep undercounted producers (claimed 2, missed 13 test sites). With the
  default it's clean.
- **F4 [Minor]** FR3/INV-C1.3 "no network on fresh cache" conflates
  `unlockWithBiometrics` (genuinely no network) with the whole flow
  (`handleVaultUnlocked` always calls `runSync`, `RootView.swift:347`). The
  offline guarantee comes from `runSync` failure→persisted-cache fallback, not
  suppressed network. **Converges with T7.**
- **F5 [Minor]** `decidePostSync`'s `hasPersistedCache` is only knowable by doing
  the read that IS the fallback. Feasible with a single read; plan must specify
  the ordering (mirror `LockStateReducer` split).
- **F6 [Info]** `handleVaultUnlocked -> Bool`: passphrase call site ignores the
  return → Swift warning. Use `@discardableResult`.

## Security Findings

**Central verdict: the core design is SAFE on the rollback/replay axis.** Stale
entries are never decoded/displayed on the `cacheRecovered=false` path — the stale
file is only ever discarded and replaced by a fresh server sync at counter N+1.
DPoP/token path is clean (reuses the existing real-signer `MobileAPIClient`, no
NoOp/unsigned path introduced). userId persistence is confidentiality-safe
(already in the cache header + unlock response) and integrity-benign.

- **S2 [Critical, escalate]** `decidePostSync` as specified omits the "sync failed
  BUT `readCacheFile` succeeds" sub-case on the `cacheRecovered=false` path. The
  existing fallback (`RootView.swift:377-384`) inlines `try? readCacheFile` with an
  **independent `expectedCounter`** source (`readDirect()` vs the biometric meta
  read at `VaultUnlocker.swift:250`). Staleness is **AND-gated** (issuedAt>1h AND
  lastRefresh>24h), so a mildly-stale file reads cleanly. A literal implementation
  that reaches the line-377 re-read on the failure path can decrypt entries the
  first read rejected → a caller-layer counter-splice window. **Fix: lock C5 so on
  `cacheRecovered==false` the code NEVER calls `readCacheFile` again and NEVER
  reaches 377-397 — `guard` before the if-let ladder, return `.failLocked`. Add a
  forbidden-pattern + an AC for the mildly-stale case.**
- **S1 [Major]** The "resync neutralizes rollback" guarantee is **host-app-only**.
  The AutoFill extension (`CredentialResolver.swift`) reads the same cache file with
  its own counter check and no resync; a captured consistent (file, meta) rollback
  pair remains servable to AutoFill until the next host sync bumps the counter.
  Pre-existing (plan doesn't worsen it), but the plan's security claim is
  over-broad. **Fix: scope-note it; track AutoFill freshness hardening separately.**
- **S3 [Minor]** Tampered persisted `userId` is self-defeating (server authz is
  DPoP-token-bound, not local-userId-bound; entries are vaultKey-bound AEAD).
  Not exploitable. Add a one-line note to C4.
- **S4 [Info]** `keyVersion=1` floor is security-safe (entry decrypt uses per-entry
  keyVersion from the blob). [Note: F2 shows it is a *functional* write-path bug
  even though it is not a security bug.]

## Testing Findings

- **T1 [Critical]** FR1 "the resync heals" has no end-to-end test. The C1 tests
  prove `unlockWithBiometrics` *returns* `cacheRecovered=false`, but the healing
  (false→runSync→fresh populated vault) lives in the untested `handleVaultUnlocked`.
  `decidePostSync` returns only a decision enum, not a populated `cacheData`. **Fix:
  add a `HostSyncService`-level test (collaborators are injectable) that seeds a
  stale/absent cache, runs `runSync`, and asserts the rewritten cache is readable
  at the new counter with the expected entries.** Converges with S2/T2.
- **T2 [Major]** `decidePostSync(...,hasPersistedCache: Bool)` — the "valid
  persisted cache" is decoupled from the real read; the pure function can return
  `.useLocalCache` while the real read fails, keeping empty-synthesis reachable.
  **Fix: pass `CacheData?` (not `Bool`) into the pure function** so `nil` +
  `cacheRecovered==false` deterministically yields `.failLocked`. Converges with S2.
- **T4 [Major]** No behavioral regression test forbids re-introducing the
  empty-catch (C2) or empty-synthesis (C5). Plan leans on grep forbidden-patterns
  (bypassable). **Fix: extract `biometricUnlockError(from:decision:) -> String?`
  and unit-test it** so INV-C2.1 is behaviorally guarded. (memory
  `ios-swift6-file-vacuous-gate`: any source-grep gate must use `#filePath` +
  non-swallow `try` + prove-red.)
- **T5 [Major]** The bug-fix fails-before test covers the *mechanism* (throw→return,
  AC-C1.1) but not the user *symptom* (silent bounce = RootView swallow + fatal
  routing). **Fix: T4's pure-function test is the symptom regression; state which
  test is fails-before for the reported bug.**
- **T6 [Major]** R19: C4's Equatable sweep missed `WrappedKeyStoreTests.swift:40,60,217`
  (exact `XCTAssertEqual` on `WrappedVaultKey`). Safe because the field is optional
  + JSON-omitted, but the plan's stated justification is wrong. **Fix: correct the
  sweep; add a store-layer round-trip test with a non-nil `userId`.**
- **T7 [Minor]** AC-C1.2 "no data source call" is vacuous (the method never calls
  the source on any branch). INV-C1.3 "no network on fresh" may already be false
  (`runSync` unconditional). **Converges with F4.**
- **T8 [Minor, Adjacent]** C3's `externalError ?? errorMessage` precedence IS
  extractable (one-liner) — remove the "if not extractable" hedge; extract
  `resolveDisplayError(external:internal:)` and test AC-C3.1/AC-C3.2.
- **T3 [Info]** Counter-mismatch test recipe is sound with the existing API
  (`incrementCounter` is public); assert `cacheRecovered==false`, not a throw.

## Adjacent Findings

- **T8-A** (testing → C3 display layer): precedence rule extraction — routed into C3.
- **S1** flags an AutoFill (cross-target) interaction — routed to a scope note +
  a tracked follow-up (not fixed in this PR; pre-existing).

## Quality Warnings

None — all findings carry file:line evidence and concrete fixes.

## Recurring Issue Check

### Functionality expert
R1 clean · R2 finding (F2 keyVersion=1) · R3 finding (F3 sweep) · R4 clean ·
R5 clean · R6 clean · R7 finding (F3 init default) · R8 clean · R9 clean ·
R10 clean · R11 finding (F4) · R12 clean · R13 finding (F1 nil vs empty) ·
R14 finding (F1/F3 backward-compat) · R15 clean · R16 finding (F6) ·
R17 clean · R18 finding (F5 double-read) · R19 finding (F3) · R20 finding (F2) ·
R21 clean · R22 n-a · R23 clean · R24 n-a · R25 finding (F1 implicit migration) ·
R26 clean · R27 clean · R28 clean · R29 clean · R30 clean · R31 n-a · R32 clean ·
R33 clean · R34 clean · R35 n-a · R36 n-a · R37 n-a · R38 clean · R39 clean ·
R40 finding (F1/F4 doc drift) · R41 finding (F6) · R42 clean

### Security expert
R1-R13 pass · R14 warn (S2 fail-open edge) · R15-R21 pass · R22 warn (S1 AutoFill) ·
R23-R42 pass · RS1 pass · RS2 warn (S1/S2 rollback-replay caller/AutoFill) ·
RS3 pass (DPoP unchanged) · RS4 pass (userId non-secret, out of biometric ACL) ·
RS5 pass (AAD/counter binding intact)

### Testing expert
R1-R2 pass · R3 flag (T6) · R4-R18 pass · R19 flag (T6/T7) · R20-R42 pass ·
RT1 flag (T1) · RT2 flag (T4) · RT3 flag (T2/T7) · RT4 flag (T5) · RT5 pass ·
RT6 flag (T2/T8 extract pure fns) · RT7 pass
