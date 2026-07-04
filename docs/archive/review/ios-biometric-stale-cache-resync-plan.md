# Plan: iOS Biometric Unlock — Stale-Cache Resync Fallback

## Objective

Fix the UX defect where, after the app has been idle/backgrounded "a while",
tapping **Unlock with Face ID** authenticates successfully but silently bounces
the user back to the passphrase screen. Make biometric unlock reach the vault
list whenever the biometric key material is present — falling back to a fresh
server sync when the local cache is stale/unreadable, exactly as the passphrase
path already does — and surface an explicit error only when both the local cache
AND the server are unusable.

## Project context

- **Type**: `mixed` — native iOS app (Swift 6 / SwiftUI), part of the passwd-sso monorepo.
- **Test infrastructure**: `unit + integration` for iOS via XCTest
  (`ios/PasswdSSOTests/*`). Rich existing harness for this area:
  `StubVaultAPIClient` (drives real `VaultUnlocker` crypto without network),
  `MockKeychainAccessor` / `MockKeychain`, `TempDirWrappedKeyStore`, injectable
  `now: @Sendable () -> Date`, and `buildCacheFileForBiometricTest`. Build+test
  runnable locally: `xcodegen generate` → `xcodebuild test -scheme PasswdSSOApp
  -destination 'id=<sim udid>'` (Xcode 26.4.1 available in this shell — see
  memory `ios-build-env-available`).
- **Verification environment constraints**:
  - **VC1 — Real Face ID/Touch ID prompt**: `unlockWithBiometrics` calls
    `bridgeKeyStore.readForFill(reason:)` which triggers `LAContext`
    evaluation. Unit tests use `MockKeychainAccessor` (no biometric gate), so the
    *actual* biometric prompt is `blocked-deferred` to manual device testing.
    The crypto/fallback logic AFTER the keychain read IS `verifiable-local`
    (the mock returns the blob, then real crypto + real cache-read + real
    fallback branch run). Anti-Deferral: cost to exercise a real Secure-Enclave
    biometric gate in CI is a physical-device farm (hours+, external infra) —
    out of proportion to the change; the LAContext read is unchanged by this
    plan, only the code path AFTER it is. Classify: keychain-read =
    `blocked-deferred (VC1)`, everything downstream = `verifiable-local`.
  - **VC2 — SwiftUI state transition (`appState` → `.vaultUnlocked`)**: RootView
    view-state transitions are `blocked-deferred` (no ViewInspector/SwiftUI test
    host in this target). The orchestration logic they gate is exercised
    indirectly via the `VaultUnlocker` return contract; the RootView wiring is
    verified by manual device testing + code review. Anti-Deferral: adding a
    SwiftUI view-testing framework is a multi-day infra addition, out of scope
    for a targeted UX fix (cost ≫ 30 min).

## Requirements

### Functional

- FR1: When biometric key material is present (bridge_key + wrapped vault key)
  and the biometric read + wrapped-key decrypt succeed, biometric unlock MUST
  reach the vault list even if the local cache file is stale, counter-mismatched,
  AAD-mismatched, or absent — provided a server sync can rebuild it.
- FR2: When the local cache read fails AND the server sync also fails (offline,
  dead token, server error), biometric unlock MUST surface an explicit,
  localized error directing the user to enter their passphrase — never a silent
  return to the passphrase screen.
- FR3: When the local cache read succeeds (fresh cache), the *`unlockWithBiometrics`
  step itself* performs no network round-trip (it reads keychain + local cache
  only) — unchanged from today. NOTE: the end-to-end unlock flow
  (`handleVaultUnlocked`) already calls `runSync` **unconditionally**
  (`RootView.swift:347`), so "biometric unlock does no network" was never true for
  the whole flow, only for the `unlockWithBiometrics` method. This plan does NOT
  change that: `runSync` stays unconditional; the offline guarantee comes from
  `runSync` failing gracefully and falling back to the persisted cache, not from
  suppressing the network call. (Round-1 F4/T7.)
- FR4: The biometric-unlock button visibility is unchanged in the common case;
  it continues to appear whenever key material is present (`biometricUnlockAvailable()`).
  Rationale: the whole point is that biometric unlock now *works* after idle, so
  hiding the button on staleness (the rejected "hide-the-button" option) is not
  needed and would degrade the exact scenario we are fixing.

### Non-functional

- NFR1 (security): The resync fallback MUST NOT weaken any invariant the
  passphrase path relies on. Specifically the fresh sync in the fallback path
  uses the SAME `HostSyncService.runSync(vaultKey:userId:cacheKey:)` the
  passphrase path uses, with the SAME DPoP-signed `MobileAPIClient` — no new
  network client, no new token path, no relaxation of AAD/counter binding on the
  rewritten cache.
- NFR2 (no plaintext at rest): `vaultKey` continues to live only in memory;
  no new persistence of key material is introduced.
- NFR3 (offline-first): The fresh-cache fast path (FR3) must not regress into an
  always-online path; the network sync is a *fallback*, gated on cache-read
  failure.

## Technical approach

### Root cause (confirmed against code)

`unlockWithBiometrics` (`VaultUnlocker.swift:215-272`) recovers the `vaultKey`
successfully at Step 4 (`VaultUnlocker.swift:235-243`), then at Step 5
(`VaultUnlocker.swift:246-252`) reads the encrypted cache **only to recover
`userId` and `keyVersion`**. `readCacheFile` (`EntryCacheFile.swift:163-282`)
enforces staleness (`:250-252`), counter match (`:238-240`), and AAD
(`:335-368`). After "a while" idle, `cacheIssuedAt < now-1h AND
lastSuccessfulRefreshAt < now-24h` → `.rejection(.headerStale)` is thrown. The
`throw` propagates out of `unlockWithBiometrics`, caught by the **empty catch**
in RootView (`RootView.swift:271-273`), leaving `appState` at `.vaultLocked` with
no error shown.

The asymmetry: the passphrase path (`unlock`, `VaultUnlocker.swift:75-207`) never
reads the cache — it fetches fresh unlock data, derives `vaultKey`, and returns.
Then `handleVaultUnlocked` (`RootView.swift:299-425`) runs `runSync`
(`RootView.swift:347`) which **rebuilds the cache from scratch**
(`HostSyncService.performSync`, `HostSyncService.swift:61-151`). So the cache the
biometric path chokes on is one the very next step would have overwritten.

