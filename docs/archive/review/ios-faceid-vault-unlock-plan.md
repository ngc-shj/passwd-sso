# Plan: iOS Face ID vault unlock (biometric re-unlock for the host app)

## Project context
- Type: `mixed` — native iOS app (SwiftUI host + AutoFill extension), E2E-encrypted vault. Security-sensitive: this changes the host vault's LOCK semantics and adds a biometric path to re-derive the in-memory vault key.
- Test infrastructure: `unit tests only` (XCTest, ~261 tests). The biometric/keychain seam is injectable (FakeKeychain/MockKeychain, injected LAContext-free read in tests); `LAContext` biometric prompts are device-manual. The unwrap crypto + lock-lifetime logic are unit-testable.

## Problem
"Face ID seems split between sign-in and passphrase." Today the host app has NO biometric unlock: sign-in is OAuth (no Face ID), and vault unlock requires **typing the master passphrase every time** — even though the AutoFill extension already unlocks the *same* `bridge_key` with Face ID (`.biometryCurrentSet`) and unwraps the cached vault key (`CredentialResolver.resolveCandidates`). The asymmetry ("AutoFill uses Face ID but the host makes me type my passphrase") is the user's reported confusion. Standard password managers (1Password/Bitwarden) offer: first unlock = passphrase, subsequent unlocks = Face ID.

The blocker: `AutoLockService.lock()` currently **deletes** the `bridge_key` (`AutoLockService.swift:79` `try? bridgeKeyStore.delete()`), so after any lock there is no biometric material to read — biometric re-unlock is impossible and AutoFill also stops until the next passphrase unlock.

## Objective
Offer "Unlock with Face ID" on the vault-locked screen so a returning user re-derives the in-memory vault key biometrically (no passphrase, no network), with passphrase always available as fallback.

## Decisions (user, 2026-06-11)
- **Both auto-lock (action=lock) AND manual Lock KEEP the `bridge_key`** → Face ID re-unlock available after either. `logout`-on-timeout and explicit sign-out still fully clear everything (passphrase + re-sign-in required).
- **Reuse the single existing `bridge_key`** for both host re-unlock and AutoFill. Consequence (accepted): AutoFill now works while the host is locked (each fill is still biometric-gated). `#539`'s "Vault is Locked" fallback now only applies when the `bridge_key` is genuinely absent (post sign-out / before the first-ever passphrase unlock).

## Technical approach
Replicate the extension's unwrap sequence in the host: `BridgeKeyStore.readForFill(reason:)` (biometric) → `deriveCacheVaultKey(bridgeKey:)` (HKDF) → `WrappedKeyStore.loadVaultKey()` → `decryptAESGCM` → `vault_key`. Recover `userId` (needed for personal-entry AAD) from the **encrypted cache header** read with the just-unwrapped vault key (`readCacheFile(path:vaultKey:expectedHostInstallUUID:expectedCounter:)`, using the biometric read's `Blob.hostInstallUUID`/`cacheVersionCounter`) — no new plaintext persistence. The whole thing runs offline (no `/api/vault/unlock/data` round-trip).

Change the lock lifetime: `lock()` stops deleting the `bridge_key`; `signOut()` deletes it explicitly (since `lock()` no longer does). The in-memory vault key is dropped by the existing `.vaultLocked` transition (RootView drops `vaultKey` from `AppState`); locking = "no working key in memory, biometric/passphrase required to re-derive", which is the correct biometric-unlock model. The `bridge_key` ACL (`.biometryCurrentSet`, `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`) already enforces: biometric required to read, device-bound, invalidated on biometric re-enrollment.

## Contracts

