# Plan: iOS manual Sign Out + tenant auto-lock override

## Project context
- Type: `mixed` — native iOS app (SwiftUI host). Touches auth-adjacent surfaces (sign-out clears tokens/keys; tenant policy applied to auto-lock) but introduces NO new crypto/network-auth primitive — it reuses existing `AutoLockService.signOut()` and the already-consumed `/api/vault/unlock/data` response. Security review dimension is moderate (sign-out completeness, policy-clamp correctness), not heavy.
- Test infrastructure: `unit tests only` (XCTest, ~302 tests incl. LocalizationCatalogTests). SwiftUI rendering + on-device flows are manual; the state-machine/decode/clamp logic IS unit-testable.

## Problem
Two browser-extension behaviors are missing on iOS (parity roadmap #1):
1. **Manual Sign Out** — the extension popup has a Disconnect action (`CLEAR_TOKEN`) that fully signs out on demand. iOS has NO manual sign-out button while unlocked; the only logout path is idle-timeout with `VaultTimeoutAction.logout`. (`AutoLockService.signOut()` already exists and does the full local clear — it's just not reachable from the UI.)
2. **Tenant auto-lock override** — the extension reads `vaultAutoLockMinutes` from the `/api/vault/unlock/data` response and, when non-null, uses it as the effective auto-lock interval (overriding the user's local setting) and disables the user picker. iOS already calls `/api/vault/unlock/data` but does NOT decode or apply `vaultAutoLockMinutes`.

## Objective
- A destructive **Sign Out** action in the unlocked UI that fully signs the user out (local clear) and returns to setup.
- The tenant's `vaultAutoLockMinutes` policy, when set, **overrides** the user's auto-lock interval (exact value, not a clamp) and the Settings picker reflects it as org-enforced (disabled + enforced value shown). Cleared on sign-out.

## Technical approach
- **Reuse existing `AutoLockService.signOut()`** (deletes bridge_key, tokens, wrapped keys, cache → `.loggedOut`; `RootView.onChange` already routes `.loggedOut` → `.setup`). The button only needs UI + a confirmation dialog. **No server-side token revocation** (see Considerations — no mobile-token revoke endpoint exists; local clear matches the current timeout-logout posture).
- **Tenant policy is already in the unlock response** (`/api/vault/unlock/data` → `vaultAutoLockMinutes: number|null`, server-validated `[5, 1440]`). Decode it into `VaultUnlockData`, thread via `UnlockResult` → persist in `AppSettingsStore` (App Group) at passphrase unlock, apply as the effective interval. The biometric/offline unlock path uses the last-persisted value (it does not refetch — documented limitation, matches its offline design).
- **Override semantics match the extension** (`getEffectiveAutoLockMinutes`): `effective = (tenant != nil && tenant > 0) ? tenant : userSetting`. Tenant value is the EXACT interval (override), not a min/max cap.
- **Clamp hazard (central design point):** tenant values may exceed the user picker's 60-min cap (up to 1440). `AutoLockService.autoLockMinutes` currently clamps to `[1,60]` and `AppSettingsStore.minutes` to `[5,60]` — applying a tenant value of e.g. 120 naively would truncate to 60. The applied effective value must bypass the 60-cap (clamp only to the server-valid `[5,1440]`), while the user picker keeps `[5,15,30,60]`.
- **i18n**: new user-facing strings ("Sign Out" + confirmation + org-enforced hint) get catalog keys (en+ja) in the host catalog; `LocalizationCatalogTests` stays green. See [[ios-string-catalog-notes]].

## Contracts

### C1 — Decode `vaultAutoLockMinutes` into `VaultUnlockData` (locked, R1: F3/T2)
- `ios/PasswdSSOApp/Network/MobileAPIClient.swift`: add `public let vaultAutoLockMinutes: Int?` to `VaultUnlockData` and `case vaultAutoLockMinutes` to its `CodingKeys`. Server already returns it (`src/app/api/vault/unlock/data/route.ts:134`, `Int?`/null). **Do NOT hand-write `init(from:)`** — the synthesized `Decodable` treats an `Optional` member as decode-if-present, so `null` OR an absent key → `nil` automatically (F3).
- **Add an explicit memberwise `init`** with `vaultAutoLockMinutes: Int? = nil` defaulted **last** (T2 / R19): `VaultUnlockData` currently has NO explicit init, so adding a stored property would break every memberwise call site. A defaulted-last explicit init keeps the 3 existing test construction sites (`VaultUnlockerTests.swift:27` helper, `:308`, `:366`) compiling unchanged. (Adding a custom memberwise `init` does NOT remove the synthesized `init(from:)`.)
- **Consumer-flow walkthrough**: Consumer `VaultUnlocker.unlock` (path: `ios/PasswdSSOApp/Vault/VaultUnlocker.swift`) reads `unlockData.vaultAutoLockMinutes` and passes it into `UnlockResult.tenantAutoLockMinutes` (C2). No other consumer reads the new field directly.
- Forbidden pattern: `pattern: vaultAutoLockMinutes.*=.*0` in non-test Swift — reason: 0/absent must map to `nil` (no override), never a literal 0.
- Acceptance: decoding `{… "vaultAutoLockMinutes": 120}` → `120`; `null` or missing → `nil`. The `makeVaultUnlockData` test helper gains a `vaultAutoLockMinutes: Int? = nil` param (drives C2 tests). All existing `VaultUnlockData(...)` and decode tests still compile + pass.

### C2 — Thread tenant minutes through `UnlockResult` (locked, R1: T3)
- `VaultUnlocker.swift`: add `public let tenantAutoLockMinutes: Int?` to `UnlockResult` (NOT defaulted — force both call sites to state the value explicitly so the offline-path intent is visible). Update BOTH production constructors: `unlock(passphrase:)` at `:160` → `unlockData.vaultAutoLockMinutes`; `unlockWithBiometrics(...)` at `:217` → `nil` (offline cache path, no fresh policy fetch; persisted value reused, C3). No test constructs `UnlockResult` directly (only these 2 prod sites).
- **Consumer-flow walkthrough**: Consumer `RootView.handleVaultUnlocked` (path: `ios/PasswdSSOApp/Views/RootView.swift`) reads `unlockResult.tenantAutoLockMinutes` and (a) persists it via `AppSettingsStore` (C3) then (b) calls `applyPersistedTimeout`. The biometric closure path also calls `handleVaultUnlocked` (so a nil there must NOT clobber a previously-persisted non-nil value — see C3 persist rule).
- Acceptance: passphrase unlock with tenant=120 → `UnlockResult.tenantAutoLockMinutes == 120`; biometric unlock → `nil`.

### C3 — Persist + effective precedence + clamp relaxation + testable policy decision (locked, R1: T1/F2/F4)
- **Shared constant** (R2): add `VAULT_AUTO_LOCK_MIN = 5` / `VAULT_AUTO_LOCK_MAX = 1440` in ONE place (e.g. `AppSettingsStore` static lets) and reference everywhere — no other hardcoded `60`/`1440`/`5` clamp literals.
- `AppSettingsStore.swift`:
  - Add `var tenantAutoLockMinutes: Int?` (App Group UserDefaults key `tenantAutoLockMinutes`): getter returns the stored value ONLY if in `[MIN, MAX]`, else **`nil`** (fail-closed to the user setting — F4: reject out-of-range to nil, do NOT clamp-into-range on read; matches the existing fail-closed `minutes` getter discipline). Setter writes the value, or **removes** the key when set to `nil`.
  - Add `var effectiveAutoLockMinutes: Int { tenantAutoLockMinutes ?? minutes }` — SINGLE precedence point, no second clamp (the getter already guarantees `[MIN,MAX]`-or-nil). Tenant overrides user `minutes` (which stays `[5,60]`, untouched).
  - **Add `func applyTenantPolicy(_ minutes: Int?, policyAuthoritative: Bool)` (T1 — the testable crux)**: encapsulates the decision so it is NOT buried in SwiftUI: `policyAuthoritative && value != nil` → write; `policyAuthoritative && nil` → clear (server removed the policy); `!policyAuthoritative` → **no-op** (biometric/offline path must not wipe a persisted value). `clearTenantPolicy()` removes the key (sign-out / `.loggedOut`).
- `AutoLockService.swift`: relax the `autoLockMinutes` setter clamp upper bound from `60` to `VAULT_AUTO_LOCK_MAX` (`max(1, min(VAULT_AUTO_LOCK_MAX, newValue))`) so an applied tenant override isn't truncated. The user picker still offers only `[5,15,30,60]`; this clamp only guards the applied effective value. **Floor stays `1`.**
- `LockState.swift:11` (F2 — the third, off-the-live-path clamp): relax its `[1,60]` clamp to `[1, VAULT_AUTO_LOCK_MAX]` too, for consistency, so a future refactor wiring `tick()` through `LockStateReducer` can't silently re-truncate a tenant override. (Currently `tick()` uses `_autoLockMinutes` directly and `reduce()` has no non-test callers — latent trap, fix now.) Also update the stale `LockState.swift:4` docstring `clamped to [1, 60]` → `[1, 1440]` (F8).
- `RootView.applyPersistedTimeout(to:)`: set `service.autoLockMinutes = store.effectiveAutoLockMinutes` (was `store.minutes`).
- `RootView.handleVaultUnlocked(...)`: BEFORE `applyPersistedTimeout`, call `store.applyTenantPolicy(unlockResult.tenantAutoLockMinutes, policyAuthoritative: <true for passphrase, false for biometric>)`. The authoritative flag is threaded from the call site (passphrase callback `RootView.swift:~197` = true; biometric closure `:~175` = false) — `handleVaultUnlocked` is the sole consumer, called from exactly those two sites. RootView stays a thin caller; the branch logic lives in the unit-tested `applyTenantPolicy`.
- `RootView` `.onChange(.loggedOut)`: call `AppSettingsStore().clearTenantPolicy()` — single chokepoint covering BOTH manual sign-out and timeout-logout (both reach `.loggedOut`).
- Forbidden pattern: `pattern: min\(60,` or `, *60\)` newly added in AutoLockService/LockState — reason: the 60-cap must not gate the tenant-applied value.
- Acceptance (unit-testable on `AppSettingsStore` + `AutoLockService`, NOT requiring RootView): `applyTenantPolicy(120, authoritative:true)` → `effectiveAutoLockMinutes==120`; `applyTenantPolicy(nil, authoritative:false)` over a persisted 120 → still 120 (retained); `applyTenantPolicy(nil, authoritative:true)` → cleared → `==minutes`; out-of-range stored (`4`,`2000`) → getter `nil` → `==minutes`; `service.autoLockMinutes = 120` → `120` (not 60), `2000` → 1440, `0` → 1; setting tenant does NOT mutate `store.minutes`.

### C4 — Sign Out button + confirmation (locked, R1: F6)
- `VaultListView.swift` ⋯ menu: add a destructive **Sign Out** `Button` below Lock that sets a new `@State private var isShowingSignOutConfirm = false`. Present the confirmation via `.confirmationDialog(...)` anchored at the **`VaultListView` body level** (NOT inside the `Menu`, where dismissal races the menu collapse) — title/message warn it clears the local session — with a destructive "Sign Out" confirm + "Cancel". On confirm: `autoLockService.signOut()` (existing) → state `.loggedOut`. `recordActivity()` is NOT called (we want to leave). (Asymmetry with one-tap "Lock" is intentional: sign-out clears tokens/cache → re-auth; lock is cheap.)
- The `.loggedOut` transition (RootView) already clears QuickType identities and routes to `.setup`; C3 adds the tenant-policy clear there.
- Strings are `LocalizedStringKey` literals (auto-localize): "Sign Out", confirmation title/message, confirm/cancel.
- Forbidden pattern: none specific.
- Acceptance: Sign Out → confirm → `signOut()` called, app at `.setup`, QuickType + tenant policy cleared; Cancel → no state change, vault stays unlocked.

### C5 — SettingsView org-enforced auto-lock UI (locked, R1: F5)
- `SettingsView.swift`: when `store.tenantAutoLockMinutes != nil`:
  - The Auto-Lock `Picker` is `.disabled(true)`. The `autoLockSelection.get` already returns `autoLockService.autoLockMinutes` (== the enforced value after C3), but a value ∉ `[5,15,30,60]` matches no `.tag` and renders **blank** — so include the enforced value as an extra option (load-bearing, not cosmetic: without it the disabled picker shows empty).
  - Render every option (standard + enforced) via the existing **`%lld minutes` plural key** (`Text("\(minutes) minutes")`), NOT a bare string, so `1` reads "1 minute" / 「1 分」, not "1 minutes" (F5/R27). The `%lld minutes` key already exists with en+ja.
  - Show a localized footnote/hint under the picker: "Set by your organization." (key in catalog, en+ja).
  - The user's local `store.minutes` is NOT overwritten (so removing the policy later restores the user's prior choice — extension parity: tenant value is display/effective-only, the user setting persists untouched).
- When no tenant policy: unchanged (picker enabled, `[5,15,30,60]`).
- Acceptance: tenant=120 → picker disabled, shows "120 minutes"/「120 分」 + hint, `store.minutes` unchanged; tenant=nil → picker enabled, normal options.

### C6 — i18n + tests + no regression (locked, R1: T2/T3/T4/T5)
- Host catalog (`ios/PasswdSSOApp/Localizable.xcstrings`): add en+ja for "Sign Out", the confirmation title/message/confirm/cancel, and the org-enforced hint "Set by your organization." `LocalizationCatalogTests` auto-catches any new key lacking ja (no test code change). The enforced-value option reuses the existing `%lld minutes` plural key (already translated).
- **Existing tests that MUST be updated** (T4/T7 — else the suite goes red; relaxing the clamp must sweep BOTH asserting sites):
  - `AutoLockServiceTests.testAutoLockMinutesClamped` (`:303-304`) asserts `100 → 60` → change to the new ceiling: `2000 → 1440`, add `120 → 120` (no 60-truncation), keep `0 → 1` (floor).
  - `LockStateReducerTests.testAutoLockMinutesClampedTo60` (`:70-73`) asserts `LockState(autoLockMinutes: 120).autoLockMinutes == 60` → after the F2 `LockState` relaxation this becomes `120`; update to assert `120 → 120` and `2000 → 1440` (and relabel — 60 is no longer the ceiling). Keep `testAutoLockMinutesClampedTo1` (`0 → 1`) unchanged.
- **Initializer fan-out (T2/T3 / R19)**: the `VaultUnlockData` explicit defaulted-last init (C1) keeps the 3 test sites compiling; the `makeVaultUnlockData` helper gains a `vaultAutoLockMinutes` param. `UnlockResult` (no default) requires updating both prod sites (`:160`, `:217`).
- New unit tests:
  - `VaultUnlockData` decodes `vaultAutoLockMinutes` (120 / null / absent → nil).
  - `UnlockResult` carries tenant minutes from passphrase unlock (stub data `vaultAutoLockMinutes=120` → `result.tenantAutoLockMinutes==120`); biometric happy-path (`VaultUnlockerTests:~461`) → `nil`.
  - `AppSettingsStore` (injectable `UserDefaults(suiteName:)`): `applyTenantPolicy` 3 branches (authoritative+value→write; authoritative+nil→clear; non-authoritative+nil→retain); `effectiveAutoLockMinutes` precedence; getter rejects out-of-range (`4`,`2000`,`0`/negative) → `nil`; absent → `nil`; `clearTenantPolicy()` removes key; **tenant value does NOT mutate `store.minutes`** (cross-field invariant).
  - `AutoLockService`: `autoLockMinutes` accepts 120 without truncation to 60; floors at 1, caps at 1440.
- `build-for-testing` + `test-without-building` on the iOS 18.x simulator: all existing + new tests green, no new warnings. CI parity (Xcode 16.4 / iOS 18 SDK): no iOS-26-only API; `BridgeKeyStore(service:)` not instantiated in new tests (#540 abort trap — the `AppSettingsStore` tests are keychain-free, `AutoLockService` tests use the safe `…bridge-key` suffix).

## Testing strategy
- Unit (XCTest): C1 decode, C2 threading, C3 persist/effective/clamp, C6 i18n coverage.
- Manual (`ios-signout-tenant-autolock-plan-manual-test.md`, placeholder URLs): Sign Out → confirm → lands on setup, re-sign-in required (tokens gone); Cancel keeps vault. Tenant policy: set `vaultAutoLockMinutes` server-side → unlock → Settings shows enforced value disabled + hint, auto-lock fires at the tenant interval; clear policy server-side → next passphrase unlock restores the user picker.

## Considerations & constraints
- **No server-side token revocation on sign-out** (out of scope): there is NO mobile-token revoke endpoint (`/api/mobile/token` is POST-only; the extension's `DELETE /api/extension/token` is a different token type). The local clear deletes the device's tokens from the Keychain — the refresh token remains valid server-side **only until the server-side idle timeout (`IOS_TOKEN_IDLE_TIMEOUT_MS`) elapses**, identical to the EXISTING timeout-logout posture (not a regression). The refresh token is DPoP-bound (`cnf.jkt`) to the device's non-extractable Secure Enclave key (deliberately NOT deleted — it's a per-device identity key, not a session secret), so a stolen refresh token alone is unusable. Residual risk requires a fully-compromised device (where the local Keychain is already exposed). Adding `DELETE /api/mobile/token` + a `MobileAPIClient.revoke()` (called best-effort BEFORE the local clear, never blocking sign-out on the network) is a separate server-side enhancement; `TODO(ios-signout-tenant-autolock): server-side mobile-token revocation`.
- **Client-side auto-lock is a UX / defense-in-depth control, NOT a security boundary** against a local attacker: the tenant `vaultAutoLockMinutes` is stored in App Group UserDefaults (plaintext, appropriate for a non-secret policy integer — Keychain is for secrets). A local attacker who can edit the plist can already read the wrapped keys/cache directly, so this adds no exposure. The enforced boundary that matters (refresh-token idle timeout) is server-side and not client-tamperable. iOS re-validates the server-supplied value to `[5,1440]`, rejecting 0/negative/absent to `nil` (fail-closed to the user setting) and clamping a malicious-large value to the org's own 1440 ceiling.
- **Biometric/offline unlock uses the last-persisted tenant policy** (does not refetch — by design it's the offline path). A server-side policy change is picked up on the next passphrase unlock. Documented limitation; matches the offline unlock design.
- **Override, not cap**: tenant value REPLACES the user interval (extension semantics), it is not a min/max envelope. The user's local choice is preserved untouched and restored when the policy is removed.
- **Out of scope**: a separate Sign Out in SettingsView (button lives in the ⋯ menu); session/absolute timeouts and other tenant-policy fields (only `vaultAutoLockMinutes`); RTL.

## User operation scenarios
- Unlocked → ⋯ → Sign Out → confirmation → confirm → returns to server-setup/sign-in; tokens + cache + bridge_key gone (must re-auth + re-unlock).
- Org sets 2h auto-lock: user unlocks → Settings shows "120 minutes"/「120 分」, picker disabled, "Set by your organization"; vault auto-locks after 2h of idle (NOT 60 min).
- Org removes the policy: user's next passphrase unlock restores their own 5/15/30/60 choice.

## Round 1 Review Resolutions (triangulate)

Three experts reviewed against the live codebase. Security: no Critical/Major (all Minor/informational, accepted with doc hardening). Functionality: 2 Major + 4 Minor. Testing: 1 Critical + 3 Major + 1 Minor. All folded in:
- **T1 (Critical) → C3**: the policyAuthoritative nil-distinction was buried in untestable SwiftUI `RootView`. Extracted into `AppSettingsStore.applyTenantPolicy(_:policyAuthoritative:)` (pure, unit-tested 3 branches); RootView is a thin caller.
- **T2/T3 (Major, R19) → C1/C2/C6**: adding stored properties breaks initializer call sites. `VaultUnlockData` gets an explicit defaulted-last memberwise init (zero test churn) + helper param; `UnlockResult` (no default) updates both prod sites (`:160` passphrase, `:217` biometric nil).
- **F1/T4 (Major) → C6**: existing `testAutoLockMinutesClamped` (100→60) conflicts with the clamp relaxation; update to 2000→1440 + 120→120 + 0→1.
- **F2 (Major) → C3**: third clamp site `LockState.swift:11` `[1,60]` (off live path, latent) relaxed to `[1,1440]` with the shared const.
- **F3 → C1**: synthesized Codable handles Optional null/absent — no hand-written `init(from:)`.
- **F4 → C3**: single clamp point; getter rejects out-of-range to `nil` (fail-closed), `effectiveAutoLockMinutes` has no second clamp.
- **F5 → C5**: enforced value renders via the `%lld minutes` plural key; the extra picker option is load-bearing (else blank).
- **F6 → C4**: named `@State` confirmation flag; dialog anchored at view level (not inside Menu).
- **S1/S3 → Considerations**: server idle-timeout (`IOS_TOKEN_IDLE_TIMEOUT_MS`) is the real backstop; DPoP-bound refresh token; client auto-lock labelled defense-in-depth, not a boundary.

**Round 2** verified F1–F6 + T1–T5 all correct, and both experts independently caught one consequence of the F2 fix: relaxing `LockState`'s clamp breaks a SECOND existing test (`LockStateReducerTests.testAutoLockMinutesClampedTo60`, 120→60) + leaves a stale docstring. Folded in (F7/T7 → C6 second test-update entry; F8 → C3 docstring). Directly verified the clamp-assertion sweep is now exhaustive (only `AutoLockServiceTests:304` + `LockStateReducerTests:70-72`; `AppSettingsStoreTests:56` tests the user `minutes` `[5,60]`, correctly unaffected). Plan **converged**.

## Go/No-Go Gate
| ID  | Subject                                                       | Status |
|-----|---------------------------------------------------------------|--------|
| C1  | Decode vaultAutoLockMinutes into VaultUnlockData (R1: F3/T2)  | locked |
| C2  | Thread tenant minutes through UnlockResult (R1: T3)          | locked |
| C3  | Persist + effective + clamp + testable decision (R1: T1/F2/F4)| locked |
| C4  | Sign Out button + confirmation (R1: F6)                      | locked |
| C5  | SettingsView org-enforced UI (R1: F5)                        | locked |
| C6  | i18n + tests + no regression (R1: T2/T3/T4/T5)              | locked |