### Design: graceful cache-read degradation + explicit failure

The fix has two coordinated parts.

**Part A — `VaultUnlocker.unlockWithBiometrics` stops treating a cache-read
failure as fatal.** It splits the outcome into:
- vault-key recovery (Steps 1–4): still fatal on failure (biometric/keychain/
  wrapped-key errors are genuine "cannot unlock biometrically").
- metadata recovery (Step 5–6, cache read): now *best-effort*. On cache-read
  failure it returns a result flagged `cacheRecovered = false` with `userId`
  recovered from a **non-staleness-gated source** (the wrapped-key /
  bridge-meta layer — see Consumer-flow walkthrough C1 for exactly where
  `userId` comes from) and `keyVersion` defaulted to the safe floor (`1`, same
  default the current code already uses at `VaultUnlocker.swift:261` when no
  personal entry is present). The subsequent server sync supplies the
  authoritative entry set + keyVersion.

**Part B — RootView's biometric closure stops swallowing errors and drives the
fallback deterministically.** `handleVaultUnlocked` already runs `runSync` and
already falls back to the persisted cache when sync fails
(`RootView.swift:345-397`). The change:
1. Replace the empty `catch` (`RootView.swift:271-273`) with an explicit handler
   that sets a user-visible error on the unlock screen (FR2) instead of silently
   returning.
2. When `unlockWithBiometrics` returns `cacheRecovered = false`,
   `handleVaultUnlocked` MUST treat a *sync failure* as a hard failure for this
   unlock attempt (there is no valid local cache to fall back to), route back to
   `.vaultLocked`, and propagate an explicit error — rather than proceeding to
   `.vaultUnlocked` with an empty vault (the `else` branch at
   `RootView.swift:385-397` that synthesizes an empty `CacheData`). When
   `cacheRecovered = true`, the existing persisted-cache fallback remains valid.

### Where `userId` comes from without a valid cache (critical design point)

`runSync` requires `userId`. Today the biometric path sources it from the cache
header. If the cache is unreadable we need another in-hand source. Options
evaluated against the code:

- The `WrappedVaultKey` (`WrappedKeyStore.loadVaultKey()`) does **not** carry
  `userId` today (see its fields at `EntryCacheFile`/`WrappedKeyStore`; it is
  `ciphertext/iv/authTag/issuedAt`).
- The ECDH wrapped blob IS bound to `userId` via AAD but recovering it requires
  the userId as *input* (AAD), so it cannot *produce* userId.
- **Chosen source**: persist `userId` alongside the wrapped vault key at unlock
  time (in `unlock`, Step 6, `VaultUnlocker.swift:168-174`), so the biometric
  path can read it back without the cache. This is metadata, not secret key
  material (userId already travels in the cache header in plaintext-after-decrypt
  and in the unlock response). Contract **C4** covers this store addition.
  - If, at review, adding a field to the persisted wrapped-key record is judged
    too invasive, the fallback source is a fresh `GET /api/vault/unlock/data`
    **metadata-only** read is NOT viable in the biometric path (no passphrase to
    derive the wrapping key) — but `userId` is returned by that endpoint
    unconditionally and does not require the passphrase to READ. This is the
    documented alternative in C4's rationale; C1 walkthrough picks the primary.

## Contracts

### C1 — `unlockWithBiometrics` graceful degradation

- **Signature** (unchanged public shape; behavior change):
  `public func unlockWithBiometrics(reason: String) async throws -> UnlockResult`
- **New field on `UnlockResult`**:
  `public let cacheRecovered: Bool` — `true` when Step 5 read a valid local
  cache (fresh-cache fast path), `false` when the cache was stale/unreadable and
  the caller MUST rely on a server sync to populate the vault. The passphrase
  path (`unlock`) sets **`cacheRecovered = true`** (LOCKED). Semantics: the field
  means "the caller MAY rely on a persisted local cache if the sync fails."
  - Biometric path: `true` only when Step 5 read a valid cache; `false` when the
    cache was stale/unreadable (there is no trustworthy local cache to fall back
    to).
  - Passphrase path: always `true` — it does not read a cache during unlock, but
    a valid persisted cache from a prior session MAY exist, and its existing
    offline fallback (`RootView.swift:377-384`) must be preserved unchanged
    (INV-C5.2). Setting `false` here would newly route a passphrase unlock with a
    failed sync to `.vaultLocked`, a regression.
  This decouples the two paths: `cacheRecovered` is consumed by
  `handleVaultUnlocked` ONLY to decide whether a *sync failure* may fall back to
  the persisted cache.
- **Behavior**:
  1. Steps 1–4 unchanged (biometric read → cacheKey → load wrapped key →
     decrypt vaultKey). Failures here still `throw` the existing errors
     (`.biometricFailed`, `.biometricUnavailable`, crypto errors).
  2. Step 5 (cache read) wrapped in `do/catch`. On success: `cacheRecovered =
     true`, `userId`/`keyVersion` from cache as today. On
     `EntryCacheError` (any kind): `cacheRecovered = false`, `userId` from the
     persisted wrapped-key userId (C4), `keyVersion = 1` (placeholder — the
     authoritative keyVersion is re-derived post-sync by C5, see F2 fix).
  3. The empty-userId guard (`VaultUnlocker.swift:254-257`) still applies to the
     success branch. In the failure branch, if the persisted userId is ALSO
     empty/absent (`nil` for a legacy vault, or `""`), throw `.cacheUnreadable`
     (there is genuinely no way to sync). See the **legacy-vault bootstrap
     scenario** below (F1) — this is the one-time transitional case.

- **Legacy-vault bootstrap (F1 — Round 1 Critical)**: a vault set up BEFORE this
  ships has `wrapped-vault-key.json` with no `userId` (decodes to `nil` — C4). On
  the FIRST post-upgrade biometric unlock **with a stale cache**, C1 step 3 finds
  `userId=nil` → throws `.cacheUnreadable` → C2 surfaces the FR2 error → the user
  does ONE passphrase unlock, which re-persists `userId` (C4 producer) → all
  subsequent biometric unlocks heal via resync. This is an accepted one-time
  transition, NOT a silent regression (the user gets an explicit error, never a
  silent bounce). The offline+legacy+stale combination is an unavoidable hard-fail
  (no cache, no network, no persisted userId) — also surfaced explicitly, not
  silently. Covered by AC-C1.4 + Scenario 6.