### C1 — `AutoLockService` lock/sign-out bridge_key lifetime (locked)
- `lock()` (`AutoLockService.swift:76-80`): **remove `try? bridgeKeyStore.delete()`**. Lock now only `stopTimer()` + `state = .locked`. The in-memory vault key is already dropped by RootView's `.vaultLocked` transition. The `bridge_key` + `wrapped-vault-key.json` survive → biometric re-unlock available. **Update the stale doc-comment** (line 74, currently "delete bridge_key_blob from Keychain") to: "Drop vault_key from memory (keeps bridge_key so biometric re-unlock is available); keeps cache + wrapped blobs." (S4)
- `signOut()` (`AutoLockService.swift:85-94`): **add `try? bridgeKeyStore.delete()` as the FIRST statement** of `signOut()` (before `lock()` / `tokenStore.deleteAll()` / `wrappedKeyStore.clearAll()` / cache removal) — so a mid-sign-out crash cannot leave the biometric path open with the bridge_key surviving. (S2/F8) Net: full sign-out clears bridge_key + wrapped key + tokens + cache → biometric unavailable → `.loggedOut`.
- Invariant: after `lock()` → bridge_key PRESENT; after `signOut()` (incl. `logout` timeout action, which routes through `signOut()`) → bridge_key ABSENT.
- Forbidden pattern: `pattern: func lock\(\)[\s\S]*?bridgeKeyStore\.delete — reason: lock() must NOT delete the bridge_key (that would disable biometric re-unlock).`
- **Test migration (F2/S1/T1 — mandatory, same PR)**: two existing tests assert the OLD invariant and WILL break — INVERT them (do NOT delete, to keep coverage of the new invariant):
  - `AutoLockServiceTests.testLockDeletesBridgeKeyBlob` (line 88) → rename `testLockPreservesBridgeKeyBlob`, flip both `XCTAssertNil` (bridge-key-v2 + bridge-meta-v2) to `XCTAssertNotNil` after `lock()`.
  - `AutoLockServiceTests.testTickLocksAtBoundary` (line ~229) → flip the bridge-key-v2 `XCTAssertNil` to `XCTAssertNotNil` (key survives a `.lock`-action idle timeout); the wrapped-key `XCTAssertNotNil` on the next line stays.
  - `testSignOutDeletesEverything` (line 134) and `testTickWithLogoutActionSignsOut` (line 283) already assert bridge_key ABSENT — keep unchanged (correct for signOut/logout). Add an assertion to `testSignOutDeletesEverything` that bridge_key is deleted (it already checks this — verify it covers the FIRST-statement delete).
- Acceptance (unit, `AutoLockServiceTests` with the existing keychain-backed BridgeKeyStore): after `lock()`, bridge-key-v2 + bridge-meta-v2 still present; after `signOut()`, both deleted AND wrapped key + tokens + cache cleared; `tick()` with `timeoutAction == .lock` keeps the key, `.logout` clears it.