- **Invariants**:
  - INV-C1.1 (app-enforced): `vaultKey` is only returned when Steps 1–4 fully
    succeed. A cache-read failure never causes a wrong/empty vaultKey to be
    returned. *Absence surfaces as: biometric unlock returns a bad key → all
    decrypt fails.*
  - INV-C1.2 (app-enforced): `cacheRecovered == false` ⇒ `userId` is non-empty
    (guaranteed by the throw in step 3 above). *Absence surfaces as: runSync
    writes a cache header with empty userId → AAD drift → next unlock rejects.*
  - INV-C1.3 (app-enforced, SCOPED to `unlockWithBiometrics`): the
    `unlockWithBiometrics` METHOD introduces no network call on the fresh-cache
    path — it reads keychain + local cache only, byte-for-byte as today. This
    invariant is about the METHOD, not the end-to-end flow: `handleVaultUnlocked`
    still calls `runSync` unconditionally (see FR3 note). *Absence surfaces as:
    `unlockWithBiometrics` gains a network dependency, breaking its offline-read
    contract.* (Round-1 F4/T7 scope correction.)
- **Forbidden patterns**:
  - pattern: `catch {` immediately followed by only a comment inside
    `biometricUnlock` closure in RootView — reason: the empty-swallow catch is
    the bug; the closure must set an error or route explicitly.
  - pattern: `try? readCacheFile` inside `unlockWithBiometrics` — reason: the
    read must distinguish success from failure to set `cacheRecovered`; a `try?`
    would collapse the signal.
- **Acceptance criteria**:
  - AC-C1.1: With a seeded STALE cache (now injected 25h ahead) + valid
    bridge_key + wrapped key, `unlockWithBiometrics` returns a result with the
    correct `vaultKey` and `cacheRecovered == false` (does NOT throw).
  - AC-C1.2: With a seeded FRESH cache, returns `cacheRecovered == true`,
    `userId`/`keyVersion` from cache, no data source call (StubVaultAPIClient in
    `.wrongPassphrase`/counting mode is never hit).
  - AC-C1.3: With stale cache AND persisted userId absent (`nil`, legacy) or
    empty → throws `.cacheUnreadable`.
  - AC-C1.4 (F1 legacy bootstrap): seed a `WrappedVaultKey` WITHOUT `userId`
    (`userId=nil`, simulating a pre-upgrade file) + a stale cache →
    `unlockWithBiometrics` throws `.cacheUnreadable` (does not crash, does not
    return a result with empty userId). Then persist a `userId` (simulating a
    passphrase unlock) + keep the stale cache → biometric unlock now returns
    `cacheRecovered=false` with the recovered userId (proves the transition heals).

- **Consumer-flow walkthrough** (UnlockResult is a shape consumed outside the producer):
  - **Consumer: `RootView.handleVaultUnlocked`** (path:
    `ios/PasswdSSOApp/Views/RootView.swift:299-425`) reads `{ vaultKey, userId,
    keyVersion, tenantAutoLockMinutes, cacheKey, cacheRecovered }` and uses:
    `vaultKey`+`userId`+`cacheKey` to call `runSync` (`:347`); `userId` for the
    empty-cache-synthesis header (`:393`); `keyVersion` to populate
    `.vaultUnlocked` (`:419`); `tenantAutoLockMinutes` for `applyTenantPolicy`
    (`:317`); `cacheKey` for QuickType identity refresh (`:411`) and
    `onVaultReady` (`:404`); **`cacheRecovered` (new)** to decide whether a
    `runSync` failure is fatal (cacheRecovered==false → fatal, route to
    `.vaultLocked` with error) or recoverable-from-local-cache (cacheRecovered==
    true → existing persisted-cache fallback at `:377-384`).
    - Required fields present in locked shape: yes — all six. `cacheRecovered`
      is the only addition; every consumer op above is satisfiable.
  - **Consumer: `VaultUnlockView.attemptUnlock`** (path:
    `ios/PasswdSSOApp/Views/Vault/VaultUnlockView.swift:126-146`) reads the
    passphrase-path `UnlockResult` and passes it to `onUnlocked`. It does not
    read `cacheRecovered`. No change needed; the added field is ignored here.
  - **Consumer: `VaultUnlockerTests`** (path:
    `ios/PasswdSSOTests/VaultUnlockerTests.swift`) constructs `UnlockResult`
    only via the producer (never by literal), so an added field with a producer
    default does not break existing exact-shape assertions — confirm no
    `UnlockResult(` literal exists in tests (grep in C1 acceptance).

### C2 — RootView biometric closure: explicit error, no silent swallow

- **Signature** (closure shape unchanged):
  `biometricUnlock: (@MainActor @Sendable () async -> Void)?`
- **Behavior**: the closure body (`RootView.swift:257-274`) replaces the empty
  `catch` with:
  - on `VaultUnlockError.biometricFailed`: **no error banner**, remain on the
    passphrase screen. **Code-derived constraint**: `readForFill` collapses BOTH
    `errSecUserCanceled` AND `errSecAuthFailed` into a single `Error.biometryFailed`
    (`BridgeKeyStore.swift:229-231`), which `unlockWithBiometrics` maps to
    `.biometricFailed` (`VaultUnlocker.swift:220-221`). Therefore the closure
    CANNOT distinguish an intentional user cancel from a biometric mismatch — both
    are `.biometricFailed`. Treating the whole class as "no banner, stay on
    passphrase screen" is the correct conservative choice: a mismatch already
    leaves the passphrase field available, and showing a scary error on a simple
    cancel would be worse UX. (If finer distinction is ever needed, that requires
    threading the OSStatus/`LAError.Code` out of `BridgeKeyStore` — SC5, out of
    scope here.)
  - on any other thrown error, AND on the `handleVaultUnlocked` returning
    `false` for the `cacheRecovered == false` sync-failure case (C5): set an
    explicit localized error message on the unlock screen (FR2). This is the
    branch that fixes the silent bounce — the failure is a *sync/network* failure
    after a *successful* biometric auth, which is exactly when the user needs to
    be told "your session data is stale, please enter your passphrase."
- **Design note**: the error must reach `VaultUnlockView`. Today
  `VaultUnlockView` owns `errorMessage` and sets it only from its own
  `attemptUnlock`. The biometric closure is created in RootView and cannot set
  the View's `@State`. Contract **C3** adds the plumbing.
- **Pure error-mapping extraction (T4/T5 — Round 1)**: the closure's
  error→message decision MUST be extracted into a pure, testable free function so
  INV-C2.1 is guarded *behaviorally*, not only by a forbidden-pattern grep
  (grep is bypassable by rewording the comment):
  `func biometricUnlockError(from error: Error?, syncFailedCacheless: Bool) -> String?`
  returning `nil` for `VaultUnlockError.biometricFailed` (cancel/mismatch — no
  banner) and a localized message for every other error AND for the
  `syncFailedCacheless == true` case (C5 `.failLocked`). The closure calls this
  and pushes the result into `biometricErrorText` (C3). This is the *symptom*
  regression test surface (T5): a test feeding a non-cancel error asserts a
  non-nil message, which would fail if someone re-introduced the swallow.
- **Invariants**:
  - INV-C2.1 (app-enforced): no code path in the biometric closure leaves the
    user on the passphrase screen with NO feedback after a *non-cancel* failure.
    *Absence surfaces as: the exact bug we are fixing — silent bounce.*
- **Forbidden patterns**:
  - pattern: `// Biometric cancel/fail → silent fallback to passphrase`
    — reason: this exact comment marks the swallow being removed; its presence
    in the final diff means the fix was not applied.
- **Acceptance criteria**:
  - AC-C2.1 (logic, T4/T5): `biometricUnlockError(from: .biometricFailed,
    syncFailedCacheless: false)` returns `nil` (no banner on cancel/mismatch);
    `biometricUnlockError(from: someOtherError, ...)` and
    `biometricUnlockError(from: nil, syncFailedCacheless: true)` each return a
    non-nil localized message. This is the fails-before/passes-after regression
    test for the reported silent-bounce symptom.
  - AC-C2.2 (manual, VC2): stale-cache + offline → tap Face ID → biometric
    succeeds → the message from AC-C2.1 is shown in the red-caption region,
    passphrase field focusable.

### C3 — Error surfacing from biometric closure into `VaultUnlockView`

- **Signature (LOCKED)**: add one parameter to `VaultUnlockView`:
  `let externalError: String?` (default `nil` in the memberwise `init`, so the
  passphrase-only call sites need no change). RootView owns
  `@State private var biometricErrorText: String?`, the biometric closure sets
  it, and RootView passes `externalError: biometricErrorText` into the
  `.vaultLocked`/`.signedIn` `VaultUnlockView`. Rejected `@Binding` (forces the
  parent to hold a `Binding` and complicates the existing two `vaultLockedScreen`
  call sites) and a callback shape (the View must *render* the error in its own
  red-caption region, not just receive it).
- **Behavior**: `VaultUnlockView` shows the result of a pure free function
  `func resolveDisplayError(external: String?, internalError: String?) -> String?`
  = `external ?? internalError` (T8 — extracted, NOT inlined, so precedence is
  unit-tested without a SwiftUI host; the "if not extractable" hedge is removed —
  it IS extractable, it is a one-liner). A new successful passphrase attempt
  clears both.
- **Invariants**:
  - INV-C3.1 (app-enforced): setting `externalError` non-nil renders it in the
    existing red caption region (`VaultUnlockView.swift:80-84`); no second error
    UI is introduced (R8 — UI consistency).
- **Acceptance criteria**:
  - AC-C3.1 (logic, T8): `resolveDisplayError(external:"x", internalError:nil) ==
    "x"`; `resolveDisplayError(external:"x", internalError:"y") == "x"` (external
    wins); `resolveDisplayError(external:nil, internalError:"y") == "y"`.
  - AC-C3.2: a subsequent successful unlock clears `externalError` (parent
    resets its `@State` before `handleVaultUnlocked` swaps `appState`).

### C4 — Persist `userId` with the wrapped vault key (source for cacheless sync)

- **Signature (LOCKED)**: add an **optional** field
  `public let userId: String?` to `WrappedVaultKey`
  (`WrappedKeyStore.swift:5-17`), AND add it to the memberwise `init` with a
  **default**: `init(ciphertext:, iv:, authTag:, issuedAt:, userId: String? = nil)`
  (F3 — Round 1). The default is load-bearing: without it, all 15 existing
  constructors break. `WrappedVaultKey` is a `Codable` struct serialized as JSON
  in the App Group file `wrapped-vault-key.json` (`WrappedKeyStore.swift:84-94`).
  An **optional** field is decode-backward-compatible: pre-existing files
  (written without `userId`) decode with `userId = nil` (JSONDecoder tolerates a
  missing optional key). The default `JSONEncoder` omits `nil` optionals (does NOT
  emit `"userId":null`), so round-trip equality of legacy instances holds
  (verified requirement for T6 below).
- **Construction-site sweep (R3 propagation — code-derived, CORRECTED per F3/T6)**:
  `grep -rn 'WrappedVaultKey(' ios --include='*.swift'` → **15 constructors**:
  - **2 production** (must pass the new field explicitly):
    - `VaultUnlocker.swift:168` (the `unlock` path — passes `userId: unlockData.userId`).
    - `DebugVaultLoader.swift:98` (DEBUG-only seeding — passes its known test
      userId; DEBUG target, must compile).
  - **13 test constructors** (unchanged thanks to the `= nil` default; each uses
    only the first 4 params): `AutoLockServiceTests.swift:122,166,242,294`,
    `CredentialResolverTests.swift:218`, `VaultUnlockerTests.swift:120`,
    `WrappedKeyStoreTests.swift:30,44,50,136,164,192,223`.