### C2 — `VaultUnlocker.unlockWithBiometrics` + availability (locked)
- Inject `cacheURL: URL` AND `now: @Sendable () -> Date = { Date() }` into `VaultUnlocker.init` (alongside existing `apiClient`/`bridgeKeyStore`/`wrappedKeyStore`); `unlock(passphrase:)` is otherwise unchanged. The `now` injection matches `CredentialResolver` and lets tests seed a non-stale cache (F1). **C2 is coupled to C5**: adding init params breaks `vaultLockedScreen`'s `VaultUnlocker(...)` call — apply C2 and C5 in the same commit (F4).
- New method:
  ```swift
  public func unlockWithBiometrics(reason: String) async throws -> UnlockResult
  ```
  Sequence: `blob = try bridgeKeyStore.readForFill(reason:)` (biometric) → `cacheKey = try deriveCacheVaultKey(bridgeKey: blob.bridgeKey)` → `guard let wrapped = try wrappedKeyStore.loadVaultKey() else { throw .biometricUnavailable }` → `vaultKeyData = try decryptAESGCM(ciphertext:iv:tag:key: cacheKey)` → `vaultKey = SymmetricKey(data: vaultKeyData)` → recover userId: `cache = try readCacheFile(path: cacheURL, vaultKey: vaultKey, expectedHostInstallUUID: blob.hostInstallUUID, expectedCounter: blob.cacheVersionCounter, now: now())` → **guard `!cache.header.userId.isEmpty` else throw `.cacheUnreadable`** (an empty userId would silently corrupt personal-entry AAD — F5) → recover the vault `keyVersion` (REQUIRED post-#540: `UnlockResult` now carries `keyVersion`; the passphrase path gets it from the network, offline we read it from the cache): decode `[CacheEntry]` from `cache.entries` and take `entries.first(where: { $0.teamId == nil })?.keyVersion ?? 1` (all personal entries share the vault keyVersion; default 1 for an empty vault) → `return UnlockResult(vaultKey: vaultKey, userId: cache.header.userId, keyVersion: keyVersion)`. Zero the intermediate `vaultKeyData` after constructing the `SymmetricKey` (match `CredentialResolver`'s `defer { zeroData(&...) }`). **Post-#540 reconciliation**: the `keyVersion` field did not exist when this plan was first written; create/edit (#540) floor it with `max(1, keyVersion)`, so a default of 1 is always safe.
- New error cases on `VaultUnlockError`: `.biometricUnavailable` (no wrapped key / no bridge_key), `.biometricFailed` (LAContext / keychain biometry error), `.cacheUnreadable` (vault key recovered but cache header unreadable/empty-userId → cannot get a valid userId). All map to "fall back to passphrase" in the UI.
- New availability check: `public nonisolated func biometricUnlockAvailable() -> Bool` — **`nonisolated`** so the synchronous SwiftUI view builder can call it without `await` (it reads only the injected `Sendable` stores, no actor state — F7). Returns true when `(try? bridgeKeyStore.readDirect())?.cacheVersionCounter ?? 0 != 0` AND `wrappedKeyStore.loadVaultKey() != nil`. `readDirect()` reads ONLY the no-ACL meta — NO biometric prompt. **Invariant note (F3/S5)**: meta-presence is a strong (not strict) proxy for biometric-key presence; the EFFECTIVE gate is wrapped-key presence (cleared on `signOut`). The rare "meta survives, key gone" partial-delete case yields a spurious prompt that fails into the passphrase fallback — acceptable, no data/security gap. (No `delete()` reorder — avoids touching shared BridgeKeyStore used by the extension.)
- **Consumer-flow walkthrough** (UnlockResult is consumed by RootView.handleVaultUnlocked): `handleVaultUnlocked` reads `unlockResult.vaultKey`, `unlockResult.userId`, and (post-#540) `unlockResult.keyVersion` to build the sync service, thread keyVersion into `.vaultUnlocked`/VaultListView (for create/edit), register QuickType identities, and populate the list — all three present in the biometric-path UnlockResult (userId from the cache header, keyVersion from the cache entries). Identical shape to the passphrase path. ✓
- Forbidden pattern: `pattern: fetchVaultUnlockData inside unlockWithBiometrics — reason: biometric unlock must be offline; no network round-trip.`
- Acceptance (unit, `VaultUnlockerTests`):
  - **Real-crypto happy path (RT1/RT5 — T2/T4)**: seed a bridge_key blob (`MockKeychainAccessor`), a `WrappedVaultKey` produced by the REAL wrap path (`encryptAESGCM(plaintext: vaultKeyBytes, key: deriveCacheVaultKey(bridgeKey:))`), and an encrypted cache file built with a FRESH timestamp (T5) carrying `header.userId`. Call `try await unlocker.unlockWithBiometrics(reason:)` DIRECTLY (not the crypto helpers) and assert the returned `vaultKey` bytes match the seeded vault key, `result.userId == seeded header.userId`, AND `result.keyVersion == seeded entry keyVersion` (seed a personal CacheEntry with a DISTINCT keyVersion, e.g. 3, to prove it's read from the cache, not defaulted). Extract the existing private `wrapAndSaveVaultKey` + `buildCacheFile` helpers from `CredentialResolverTests` into a shared test helper so the new test uses them (no duplication).
  - Missing wrapped key → `.biometricUnavailable`. Unreadable / empty-userId cache → `.cacheUnreadable`.
  - **Availability (RT5 — T3/T6)**: use `MockKeychainAccessor` (has `accessedServices`) — assert `biometricUnlockAvailable()` touches ONLY `bridge-meta-v2` (zero biometric-service reads). TWO false-case tests: (1) bridge_key/meta absent; (2) bridge_key present but wrapped key absent.

### C3 — `BridgeKeyStore`: host biometric read (no API change expected) (locked)
- Verify `readForFill(reason:)` and `readDirect()` are callable from the host target (they are `public`; entitlements already grant the shared keychain access group + App Group to BOTH targets — confirmed, no entitlement change). No new BridgeKeyStore API is required; if a host-only convenience is added it must reuse the existing `readForFill` (no duplicate biometric-read implementation).
- Forbidden pattern: `pattern: SecAccessControlCreateWithFlags outside BridgeKeyStore.swift — reason: biometric ACL construction stays centralized; the host must not re-implement the keychain biometric read.`
- Acceptance: build proves the host app links `readForFill`/`readDirect`; no second biometric-read code path introduced (grep).

### C4 — `VaultUnlockView`: Face ID button + auto-prompt + passphrase fallback (locked)
- Add to the existing passphrase view (constructor-injected so the screen stays testable):
  - `let biometricUnlock: (@MainActor () async -> Void)?` — nil when biometrics unavailable (then the view is passphrase-only, unchanged).
  - `let biometryLabel: String` — "Face ID" / "Touch ID" / "biometrics" derived from `LAContext().biometryType` by the caller (C5).
- UI: when `biometricUnlock != nil`, show a prominent "Unlock with \(biometryLabel)" button above the passphrase field (always tappable). **Auto-prompt gating (device-testing revision, refined):** auto-invoke biometric ONLY on a genuine foreground RE-ENTRY (`scenePhase` `background → active`), NEVER when the vault locks while the app is already `.active`. The correct discriminator is "did the vault lock while the user was present (explicit Lock OR idle timeout — both fire while `.active`) vs. is the user RE-ENTERING the app" — not "explicit vs timeout" and not "all-but-sign-in". Implementation: `@State autoPromptArmed` is set true only on `.background`; `.active` fires the prompt once when armed. The in-app lock surfaces the lock screen with NO scene transition → not armed → stays locked (the reported bug); a real foreground re-entry → armed → auto-prompt. A `.inactive`→`.active` blip (Control Center) does NOT arm, so it won't prompt. The passphrase field + Unlock button are ALWAYS present as fallback.
- Errors: biometric cancel/fail does NOT show a scary error — it silently leaves the lock screen (button + passphrase). A `.cacheUnreadable`/`.biometricUnavailable` falls back to the passphrase.
- Acceptance (device-manual): (a) tap Lock → lock screen appears and STAYS (no instant re-unlock); (b) idle timeout while present → stays locked, no instant re-unlock; (c) background the app then return → Face ID auto-prompts; (d) tapping the button always works; cancel → lock screen remains, passphrase usable.

### C5 — `RootView` wiring (locked)
- `vaultLockedScreen` builds the `VaultUnlocker` with `cacheURL` using the same fallback pattern as `handleVaultUnlocked`: `let cacheURL = (try? AppGroupContainer.cacheFileURL()) ?? URL(fileURLWithPath: "/dev/null")` (F6). It computes availability via `unlocker.biometricUnlockAvailable()` (now `nonisolated`, callable synchronously) AND `LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error:)`, derives `biometryLabel` from `LAContext().biometryType`, and passes a `biometricUnlock` closure that calls `unlocker.unlockWithBiometrics(reason:)` and routes the `UnlockResult` into the existing `handleVaultUnlocked(...)` (same path as passphrase). On biometric error → no-op (leave passphrase fallback). NOTE: this is the atomic counterpart to C2's init change — apply together (F4).
- Reason string: "Unlock your passwd-sso vault."
- The `.vaultLocked` and `.signedIn` screens both reuse `vaultLockedScreen` (already do) → biometric offered in both.
- No change to the `.onChange(autoLockService.state)` transitions; the QuickType `CredentialIdentityRegistrar().clear()` on `.locked` is **kept as-is** (locked vault still shows no inline QuickType hints — a deliberate `#537` privacy choice; the manual AutoFill picker still works since the bridge_key is present, but inline hints are conservatively cleared). Out of scope to change #537.
- Acceptance (device-manual): lock (idle or manual) → re-open → Face ID → unlocked without passphrase; sign out → Face ID NOT offered (passphrase + re-sign-in).

### C6 — No regression; ripple reconciliation (locked)
- `#537` QuickType: unchanged (still cleared on lock). `#539` AutoFill `LockedFallbackView`: unchanged — it shows when `readForFill` finds no bridge_key, which now only happens post-signout/pre-first-unlock (the copy stays accurate for that genuine case). Document this behavior shift in the PR (AutoFill now fills while the host is locked, because the bridge_key survives lock).
- `build-for-testing` + `test-without-building` pass; existing ~261 tests green + new `unlockWithBiometrics`/availability tests + INVERTED `AutoLockServiceTests` (the two enumerated in C1: `testLockDeletesBridgeKeyBlob`→`testLockPreservesBridgeKeyBlob`, `testTickLocksAtBoundary`; `testSignOutDeletesEverything`/`testTickWithLogoutActionSignsOut` unchanged). Extract shared test helpers `wrapAndSaveVaultKey` + `buildCacheFile` from `CredentialResolverTests` (T2). Use `MockKeychainAccessor` (not `MockKeychain`) for the availability no-prompt assertion (T3).
- No new warnings.

## Testing strategy
- Unit: `VaultUnlockerTests` — `unlockWithBiometrics` happy path (seeded keychain+wrapped+cache → correct vaultKey+userId), `.biometricUnavailable`/`.cacheUnreadable` branches, and `biometricUnlockAvailable()` (true/false, zero biometric reads). `AutoLockServiceTests` — lock keeps bridge_key, signOut/logout-timeout deletes it (spy on the bridge key store / keychain).
- Manual (device): the C4/C5 scenarios (auto-prompt, success, cancel→passphrase, signout→no-biometric, AutoFill-works-while-locked) in `docs/archive/review/ios-faceid-vault-unlock-plan-manual-test.md`.

## Considerations & constraints
- **Security trade-off (central)**: keeping the biometric-gated bridge_key past lock means device + enrolled biometrics can re-derive the vault key without the passphrase. This is the intended 1Password/Bitwarden model and the user's explicit choice. The passphrase remains the root of trust (first unlock + after sign-out); biometric is a convenience re-derivation gated by `.biometryCurrentSet` (auto-invalidated on biometric enrollment change). Users wanting passphrase-every-time can set the timeout action to `logout`.
- **AutoFill-while-locked** is now possible (accepted). Each fill is still biometric-gated. The QuickType inline-hint clear-on-lock is kept (conservative).
- **userId** comes from the encrypted cache header (no new plaintext storage); if the cache is absent/unreadable, biometric unlock fails closed to passphrase.
- **First run / no bridge_key**: biometric unavailable → passphrase only (unchanged).
- **Out of scope**: a Settings "Unlock with Face ID" toggle (biometric offered automatically when available); changing #537/#539; session/token restore-on-launch behavior.

## User operation scenarios
- Idle auto-lock → re-open app → Face ID prompts automatically → vault unlocked, no passphrase.
- Tap manual Lock → tap Unlock with Face ID → unlocked.
- Face ID fails/cancel → passphrase field is right there → type to unlock.
- Sign out → re-open → no Face ID offered → must sign in + passphrase (full root-of-trust).
- After auto-lock, use AutoFill in Safari → still works (per-fill Face ID) — the bridge_key survived the lock.

## Round 1 Review Resolutions (triangulate)
All Critical + Major from `ios-faceid-vault-unlock-review.md` (round 1) folded into the contracts:
- **F1 (Critical)** → C2: inject `now` into VaultUnlocker, pass `now: now()` to `readCacheFile` (testable, non-stale).
- **F2/S1/T1 (Critical)** → C1: enumerate + INVERT the two breaking `AutoLockServiceTests` (keep coverage of the new "lock keeps bridge_key" invariant). No Opus escalation — migration strategy agreed, threat-model assessment favorable.
- **T2 (Critical, RT1)** → C2/C6: happy-path test uses a REAL-wrap `WrappedVaultKey` + real seeded cache; extract `wrapAndSaveVaultKey`/`buildCacheFile` shared helpers.
- **F4 (Major)** → C2/C5: note the atomic init↔wiring coupling.
- **F5 (Major)** → C2: guard non-empty `userId` from the cache header.
- **F3/S5 (Major/Minor)** → C2: soften the meta⇒key invariant; wrapped-key presence is the effective gate; spurious-prompt→passphrase fallback acceptable; no shared `delete()` reorder.
- **S2/F8 (Major)** → C1: `bridgeKeyStore.delete()` is the FIRST statement of `signOut()`.
- **S3 (Major)** → manual-test artifact created (`ios-faceid-vault-unlock-plan-manual-test.md`) with Tier-2 adversarial scenarios.
- **T3 (Major, RT5)** → C2/C6: use `MockKeychainAccessor` for the zero-biometric-reads assertion.
- **T4 (Major, RT5)** → C2: happy-path test calls `unlocker.unlockWithBiometrics(reason:)` directly.
- **F6/F7/S4/T5/T6 (Minor)** → C2/C5/C1: cacheURL fallback; `nonisolated` availability; doc-comment fix; fresh cache timestamp; two false-case tests.
- **R30 (Minor)** → PR refs backticked.

## Go/No-Go Gate
| ID  | Subject                                                  | Status |
|-----|----------------------------------------------------------|--------|
| C1  | AutoLockService lock keeps / signOut deletes bridge_key  | locked |
| C2  | VaultUnlocker.unlockWithBiometrics + availability        | locked |
| C3  | BridgeKeyStore host biometric read (no API change)       | locked |
| C4  | VaultUnlockView Face ID button + auto-prompt + fallback  | locked |
| C5  | RootView wiring (availability, biometryLabel, callback)  | locked |
| C6  | No regression; ripple reconciliation + test migration    | locked |