- **Equatable sweep (CORRECTED per T6)**: `WrappedVaultKey` is `Equatable` and IS
  compared in tests: `WrappedKeyStoreTests.swift:40,60,217`
  (`XCTAssertEqual(loaded, expected)` on `WrappedVaultKey`). These stay green
  because both sides get `userId = nil` (neither passes it) and the encoder omits
  nil. (The Round-0 sweep wrongly claimed "no production code compares two
  instances" as the safety basis — the real basis is optional + nil-omitted, NOT
  the absence of equality assertions.) Consumers of `loadVaultKey()` verified
  read-only on `ciphertext/iv/authTag` (no struct equality):
  `CredentialResolver.swift:151,282,378,493,585` (AutoFill extension).
- **Tampered-userId note (S3 — Round 1)**: the persisted userId lives in the
  attacker-writable App Group file. A flipped value is **self-defeating, not
  exploitable**: server authz is DPoP-token-bound (not local-userId-bound) so no
  cross-user disclosure; entries are vaultKey-bound AEAD so no forgery; and the
  next passphrase unlock overwrites it with the real `unlockData.userId`. Worst
  case is a self-healing AAD-drift resync. No code change required beyond keeping
  it out of the biometric ACL (INV-C4.3).
- **Invariants**:
  - INV-C4.1 (app-enforced): the persisted userId written at `unlock` equals
    `unlockData.userId`. *Absence surfaces as: cacheless sync uses wrong userId →
    AAD drift.*
  - INV-C4.2 (app-enforced): reading back the persisted userId in
    `unlockWithBiometrics` yields the same string. *Round-trip.*
  - INV-C4.3 (security, app-enforced): the persisted userId is NOT secret and its
    storage MUST NOT reduce the protection class of the wrapped key material
    (store it at the same or *weaker*-sensitivity item, never move the wrapped
    key to a weaker item to accommodate it).
- **Forbidden patterns**:
  - pattern: writing `userId` into the biometric-gated `bridge-key-v2` ACL item
    — reason: userId is non-secret; gating it behind biometrics is pointless and
    risks a biometric prompt on a metadata read. Store with the wrapped key
    (App Group file) or the no-ACL meta.
- **Acceptance criteria**:
  - AC-C4.1: after `unlock(passphrase:)`, the persisted userId round-trips to
    `unlockData.userId`.
  - AC-C4.2: `unlockWithBiometrics` on a stale cache recovers that userId and
    returns it in `UnlockResult.userId`.
  - AC-C4.3 (T6 store-layer round-trip): save a `WrappedVaultKey` with a NON-nil
    `userId`, load it, assert `loaded == saved` AND `loaded.userId == "…"` —
    proves the new field survives JSON encode/decode at the store layer (not only
    via `unlockWithBiometrics`).

### C5 — `handleVaultUnlocked` fatal-vs-recoverable sync failure

- **Signature (LOCKED)**: change return type to
  `@discardableResult private func handleVaultUnlocked(...) async -> Bool`
  (true = reached `.vaultUnlocked`). `@discardableResult` (F6) lets the
  passphrase call site (`RootView.swift:285-296`) ignore it warning-free; the
  biometric call site inspects it to set `biometricErrorText` (C2/C3).
- **Pure decision function (LOCKED per S2/T2 — takes `CacheData?`, NOT `Bool`)**:
  ```
  enum PostSyncOutcome: Equatable { case useFreshCache, useLocalCache, failLocked }
  func decidePostSync(
    syncReport: SyncReport?,          // nil = sync failed
    cacheRecovered: Bool,
    persistedCache: CacheData?        // the already-read persisted cache, or nil
  ) -> PostSyncOutcome
  ```
  Logic (pure, total):
  - `syncReport != nil` → `.useFreshCache`.
  - `syncReport == nil && cacheRecovered == false` → `.failLocked`
    **regardless of `persistedCache`** — this is the S2 fix: a cacheless failed
    sync NEVER trusts a persisted cache, even if a (possibly rolled-back /
    mildly-stale-but-readable) one exists.
  - `syncReport == nil && cacheRecovered == true && persistedCache != nil` →
    `.useLocalCache`.
  - `syncReport == nil && cacheRecovered == true && persistedCache == nil` →
    `.failLocked`.
- **Behavior / structural ordering (LOCKED per S2)**: after the `runSync`
  do/catch, RootView MUST:
  1. On `cacheRecovered == false`, **NOT** call `readCacheFile` again at all. The
     persisted-cache read (`RootView.swift:377-384`) is gated behind
     `cacheRecovered == true`. This closes the S2 counter-splice window (two reads
     with independent `expectedCounter` sources) structurally.
  2. Read the persisted cache **once** (only when `cacheRecovered == true`), bind
     its `CacheData?` result (F5 — single read), pass it to `decidePostSync`, then
     `switch`:
     - `.useFreshCache` → use `syncReport!.cacheData`; **derive the authoritative
       keyVersion from those synced entries** (`max(1, entries.first { $0.teamId
       == nil }?.keyVersion ?? 1)`, same logic as `VaultUnlocker.swift:261`) and
       use THAT for `.vaultUnlocked(keyVersion:)` — NOT `unlockResult.keyVersion`
       (F2 fix: prevents a stale keyVersion=1 being written back to the server on
       a later edit).
     - `.useLocalCache` → use the already-read `persistedCache` data.
     - `.failLocked` → `appState = .vaultLocked(serverConfig:apiClient:)`,
       return `false`. Do NOT synthesize an empty `CacheData`.
- **Invariants**:
  - INV-C5.1 (app-enforced): `cacheRecovered == false` AND sync-failed ⇒
    `appState` becomes `.vaultLocked`, NOT `.vaultUnlocked` with empty entries,
    AND no `readCacheFile` is called on this path. *Absence surfaces as: user
    lands on an empty vault after Face ID (data-loss-looking), OR a caller-layer
    counter-splice re-opens (S2).*
  - INV-C5.2 (app-enforced): the passphrase path's existing offline behavior
    (`cacheRecovered == true`, unlock succeeds, falls back to persisted cache) is
    unchanged. *Regression guard.*
  - INV-C5.3 (app-enforced, F2): when `syncReport != nil`, the keyVersion handed
    to `.vaultUnlocked` is derived from the SYNCED entries, not the possibly-stale
    `unlockResult.keyVersion`. *Absence surfaces as: keyVersion=1 written back to
    the server on a create/edit in a resync-healed session.*
- **Forbidden patterns**:
  - pattern: `readCacheFile` reachable when `cacheRecovered == false` — reason:
    the S2 counter-splice window + the empty-synthesis fall-through both live past
    that read; the failure path must never re-read.
  - pattern: synthesizing `CacheData(header: CacheHeader(... entryCount: 0 ...)`
    reachable when `cacheRecovered == false` — reason: empty-vault-as-success on a
    cacheless failed sync (INV-C5.1).
  - pattern: `keyVersion: unlockResult.keyVersion` at the `.vaultUnlocked(...)`
    construction when a `syncReport` is present — reason: must use the synced
    keyVersion (INV-C5.3 / F2).
- **Acceptance criteria** (all logic-level via `decidePostSync`, VC2-free):
  - AC-C5.1: `decidePostSync(syncReport: nil, cacheRecovered: false,
    persistedCache: <non-nil>)` → `.failLocked` (S2 — a readable persisted cache
    does NOT rescue a cacheless failed sync).
  - AC-C5.2: `decidePostSync(nil, false, nil)` → `.failLocked`.
  - AC-C5.3: `decidePostSync(nil, true, <non-nil>)` → `.useLocalCache`.
  - AC-C5.4 (REVISED — Phase 3 F1): `decidePostSync(nil, true, nil)` →
    `.useEmptyCache` (NOT `.failLocked`). A valid unlock (passphrase always sets
    `cacheRecovered=true`) with no persisted cache is a brand-new / first-offline
    vault — a legitimate empty-vault success state, not a fail-closed condition.
    Fail-closed (`.failLocked`) is reserved for the `cacheRecovered==false`
    (biometric stale/rolled-back) case. The Round-0 plan had this wrong; the
    empty-vault synthesis the old code did for the passphrase path was correct and
    must be preserved (INV-C5.2). A distinct `.useEmptyCache` outcome carries this.
  - AC-C5.5: `decidePostSync(<non-nil>, _, _)` → `.useFreshCache`.
  - AC-C5.6 (F2, mildly-stale realism): the S2 sharp case — a cache that is
    >1h old but refreshed <24h ago (so `readCacheFile` would NOT throw staleness)
    but was rejected by the biometric read for a DIFFERENT reason (counter
    mismatch) → `cacheRecovered=false` → even though such a file is
    independently readable, `decidePostSync(nil, false, <that readable cache>)`
    still returns `.failLocked`.

## Testing strategy

Because RootView's SwiftUI transitions are VC2-blocked, ALL load-bearing logic is
extracted into **pure, testable free functions** (mirroring the `LockStateReducer`
split `AutoLockService` already uses): `decidePostSync` (C5), `biometricUnlockError`
(C2), `resolveDisplayError` (C3). RootView becomes a thin wrapper that reads the
cache once and switches on the pure results. This is the Round-1 convergent fix —
the bug's real logic must not live only in the untested VC2 layer.

- **C1**: extend `VaultUnlockerTests` — new tests for stale-cache (inject `now`
  25h ahead of the seeded cache) returning `cacheRecovered=false` without throw
  (AC-C1.1); fresh-cache returning `cacheRecovered=true` (AC-C1.2); stale+absent
  persisted-userId throwing `.cacheUnreadable` (AC-C1.3); legacy-vault bootstrap
  transition (AC-C1.4). Reuse `buildCacheFileForBiometricTest`,
  `MockKeychainAccessor`, `TempDirWrappedKeyStore`, injectable `now`.
- **T1 (FR1 end-to-end healing — Round 1 Critical)**: a `HostSyncService`-level
  test that closes the gap `decidePostSync` structurally cannot. All of
  `HostSyncService`'s collaborators (`EntryFetcher`/`apiClient`, `bridgeKeyStore`,
  `wrappedKeyStore`, `cacheURL`) are injectable. Seed a stale/absent cache + a stub
  entry source returning N known entries, call `runSync(vaultKey:userId:cacheKey:)`,
  then assert the rewritten cache file is readable at the NEW counter with those N
  entries and a fresh `cacheIssuedAt`. This proves "false→runSync→populated vault"
  actually heals — the headline FR1 requirement.
- **C4**: `AC-C4.1/4.2` (unlock persists userId; biometric-on-stale recovers it)
  in `VaultUnlockerTests`, PLUS `AC-C4.3` store-layer round-trip
  (`WrappedKeyStoreTests`: save with non-nil userId, load, assert equality +
  `userId`).
- **C5**: pure-function tests for `decidePostSync` — AC-C5.1..C5.6 (six cases,
  including the S2 "readable persisted cache does NOT rescue a cacheless failed
  sync" and the F2 mildly-stale realism case).
- **C2**: pure-function tests for `biometricUnlockError` — AC-C2.1 (nil on
  `.biometricFailed`; non-nil on other errors and on `syncFailedCacheless`). This
  is the SYMPTOM regression test (T4/T5) — fails-before if the swallow is
  re-introduced.
- **C3**: pure-function tests for `resolveDisplayError` — AC-C3.1 precedence +
  AC-C3.2 clear-on-success. No SwiftUI host needed (T8 — hedge removed).
- **Counter-mismatch branch**: C1 test — seed cache at counter N, call
  `bks.incrementCounter(newCounter: N+1)` (public API, `BridgeKeyStore.swift:275`),
  then `unlockWithBiometrics` → `readCacheFile` throws `.counterMismatch` → assert
  the result is `cacheRecovered=false` (NOT a throw) (T3). Proves FR1 covers all
  `EntryCacheError` kinds, not just staleness.
- **Forbidden-pattern grep guards** are DEFENSE-IN-DEPTH ONLY, not the primary
  guard (T4). If a source-grep gate is added, it MUST use `#filePath` + a
  non-swallow `try` and be prove-red'd (memory `ios-swift6-file-vacuous-gate` —
  a `#file` + `try?` gate silently passes with zero assertions).
- Full suite: `xcodebuild test -scheme PasswdSSOApp` must stay green (all ~526
  existing tests + new).

## Considerations & constraints

### Security analysis (NFR1 — the reviewer's explicit concern)

The fallback path does **not** open a new authz/DPoP/token hole because:
- It reuses `handleVaultUnlocked`'s existing `runSync` with the SAME
  `MobileAPIClient` (DPoP-signed via the SE key from the coordinator,
  `RootView.buildRealAPIClient:453-476`). No new client, no `NoOpDPoPSigner`
  path, no token minting.
- The `vaultKey` used to (re)encrypt the rebuilt cache is the one recovered from
  the biometric-gated bridge_key — identical trust to today's fresh-cache
  biometric unlock. The sync does not lower the bar for *obtaining* the vaultKey;
  it only changes what happens with an already-recovered vaultKey when the local
  cache is stale.
- `userId` persistence (C4) stores a **non-secret** identifier. It must not be
  placed behind the biometric ACL (forbidden pattern in C4) and must not weaken
  the wrapped-key item's protection class (INV-C4.3).
- Staleness exists as a **rollback/replay** defense on the *cache file*, not on
  the vault key. Bypassing it for the biometric path is safe **because** we then
  immediately fetch authoritative data from the server and rewrite the cache
  with a fresh counter — i.e. we replace the possibly-rolled-back cache rather
  than trusting it. On the `cacheRecovered == false` path the stale entries are
  **never decoded or displayed** — the stale file is only ever discarded and
  replaced (Round-1 security verdict, axes a/b: SAFE). The one case where we can't
  reach the server, we now FAIL CLOSED to `.vaultLocked` (INV-C5.1) instead of
  trusting stale entries — and C5's structural guard (no `readCacheFile` on the
  `cacheRecovered==false` path) closes the S2 counter-splice window. This is
  strictly stronger than today's silent bounce (which also failed closed, just
  without feedback) and never weaker.
- **Scope of the rollback guarantee (S1 — host-app only)**: the "resync
  neutralizes rollback" property applies to the **host-app** read path. The
  AutoFill extension (`CredentialResolver`) reads the same cache file with its own
  counter-consistency check but has NO resync — a captured consistent (file, meta)
  rollback pair remains servable to AutoFill until the next host sync bumps the
  counter. This is **pre-existing** (AutoFill always trusted a counter-consistent
  file; this plan does not change AutoFill) and is tracked as SC6, not fixed here.
  The plan does not claim to close it.

### Scope contract

- **SC1**: The 1h/24h staleness thresholds in `EntryCacheFile.swift:250-252`
  are NOT changed. This plan changes how the *caller* reacts to a staleness
  rejection, not the rejection policy itself. Owner: any future cache-policy
  tuning PR.
- **SC2**: The passphrase-path offline behavior is NOT redesigned. It keeps its
  current persisted-cache fallback. Owner: N/A (deliberately unchanged).
- **SC3**: Team-key resync semantics inside `runSync` are unchanged; this plan
  does not touch `refreshTeamKeys`. Owner: N/A.
- **SC4**: Real biometric-prompt E2E (VC1) is manual device testing, not
  automated here.
- **SC5**: Distinguishing an intentional Face ID *cancel* from a biometric
  *mismatch* is NOT added. Both surface as `.biometricFailed` today
  (`BridgeKeyStore.swift:229-231`); teaching `BridgeKeyStore` to thread the
  `LAError.Code`/OSStatus out is a separate refinement. Owner: future biometric-UX
  PR. This plan's C2 handles the whole `.biometricFailed` class as "no banner,
  stay on passphrase screen," which is correct regardless of the sub-cause.
- **SC6** (S1 — Round 1): AutoFill-extension freshness hardening against a
  captured consistent (file, meta) rollback pair is NOT addressed here. The
  AutoFill path (`CredentialResolver`) has an independent counter-consistency
  check but no resync, so it can serve a rolled-back-but-consistent cache until
  the next host sync. This is pre-existing and out of scope. Owner: future
  AutoFill-freshness PR (candidate mitigations: a monotonic floor on the meta
  counter, or a server-side freshness nonce for AutoFill). `TODO(ios-biometric-stale-cache-resync): AutoFill rollback-freshness (SC6)`.

### User operation scenarios

1. **Idle 2h then reopen (the reported bug)**: cold-or-warm launch →
   `.vaultLocked`/`.signedIn` → auto-prompt Face ID → biometric succeeds →
   cache stale → `cacheRecovered=false` → `runSync` succeeds → fresh cache →
   `.vaultUnlocked` list shown. **Fixed.**
2. **Idle 2h then reopen, but offline**: same until sync → sync fails →
   `cacheRecovered=false` → `.vaultLocked` + explicit "enter passphrase" error.
   User types passphrase → `unlock` fetches fresh data → list. **Graceful.**
3. **Locked 5 min, still online (fresh cache)**: Face ID → cache fresh →
   `cacheRecovered=true` → offline-fast unlock, no network. **Unchanged/fast.**
4. **AutoFill extension bumped the counter between app foregrounds**: cache
   counter mismatches bridge-meta → `readCacheFile` throws `.counterMismatch` →
   `cacheRecovered=false` → resync heals. **Fixed (bonus).**
5. **User cancels the Face ID sheet**: `readForFill` throws biometric-cancel →
   `.biometricFailed` → C2 treats intentional cancel as no-banner, stays on
   passphrase screen. **No spurious error.**
6. **Legacy vault, first post-upgrade unlock, stale cache (F1)**: `wrapped-vault-key.json`
   has `userId=nil` → `unlockWithBiometrics` on a stale cache throws
   `.cacheUnreadable` → C2 shows explicit "enter passphrase" error → user does one
   passphrase unlock → `userId` re-persisted → every later biometric unlock heals
   via resync. **One-time transition, explicit (never silent).** Offline+legacy+stale
   is an unavoidable hard-fail, also explicit.

## Implementation Checklist (Step 2-1)

**Confirmed error copy (user-approved)**:
- en (key): `Your session is out of date. Enter your passphrase to unlock.`
- ja: `セッション情報が古くなっています。パスフレーズを入力して解錠してください。`
- Location: `ios/PasswdSSOApp/Localizable.xcstrings` (hand-authored `en`+`ja`
  `stringUnit`, `extractionState: "stale"` — matches the 2 existing unlock keys;
  xcodebuild does not write extraction back, per memory `ios-string-catalog-notes`).

**Files to modify**:
1. `ios/Shared/Storage/WrappedKeyStore.swift` — C4: add `userId: String?` to
   `WrappedVaultKey` + memberwise `init(..., userId: String? = nil)`.
2. `ios/PasswdSSOApp/Vault/VaultUnlocker.swift` — C1: add `cacheRecovered: Bool`
   to `UnlockResult`; `unlock` passes `userId:` to `WrappedVaultKey` (C4 producer)
   + sets `cacheRecovered: true`; `unlockWithBiometrics` wraps Step 5 in do/catch,
   sets `cacheRecovered` + legacy-userId fallback + `.cacheUnreadable` throw.
   (2 `UnlockResult(` producers at :200,:265; both get the new field.)
3. `ios/PasswdSSOApp/Debug/DebugVaultLoader.swift:98` — C4 producer: pass `userId:`.
4. `ios/PasswdSSOApp/Views/RootView.swift` — C2/C3/C5: `@discardableResult ... -> Bool`;
   `decidePostSync` call + structural guard (no re-read on cacheRecovered==false);
   synced-keyVersion derivation; biometric closure sets `biometricErrorText` via
   `biometricUnlockError`; pass `externalError:` into `VaultUnlockView`.
5. `ios/PasswdSSOApp/Views/Vault/VaultUnlockView.swift` — C3: add `externalError: String?`
   param (default nil); display via `resolveDisplayError`.
6. New pure functions (app target, `@testable`-importable like `VaultViewModel`):
   `decidePostSync`, `biometricUnlockError`, `resolveDisplayError` — colocate in a
   small `PostSyncDecision.swift` (mirrors `LockStateReducer` split).
7. `ios/PasswdSSOApp/Localizable.xcstrings` — new error key (above).

**Tests to add/update**:
- `ios/PasswdSSOTests/VaultUnlockerTests.swift` — AC-C1.1..C1.4 (stale→false,
  fresh→true, counter-mismatch→false, legacy bootstrap), AC-C4.1/4.2.
- `ios/PasswdSSOTests/WrappedKeyStoreTests.swift` — AC-C4.3 store round-trip.
- `ios/PasswdSSOTests/HostSyncServiceTests.swift` (new or existing) — T1 healing.
- New `ios/PasswdSSOTests/PostSyncDecisionTests.swift` — AC-C5.1..C5.6, AC-C2.1,
  AC-C3.1/3.2.

**Reuse (no reimplementation)**:
- `L10n.string(...)` for the new error (existing i18n helper).
- `max(1, entries.first { $0.teamId == nil }?.keyVersion ?? 1)` keyVersion logic
  already at `VaultUnlocker.swift:261` — reuse the same expression in C5.
- `readCacheFile` / `writeCacheFile` (unchanged), `HostSyncService.runSync`.
- Test helpers: `buildCacheFileForBiometricTest`, `MockKeychainAccessor`,
  `TempDirWrappedKeyStore`, `StubVaultAPIClient`, injectable `now`.

**No parallel-implementation risk**: `UnlockResult(` = 2 sites (both `VaultUnlocker`),
`WrappedVaultKey(` = 15 sites (2 prod + 13 test, all safe via `= nil` default),
`handleVaultUnlocked` = 2 call sites (`:262` biometric, `:286` passphrase).

**CI parity**: iOS CI runs `xcodegen generate` + `xcodebuild test`. After adding
`PostSyncDecision.swift` / `PostSyncDecisionTests.swift`, `xcodegen generate` must
regenerate the pbxproj and it must be committed (memory `ios-xcodegen-build-settings`).

## Go/No-Go Gate

| ID  | Subject                                                        | Status  |
|-----|---------------------------------------------------------------|---------|
| C1  | `unlockWithBiometrics` graceful cache-read degradation + `cacheRecovered` field | locked |
| C2  | RootView biometric closure: explicit error, no silent swallow (`biometricUnlockError` pure fn) | locked |
| C3  | Error surfacing into `VaultUnlockView` (`externalError` + `resolveDisplayError` pure fn) | locked |
| C4  | Persist `userId` with wrapped vault key (optional + init default) | locked |
| C5  | `handleVaultUnlocked` fatal-vs-recoverable (`decidePostSync(CacheData?)` + keyVersion propagation) | locked |

**Round-1 resolution log** (three-expert review — all findings reflected):

- **S2 [Critical, escalated]** → C5 rewritten: `decidePostSync` takes `CacheData?`
  (not `Bool`); structural guard so `cacheRecovered==false` NEVER re-reads the
  cache + forbidden-pattern + AC-C5.1/C5.6. Counter-splice window closed.
- **F1 [Critical]** → legacy-vault bootstrap documented in C1 + AC-C1.4 +
  Scenario 6. One-time explicit transition, not a silent regression.
- **T1 [Critical]** → HostSyncService-level FR1 healing test added (Testing
  strategy) — closes the "resync heals" coverage gap `decidePostSync` can't.
- **F2 [Major]** → INV-C5.3 + C5 behavior: synced keyVersion propagated to
  `.vaultUnlocked` (prevents keyVersion=1 write-back on edit).
- **F3 [Major]** → C4: memberwise init gains `userId: String? = nil` default;
  sweep corrected to 15 constructors (2 prod + 13 test).
- **T4/T5 [Major]** → C2: `biometricUnlockError` pure fn + AC-C2.1 behavioral
  symptom regression. Grep guards demoted to defense-in-depth.
- **T6 [Major]** → C4: Equatable sweep corrected (WrappedKeyStoreTests:40,60,217)
  + AC-C4.3 store-layer round-trip.
- **T2 [Major]** → subsumed by S2 fix (`CacheData?` decision input).
- **S1 [Major]** → SC6 scope note (AutoFill rollback-freshness, pre-existing,
  tracked follow-up) + security-analysis scope correction.
- **F4/T7 [Minor]** → FR3 + INV-C1.3 scoped to `unlockWithBiometrics`;
  acknowledged `runSync` is unconditional.
- **F5 [Minor]** → C5 single-read ordering specified.
- **F6 [Info]** → C5: `@discardableResult`.
- **S3 [Minor]** → C4 tampered-userId note. **S4 [Info]** → noted (security-safe;
  F2 handles the functional side). **T3/T8 [Info/Minor]** → test recipes locked.

All contracts are LOCKED. Ready for Phase 2 (coding). A Round-2 verification pass
should confirm the S2 structural guard and F2 keyVersion propagation are correctly
reflected before implementation begins.
