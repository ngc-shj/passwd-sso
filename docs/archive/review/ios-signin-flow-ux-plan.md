# Plan: iOS Sign-in Flow UX Improvement

## Project context

- **Type**: mixed (this change is iOS host-app only — Swift / SwiftUI under `ios/`)
- **Test infrastructure**: unit tests (XCTest, target `PasswdSSOTests`) + CI (`.github/workflows/ci.yml` runs `xcodebuild test` on an iOS Simulator). No iOS E2E.
- Mandatory checks for this change: `xcodegen generate` (from `ios/`) then `xcodebuild -project ios/PasswdSSO.xcodeproj -scheme PasswdSSOApp -destination 'platform=iOS Simulator,name=iPhone 16' test`. `scripts/pre-pr.sh` does **not** run iOS tests; the CI `ios-ci` job is authoritative.

## Objective

Cut the launch path for a returning, already-onboarded user from **URL → Sign-in button → passphrase (flicker) → list** down to **(Face ID / passphrase) → list**, by restoring the persisted session at launch instead of always starting at `.setup`. Three concrete fixes (user-confirmed):

1. **Skip the URL screen** when a server config is already persisted.
2. **Skip the Sign-in button screen** when valid tokens exist; on token expiry, attempt a silent refresh and only fall back to the Sign-in screen when the *session is dead*. **Delete the DEBUG "Load Test Vault" path entirely.**
3. **Remove the post-unlock flicker** where the passphrase screen lingers visibly while `handleVaultUnlocked` runs its async sync.

## Requirements

### Functional
- Cold launch decision (in `RootView`):
  - No persisted `ServerConfig` → URL setup screen (`.setup`). (First run only.)
  - `ServerConfig` present, **no** tokens in Keychain → Sign-in screen (`.signIn`) — URL screen skipped.
  - `ServerConfig` + tokens present + persisted DPoP SE key loadable:
    - access token still valid → unlock screen directly (auto Face ID).
    - access token expired → silent refresh:
      - success → unlock screen.
      - **dead session** (refresh rejected, e.g. family-revoke/replay) → Sign-in screen.
      - **offline** (network error) → unlock screen (offline biometric unlock against cached vault; sync retries later).
  - `ServerConfig` + tokens present but SE key missing → Sign-in screen.
- No URL screen flash on every launch: the initial state must be a neutral loading state, not `.setup`.
- After unlock succeeds, show a transitional loading state immediately so the passphrase/Face ID screen does not linger during sync.

### Non-functional
- **Offline-launch safe**: launch must never require network when the stored access token is still valid, and an offline refresh failure must NOT route to Sign-in.
- **No security regression**: a dead session must route to re-auth, never silently grant access to network resources. Local vault decryption already requires the bridge key + passphrase/biometric; offline cached-vault viewing of one's own data is acceptable and pre-existing behavior.
- **Testability**: the launch routing decision must be unit-testable without a real Secure Enclave or network — extract the decision behind injectable dependencies.

## Technical approach

### Current state (verified)
- `RootView` (`ios/PasswdSSOApp/Views/RootView.swift`) owns `@State private var appState: AppState = .setup` (line 35). There is **no** launch-time restoration — every cold launch walks `.setup → .signIn → .signedIn`.
- `AppState` cases: `.setup`, `.signIn(serverConfig, coordinator)`, `.signedIn(serverConfig, tokens, apiClient)`, `.vaultUnlocked(...)`, `.vaultLocked(serverConfig, apiClient)`.
  - `.signedIn` renders `vaultLockedScreen(autoPromptOnAppear: true)` (auto Face ID). Its `tokens` payload is **unused** (matched as `_` at line 53; constructed only at RootView:119,135).
- `ServerConfig` persistence: `loadServerConfig(defaults:)` / `saveServerConfig` in `ios/Shared/Models/ServerConfig.swift` (App Group `UserDefaults`, key `serverConfig`).
- Tokens: `HostTokenStore` (`ios/Shared/Storage/HostTokenStore.swift`) — `loadAccess() -> (token, expiresAt)?`, `loadRefresh() -> String?`, `deleteAll()`, per-app Keychain.
- DPoP SE key: persisted in Secure Enclave under label `com.passwd-sso.dpop.host`. `AuthCoordinator.currentSigner()/currentJWK()` (`ios/PasswdSSOApp/Auth/AuthCoordinator.swift:126-136`) **throw `keyGenerationFailed` until `loadedKey` is set**, and `loadedKey` is set **only** inside `startSignIn()` via the private `getOrCreateDPoPKey()`. → A returning launch that has not signed in cannot build a signing-capable API client. **This is the core blocker for silent refresh and is why C1 is required.**
- Token refresh: `MobileAPIClient.refreshToken()` is public; the proactive/lazy path `validAccessToken()` (private, `MobileAPIClient.swift:541`) returns the stored token with **no network call** when it is outside the 60s skew window, otherwise refreshes via the single-flight gate. Refresh taxonomy (verified at `doRefreshAndPersist`, lines 512-523): `.networkError` is passed through; every other failure maps to `.authenticationRequired`. This is exactly the offline-vs-dead distinction the routing needs.
- DEBUG path: `SignInView` (`onDebugVaultReady`, "Load Test Vault" button, `loadDebugVault()`), `RootView.makeSignInView` `#if DEBUG` branch + `handleDebugVaultLoaded`, and `DebugVaultLoader` (`ios/PasswdSSOApp/Debug/DebugVaultLoader.swift`). Grep confirms `DebugVaultLoader`'s only non-test, non-comment consumers are this DEBUG sign-in path → fully orphaned once removed.

### Design
1. **`AuthCoordinator.loadPersistedSigner()`** (C1): load the existing SE key into `loadedKey` **without generating** one. Absence ⇒ no prior session ⇒ caller routes to sign-in. Make the key label injectable via `init` (default = production label) so the load/absent branches are unit-testable on the simulator.
2. **`MobileAPIClient.ensureValidSession()`** (C2): public launch-time probe wrapping `validAccessToken()`; returns when a usable token is available (valid or refreshed), throws `.authenticationRequired` for a dead session, `.networkError` when offline. No network call when the stored token is still valid.
3. **`SessionRestorer`** (C3): a `Sendable` struct whose routing logic is expressed over **injected closures** (config load, token presence, session build, session validation), with production defaults wiring the real types. Returns `RestoredSession` (`.needsSetup` / `.needsSignIn(ServerConfig)` / `.needsUnlock(ServerConfig, MobileAPIClient)` / `.needsReauth(ServerConfig, MobileAPIClient)`). The routing matrix is the unit-tested unit.
4. **`AppState` changes** (C4): add `.launching` (new initial state, neutral loading) and `.unlocking` (post-unlock transitional loading); drop the unused `tokens` payload from `.signedIn`.
5. **`RootView` wiring** (C5): initial state `.launching`; a `.task` runs `SessionRestorer.restore()` once and maps `RestoredSession → AppState`; `.launching` and `.unlocking` render a `ProgressView` splash; `handleVaultUnlocked` sets `appState = .unlocking` as its first statement so the passphrase/Face ID screen is replaced immediately.
6. **DEBUG removal** (C6): delete the DEBUG sign-in wiring and the now-orphaned `DebugVaultLoader.swift` + `DebugVaultLoaderTests.swift`; fix the stray doc comment in `VaultViewModel.swift:56`.

## Contracts

### C1 — `AuthCoordinator.loadPersistedSigner()` + injectable key label + injectable key loader
**File**: `ios/PasswdSSOApp/Auth/AuthCoordinator.swift`

- Change `private let dpopKeyLabel = "com.passwd-sso.dpop.host"` to an init-injected stored property defaulting to that literal, **and** inject the key-load seam (resolves the simulator-testability problem — see note below):
  - `init(serverConfig: ServerConfig, tokenStore: HostTokenStore = HostTokenStore(), dpopKeyLabel: String = "com.passwd-sso.dpop.host", keyLoader: (@Sendable (String) throws -> SecKey)? = nil)`
  - Store `self.keyLoader = keyLoader ?? { label in try loadDPoPKey(label: label) }` (default arg cannot reference `self.dpopKeyLabel`, so resolve in the init body).
- New method:
  - `public func loadPersistedSigner() -> Bool` (synchronous, actor-isolated; called from outside as `await coordinator.loadPersistedSigner()`) — body: `if let existing = try? keyLoader(dpopKeyLabel) { loadedKey = existing; return true }; return false`. MUST NOT call `generateDPoPKey`.
  - The non-empty-label guard goes in `init` (`precondition(!dpopKeyLabel.isEmpty, "dpopKeyLabel must not be empty")`), NOT in `loadPersistedSigner()` — it is an invariant on the injected parameter, fires once at construction, and avoids a per-call `precondition` that would terminate the process from a hot path. (F13)
- **Concurrency note (F14)**: `SecKey` is a CoreFoundation type that does not conform to `Sendable`, so `keyLoader: @Sendable (String) throws -> SecKey` may trip Swift 6 strict-concurrency depending on `SWIFT_STRICT_CONCURRENCY`. Phase 2 checks the target's setting; if flagged, wrap the return in an `@unchecked Sendable` box (precedent: `SendableSecKey` in `AuthCoordinatorTests.swift:109`) or store the closure `nonisolated(unsafe)`. The existing actor already holds `loadedKey: SecKey?` and `SecureEnclaveDPoPSigner` is `@unchecked Sendable`, so the project clearly already tolerates `SecKey` across isolation with a wrapper — reuse that pattern.
- **Why the `keyLoader` seam is mandatory (testability)**: the real `loadDPoPKey(label:)` (`Shared/Crypto/SecureEnclaveKey.swift:54`) filters on `kSecAttrTokenID: kSecAttrTokenIDSecureEnclave`. The simulator-only software keys produced by `AuthCoordinatorTests.makeSoftwareP256Key` are created **without** that token-ID (and with `kSecAttrIsPermanent: false`), so `loadDPoPKey` can never find them. Without the seam, the "key found → coordinator ready" branch of `loadPersistedSigner()` is untestable on the simulator/CI. The injected `keyLoader` lets T3 return a software key directly.
- **Invariants**:
  - `loadPersistedSigner()` never creates a key (absence is a routing signal, not an error).
  - After `loadPersistedSigner()` returns `true`, `currentSigner()` and `currentJWK()` succeed.
  - The production label literal and the production `keyLoader` (`loadDPoPKey`) are unchanged (existing sessions keep working).
  - `dpopKeyLabel` is non-empty (precondition; the only non-default callers are the `.live` factory and tests).
- **Acceptance**:
  - `keyLoader` that throws (key absent) → returns `false`, `loadedKey` stays nil, `currentSigner()` still throws.
  - `keyLoader` that returns a (software) key → returns `true`, `currentSigner()`/`currentJWK()` succeed.

### C2 — `MobileAPIClient.ensureValidSession()`
**File**: `ios/PasswdSSOApp/Network/MobileAPIClient.swift`

- New method:
  - `public func ensureValidSession() async throws` — body: `_ = try await validAccessToken()`.
- **Invariants**:
  - Makes **no** network request when the stored access token is outside the refresh-skew window (offline-launch safe). (Inherited from `validAccessToken`.)
  - Propagates `MobileAPIError.networkError` unchanged on offline refresh failure; surfaces `MobileAPIError.authenticationRequired` for a dead/missing session. (Inherited from `doRefreshAndPersist`.)
  - Does not change `validAccessToken`'s existing single-flight / persistence behavior.
- **Acceptance**:
  - Valid stored token → returns without any URLProtocol request (assert request count 0).
  - Expired token + refresh 200 → returns; rotated pair persisted (assert new access token in store).
  - Expired token + refresh 401 → throws `.authenticationRequired`.
  - Expired token + transport error → throws `.networkError`. **The test MUST make `MockURLProtocol.requestHandler` throw a concrete `URLError` (e.g. `throw URLError(.notConnectedToInternet)`), NOT an `NSError`.** `performHTTP` only maps to `MobileAPIError.networkError` via `catch let urlError as URLError`; an `NSError` (even in `NSURLErrorDomain`) fails that cast and is remapped to `.authenticationRequired` by `doRefreshAndPersist`, so the test would silently validate the dead-session path instead of the offline path. (T2f)

### C3 — `SessionRestorer`
**File (new)**: `ios/Shared/Session/SessionRestorer.swift` (or `ios/PasswdSSOApp/Auth/SessionRestorer.swift` — see open question O1)

```
public enum RestoredSession: Sendable {
  case needsSetup
  case needsSignIn(ServerConfig)                  // no local unlock material → OAuth required
  case needsUnlock(ServerConfig, MobileAPIClient) // session usable (or offline) → auto-Face-ID unlock
  case needsReauth(ServerConfig, MobileAPIClient) // refresh failed but local vault material exists → unlock-or-resign-in
}

public enum SessionValidation: Sendable { case ok, offline, dead }

public struct SessionRestorer: Sendable {
  // Injected seams (production defaults wire the real types):
  var loadConfig: @Sendable () -> ServerConfig?
  var hasTokens: @Sendable () -> Bool                                   // access AND refresh present
  var makeSession: @Sendable (ServerConfig) async -> MobileAPIClient?   // loads SE signer; nil if key absent
  var validate:    @Sendable (MobileAPIClient) async -> SessionValidation

  public func restore() async -> RestoredSession
}
```

- **Routing (the tested logic)**:
  1. `loadConfig() == nil` → `.needsSetup`
  2. `!hasTokens()` → `.needsSignIn(config)`
  3. `makeSession(config) == nil` (SE key gone OR signer/JWK export failed) → `.needsSignIn(config)`
  4. `validate(client)`:
     - `.ok` → `.needsUnlock(config, client)`
     - `.offline` → `.needsUnlock(config, client)`
     - `.dead` → `.needsReauth(config, client)`
- **Why `.needsReauth` is distinct from `.needsSignIn` (the core fork)**: cases 2–3 (`.needsSignIn`) have **no local unlock material** (no tokens, or the SE signer is gone) → the only way forward is a full OAuth sign-in. Case 4 (`.needsReauth`) still has tokens + a working SE signer + (typically) a bridge key, so the vault **can** be unlocked locally even though the network session is unusable. The dead-vs-transient signal is irreducibly ambiguous at launch (see below), so `.needsReauth` routes to a screen that serves **both**: biometric/passphrase unlock of the cached vault (a transient `5xx` recovers on the next sync; the user reads their data meanwhile) **and** a prominent "Sign in again" affordance (a genuine revoke re-establishes the session). This is the existing `.vaultLocked` screen.
- **`restore()` performs NO destructive cleanup, and neither does the consumer** (S7 resolution). No arm calls `clearTenantPolicy()` / `CredentialIdentityRegistrar().clear()` / `deleteAll()`. Rationale: the refresh ladder collapses **every** non-network failure — genuine dead-session (401/replay), transient `5xx`, and `429` — into `MobileAPIError.authenticationRequired` (`doRefreshAndPersist`, MobileAPIClient.swift:512-523; verified: `decodeResponse` maps 5xx→`.serverError`, 429→`.rateLimited`, then the wrapper remaps every non-`networkError` to `.authenticationRequired`). `validate` therefore cannot tell a revoked session from a momentary server hiccup. An **irreversible** tenant-policy/QuickType wipe on that ambiguous signal would destroy a still-valid session's state on a single 500/503/429 at launch. Routing `.dead` to the unlock-or-resign-in screen is non-destructive and recoverable; the wipe stays on the explicit Sign-Out path (`AutoLockService.loggedOut` → RootView:75-82), and tenant policy + QuickType refresh on the next successful unlock.
- **Production default wiring** (a static factory, e.g. `SessionRestorer.live(defaults:tokenStore:)`):
  - `loadConfig` = `{ loadServerConfig(defaults:) }`
  - `hasTokens` = `{ (try? tokenStore.loadAccess()) != nil && (try? tokenStore.loadRefresh()) != nil }` — the `try?` is intentional: a Keychain decode/access error becomes `false` → routes to `.needsSignIn` rather than throwing out of a non-throwing closure. Do NOT change `try?` to `try`. (F11)
  - `makeSession` = build `AuthCoordinator`; `guard await coordinator.loadPersistedSigner() else { return nil }`; then `let signer = try? await coordinator.currentSigner()`, `let jwk = try? await coordinator.currentJWK()` (both are actor-isolated → **`await` is required**; F1); `guard let signer, let jwk else { return nil }`; build `MobileAPIClient(serverURL:, signer:, jwk:, tokenStore:)`. Mirror `RootView.buildRealAPIClient` (RootView:359) but return `nil` on missing signer instead of substituting `NoOpDPoPSigner` — for restoration a missing signer means re-auth, not a no-op client.
  - `validate` = `{ client in do { try await client.ensureValidSession(); return .ok } catch MobileAPIError.networkError { return .offline } catch { return .dead } }` — `.networkError` (offline) is the only branch that maps to `.offline`; **every other failure (dead session, 5xx, 429) maps to `.dead` → `.needsReauth` → `.vaultLocked`** (acceptable because the consumer does no destructive cleanup, and `.vaultLocked` serves both local unlock and "Sign in again"; see the S7 resolution above and Considerations).
- **Invariants**:
  - `validate` is called **only** in branch 4 (after config + tokens + signer confirmed). Offline never downgrades to `.needsSignIn`.
  - `SessionRestorer` performs no token mutation and touches no app-settings/identity state itself (refresh-and-persist stays inside `MobileAPIClient`).
- **Forbidden**: `pattern: tokenStore.deleteAll\(\)` / `pattern: clearTenantPolicy` / `pattern: CredentialIdentityRegistrar` inside `SessionRestorer` OR the `RootView` launch-restore mapping — reason: restoration must not wipe tokens, tenant policy, or QuickType identities (the dead-vs-transient signal is ambiguous; wiping on a server blip corrupts a valid session). Cleanup stays on the explicit Sign-Out path.
- **Acceptance** (routing matrix): see Testing strategy T1.

### C3 consumer-flow walkthrough (mandatory — `RestoredSession` is consumed outside the producer)
- **Consumer: `RootView.task` mapping** (path: `ios/PasswdSSOApp/Views/RootView.swift`) reads `RestoredSession` and:
  - `.needsSetup` → sets `appState = .setup` (reads nothing else).
  - `.needsSignIn(config)` → reads `config`; constructs `AuthCoordinator(serverConfig: config, tokenStore: HostTokenStore())`; sets `appState = .signIn(serverConfig: config, coordinator:)`. **No destructive cleanup** (S7 resolution). Needs only `ServerConfig` — satisfied.
  - `.needsUnlock(config, apiClient)` → reads `config` and `apiClient`; sets `appState = .signedIn(serverConfig: config, apiClient: apiClient)` (post-C4 signature, no tokens; auto-Face-ID unlock). Needs `ServerConfig` + a signing-capable `MobileAPIClient` — both present; the `apiClient` carries the loaded SE signer so the subsequent passphrase-unlock network call and `handleVaultUnlocked` sync can DPoP-sign. Satisfied.
  - `.needsReauth(config, apiClient)` → reads `config` and `apiClient`; sets `appState = .vaultLocked(serverConfig: config, apiClient: apiClient)` (the existing unlock-or-resign-in screen: biometric/passphrase unlock of the cached vault **plus** the "Sign in again" button). **No destructive cleanup.** Needs `ServerConfig` + `MobileAPIClient` — both present; `apiClient` carries the SE signer so a successful local unlock's `handleVaultUnlocked` sync can still DPoP-sign (and will succeed once a transient server error clears). Satisfied.
- No consumer needs a field absent from `RestoredSession`. The `apiClient` returned for `.needsUnlock`/`.needsReauth` is the **same instance** validated by `validate`, so its single-flight refresh state carries into `handleVaultUnlocked`.

### C4 — `AppState` shape change
**File**: `ios/PasswdSSOApp/Views/RootView.swift`

- Add `case launching` (rendered as splash; the new initial value).
- Add `case unlocking` (rendered as splash; transitional, set at the top of `handleVaultUnlocked`).
- Change `case signedIn(serverConfig: ServerConfig, tokens: TokenPair, apiClient: MobileAPIClient)` → `case signedIn(serverConfig: ServerConfig, apiClient: MobileAPIClient)` (drop unused `tokens`).
- **Invariants**:
  - `handleVaultUnlocked` always terminates by assigning a non-`.unlocking` state (today: `.vaultUnlocked` at line 322) so the splash cannot stick.
  - `.launching` is only ever the pre-restore state; `restore()`'s result always replaces it.
  - The single `switch appState` in `RootView.body` (RootView:42 — grep-confirmed the **only** consumer of `AppState`) MUST gain arms for `.launching` and `.unlocking`. `AppState` has no `@unknown default`, so omitting either is a compile error (exhaustiveness-enforced). List this switch update explicitly as part of C5. (F12)
- **Forbidden patterns**:
  - `pattern: appState: AppState = .setup` — reason: initial state must be `.launching`, not `.setup` (avoids URL-screen flash).
  - `pattern: \.signedIn\([^)]*tokens:` — reason: `.signedIn` no longer carries `tokens`.
- **Acceptance**: project compiles; the only `.signedIn` matches in the host target are the post-C4 2-arg form; `AppState` has `launching` and `unlocking`.

### C5 — `RootView` restoration + flicker fix
**File**: `ios/PasswdSSOApp/Views/RootView.swift`

- `@State private var appState: AppState = .launching`.
- Render `.launching` and `.unlocking` as a centered `ProgressView` (a `passwd-sso` splash; reuse existing branding).
- Add a `.task` on the root `Group` that runs once:
  - `guard case .launching = appState else { return }` (avoid re-running on later view re-appears). (F5)
  - `let result = await SessionRestorer.live(...).restore()`
  - map `result → appState` per the C3 consumer walkthrough (a plain 3-case switch; no destructive cleanup in any arm).
- `handleVaultUnlocked(...)`: set `appState = .unlocking` as the **first** statement (it is already `@MainActor`). This replaces the passphrase/Face ID screen with the splash before the `await drain.drainPendingFlags` / `runSync` work. Add an inline comment: `// MUST be the first statement — regression guard for the post-unlock flicker fix (#3); do not move below the first await.` (T5 — there is no automated test for this ordering since RootView has no unit harness.)
- Replace `makeSignInView` with a single (non-`#if DEBUG`) `SignInView(coordinator:, onSignedIn:)` factory (C6 removes the DEBUG branch).
- **Re-point the `.vaultLocked` "Sign in again" button** (RootView:95-97) from `appState = .setup` to `appState = .signIn(serverConfig: config, coordinator:)` — constructing a fresh `AuthCoordinator(serverConfig: config)` (the `.vaultLocked` case already binds `serverConfig`). This skips the URL screen on explicit re-auth (consistent with the whole skip-URL goal) and is the destination for the new `.needsReauth` launch route. It also improves the existing in-app-lock → "Sign in again" path (config is already known). Acceptance: tapping "Sign in again" lands on the OAuth sign-in screen, never the URL setup screen.
- **Acceptance**:
  - On cold launch with persisted config+valid tokens, no URL screen and no Sign-in screen are shown (state goes `.launching → .signedIn → .unlocking → .vaultUnlocked`).
  - On cold launch with no config, `.launching → .setup`.
  - During unlock, the passphrase screen is replaced by the splash before list appears (no lingering passphrase screen).

### C6 — Remove the DEBUG sign-in button + wiring (KEEP `DebugVaultLoader` + its test)
**Decision (T4)**: remove only the user-facing DEBUG sign-in path (the user's request: "完全に削除" the button). **Do NOT delete `DebugVaultLoader.swift` or `DebugVaultLoaderTests.swift`** — `DebugVaultLoaderTests` is the **only** end-to-end test exercising the surviving production decrypt round-trip (`CredentialResolver.resolveCandidates` + `decryptEntryDetail`, AAD construction, AES-GCM helpers, `OverviewBlobPayload`/`FullBlobPayload` decode). Deleting it would leave the core AutoFill credential-delivery path with no integration coverage. `DebugVaultLoader` is `#if DEBUG`, has no App-Store footprint, and after this change is referenced only by its own test — an acceptable DEBUG-only fixture.

**Files**:
- `ios/PasswdSSOApp/Views/SignInView.swift`: remove the `onDebugVaultReady` property, the `#if DEBUG` "Load Test Vault" button, and `loadDebugVault()`. `SignInView` keeps `coordinator` + `onSignedIn`.
- `ios/PasswdSSOApp/Views/RootView.swift`: collapse `makeSignInView` to a single non-`#if DEBUG` `SignInView(coordinator:, onSignedIn:)`; delete the `handleDebugVaultLoaded(...)` method and its `#if DEBUG` block.
- `ios/PasswdSSOApp/Debug/DebugVaultLoader.swift`: **keep unchanged.**
- `ios/PasswdSSOTests/DebugVaultLoaderTests.swift`: **keep unchanged** (preserves CredentialResolver round-trip coverage — RT2).
- `ios/PasswdSSOApp/Views/Vault/VaultViewModel.swift:56`: minor clarification — `DebugVaultLoader` now writes this cache shape only as a **test fixture** (no production caller after the button removal). Adjust the comment to read e.g. `HostSyncService writes this shape in production; DebugVaultLoader writes it as a test fixture.` so it doesn't imply two production writers. (F15)
- **Forbidden patterns** (must not appear anywhere in `ios/` after the change):
  - `pattern: onDebugVaultReady` — reason: DEBUG callback removed.
  - `pattern: Load Test Vault` — reason: button removed.
  - `pattern: handleDebugVaultLoaded` — reason: method removed.
  - (`DebugVaultLoader` is intentionally NOT forbidden — the type + its test survive.)
- **Pre-change grep gate** (Phase 2): `grep -rn 'onDebugVaultReady\|loadDebugVault\|handleDebugVaultLoaded' ios --include='*.swift'` enumerates exactly the SignInView + RootView sites to edit; after the edits it returns zero. `grep -rn 'DebugVaultLoader' ios --include='*.swift'` should afterwards match only `DebugVaultLoader.swift`, `DebugVaultLoaderTests.swift`, and the `VaultViewModel.swift:56` comment.
- **Acceptance**: project + tests compile in both Debug and Release configs; the three forbidden patterns return zero matches; `DebugVaultLoaderTests` still runs and passes.

## Testing strategy

- **T1 — `SessionRestorerTests` (new, `ios/PasswdSSOTests/SessionRestorerTests.swift`)**: inject fakes for the four seams; assert the full routing matrix:
  - no config → `.needsSetup`
  - config, no tokens → `.needsSignIn`
  - config, tokens, `makeSession`→nil (SE key gone) → `.needsSignIn`
  - config, tokens, `makeSession`→nil (signer/JWK export failed — a **distinct fixture** from the key-gone case; guards against a future `makeSession` that throws) → `.needsSignIn` (T1f2)
  - config, tokens, session, `validate`=`.ok` → `.needsUnlock`
  - config, tokens, session, `validate`=`.offline` → `.needsUnlock`
  - config, tokens, session, `validate`=`.dead` → `.needsReauth`
  - Plus: `validate` is **not** invoked when config/tokens/session preconditions fail. The call-count spy MUST be a reference type — `actor CountSpy { var n = 0 }` or `final class CountSpy { ... }` — because a `@Sendable` closure cannot capture a mutable `var` local without `nonisolated(unsafe)`; document the pattern in the test file. (T1f3)
- **T2 — `MobileAPIClient.ensureValidSession` tests** (extend `MobileAPIClientTests.swift`, reuse `MockURLProtocol` + `FakeSigner` + `FakeKeychain` + injectable `now()`): the four C2 acceptance cases. The offline (`.networkError` passthrough) case is the new-coverage one and MUST throw a `URLError` from the mock handler (see C2 acceptance, T2f) — the existing suite already covers valid/expired/401 for `validAccessToken`. Reset `MockURLProtocol.requestHandler` in `setUp()` (it is `nonisolated(unsafe) static var` — follow the existing pattern; RT5).
- **T3 — `AuthCoordinator.loadPersistedSigner` tests** (extend `AuthCoordinatorTests.swift`): inject the new `keyLoader` seam (C1). A loader that throws → `loadPersistedSigner()` returns `false` and `currentSigner()` still throws; a loader returning a `makeSoftwareP256Key` key → returns `true` and `currentSigner()`/`currentJWK()` succeed. **Do NOT test via the real `loadDPoPKey`/`generateDPoPKey`** — its `kSecAttrTokenIDSecureEnclave` filter cannot see simulator software keys (T1f), and real `generateDPoPKey` with `kSecAttrIsPermanent: true` would persist across runs (if ever used in a test, add `deleteDPoPKey(label:)` in `tearDown`; RT3). The `keyLoader` seam avoids the Keychain entirely.
- Build verification: `xcodegen generate` then `xcodebuild ... -scheme PasswdSSOApp test` (Debug). Also a Release build (`-configuration Release build`) to confirm the DEBUG-button removal did not leave a Release-only reference.
- **Regression coverage preserved**: `DebugVaultLoaderTests` is **kept** (C6) so the `CredentialResolver` decrypt round-trip stays covered (RT2).
- **Not unit-tested** (documented): `RootView` `.task` wiring, the `RestoredSession → AppState` mapping (a plain 3-case switch with no destructive side effects), and the `.launching`/`.unlocking` splash rendering are SwiftUI view-state with no existing RootView test harness; the routing decision they consume is covered by T1, and the flicker-fix ordering is guarded by the mandatory inline comment in C5. Per project context (no iOS E2E), this is an informational note, not a finding.

## Considerations & constraints

- **Offline launch correctness is the highest-risk axis.** The `.offline → .needsUnlock` branch is what keeps subway launches working; a regression that routes offline to `.needsSignIn` would lock users out of their cached vault. T1 pins this; C2's no-network-when-valid invariant pins the common case.
- **Dead-session handling does not wipe tokens** (forbidden pattern in C3). Routing to `.signIn` is sufficient; a successful OAuth overwrites the stale pair. Worst case of leaving a dead refresh token: it is server-side revoked and useless; likelihood: only after family-revoke/replay; cost to wipe vs. keep: negligible either way — we keep to avoid deleting state an offline pass might still need. This mirrors the existing `.vaultLocked` "Sign in again" path which also does not wipe.
- **Launch restoration performs NO destructive cleanup of tenant policy / QuickType identities (S7 resolution; S1 residual accepted)**. The refresh ladder collapses dead-session (401/replay), transient `5xx`, and `429` all into `MobileAPIError.authenticationRequired` (`doRefreshAndPersist`, MobileAPIClient.swift:512-523) — verified: `decodeResponse` maps 5xx→`.serverError`, 429→`.rateLimited`, then `doRefreshAndPersist` remaps every non-`networkError` to `.authenticationRequired`. So a launch-time `validate` cannot tell a genuinely-revoked session from a momentary server hiccup. An eager `clearTenantPolicy()` + `CredentialIdentityRegistrar().clear()` on that ambiguous signal would **irreversibly** corrupt a still-valid session's state on a single 500/503/429 at launch (S7, Critical if implemented). Resolution: launch never wipes; `.dead` routes to `.needsReauth` → `.vaultLocked` (non-destructive, unlock-or-resign-in). Residual S1 risk — a genuinely revoked user's device keeps stale QuickType suggestions + a stale tenant-policy value until the next event: worst case = the user's *own* credential metadata (usernames/sites) appears as inline AutoFill suggestions on their own device; **the QuickType store holds only metadata (host/username/record-UUID), no secrets, and the fill path gates on a fresh Face ID/Touch ID challenge (`BridgeKeyStore.readForFillAuthenticated`, biometric — not a network session) before any blob is decrypted**, so a stale identity cannot deliver a credential without the device owner's biometric auth; likelihood = only between server-revoke and the user's next sign-out/successful-unlock; cost-to-fix-properly = high (would require de-conflating 5xx from 401 deep in the shared refresh ladder, rippling through every `performAuthedGET` caller). Tenant policy + QuickType both refresh on the next successful unlock, and explicit Sign Out clears both. Accepted; matches the existing `.vaultLocked` re-auth precedent. (S1, S7, S8, S9)
- **A transient server `5xx`/`429` at launch is handled gracefully without forcing OAuth** (this is why `.dead` routes to `.needsReauth`/`.vaultLocked`, not `.needsSignIn`). The user can biometric-unlock the cached vault and keep working; the next sync retries and succeeds once the server recovers. A genuine revoke is handled by the same screen's "Sign in again" button. This removes the earlier "transient blip bounces to OAuth" wart — there is no remaining TODO for launch routing.
- **SE key availability at launch**: the persisted key survives reinstall-less launches; a Keychain reset (rare) makes `loadPersistedSigner()` return false → `.needsSignIn` (no local unlock material), which is correct (tokens without a signer are unusable).
- **SE DPoP key is not biometric-gated (accepted trade-off, not a regression)**: the host DPoP key is created with `.privateKeyUsage` + `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` and **no** user-presence/biometry flag (`SecureEnclaveKey.swift:21-28`), so launch-time silent refresh can DPoP-sign without a biometric prompt. This matches every existing foreground DPoP request and is required for the offline/silent-launch goal; gating it on biometrics would force a Face ID prompt on every refresh and break offline launch. The vault key remains separately gated (bridge key + passphrase/biometric in `VaultUnlocker`), so a silent refresh yields at most a fresh access token for a still-locked vault — no plaintext credential exposure. Worst case: an attacker who already has device-unlock can mint an access token; likelihood: requires device-unlock (same precondition as reading the Keychain at all); cost to change: high + conflicts with requirements → accept. (S2)
- **`buildRealAPIClient` (RootView:359)** already builds a client from `coordinator.currentSigner()`; `SessionRestorer.makeSession` follows the same pattern but with `loadPersistedSigner()` first. Phase 2 should reuse `buildRealAPIClient`'s shape (do not duplicate the NoOp fallback semantics — for restoration a missing signer means `.needsSignIn`, not a NoOp client).
- **Skipping the server probe is not a pinning regression (pre-existing gap, tracked as a separate plan)**: `ServerURLSetupView.probeServer` only checks HTTP reachability — it never computes or stores `ServerConfig.pinnedAASAHash` / `pinnedTLSSPKIHash`, which are always persisted `nil` (`ServerConfig.swift:7-9`; `continueButtonTapped` builds `ServerConfig(baseURL:)`). TOFU pinning is modeled but not implemented, so skipping the setup screen on returning launches bypasses no enforced check. Implementing TLS-SPKI / AASA pinning (capture-on-first-use in the probe + a pin-verify step in the launch-restore path, or removing the vestigial fields) is an orthogonal security feature, **carved out into its own plan** (`ios-tofu-pinning`, to be created) rather than expanding this UX change. (S5)
- **Out of scope**: changing the server URL after onboarding (only via Sign Out → `.setup`, or "Sign in again" → `.signIn`); proactive background token refresh; TOFU pinning (separate `ios-tofu-pinning` plan, above); team key pipeline (tracked separately in `ios-team-quicktype`). The release-please `MARKETING_VERSION` bump is automated and not touched here.

## User operation scenarios

1. **Returning user, app reopened minutes later (token valid)**: `.launching` splash → Face ID sheet → splash → list. No URL, no Sign-in, no passphrase flicker.
2. **Returning user next morning (access token expired, refresh valid)**: `.launching` → silent refresh (200) → Face ID → splash → list.
3. **Returning user on the subway (offline, token expired)**: `.launching` → refresh transport error → `.offline` → Face ID (offline, local decrypt) → splash → cached list. Sync silently retries when network returns.
4. **Session revoked server-side (admin reset / replay)**: `.launching` → refresh fails → `.dead` → `.needsReauth` → `.vaultLocked` (unlock-or-resign-in screen). The user can biometric-unlock to read cached data, then tap **"Sign in again"** → `.signIn` (URL skipped) → OAuth re-establishes the session. No tenant-policy/QuickType wipe (S7).
4b. **Transient server `5xx`/`429` at launch (still-valid session)**: identical routing to (4) since the failure is indistinguishable — `.dead` → `.vaultLocked`. But here the user just biometric-unlocks; the next sync succeeds once the server recovers, and "Sign in again" is never needed. Non-destructive, no forced OAuth.
5. **Brand-new install**: `.launching` → no config → URL screen → probe → Sign-in → OAuth → first passphrase unlock (Face ID button hidden until bridge key exists) → splash → list.
6. **Signed in but app killed before first unlock (tokens present, no bridge key)**: `.launching` → `.needsUnlock` → passphrase screen (no Face ID button, since `biometricUnlockAvailable()` requires a bridge key) → first passphrase unlock calls `/api/vault/unlock/data` (network) → splash → list. **Offline in this specific case is unrecoverable**: there is no bridge key and no cached vault yet, so the passphrase screen surfaces a "check your connection" error and the vault cannot be opened until network returns. This is pre-existing behavior (the first unlock has always required the server); biometric + offline access only become available after the first successful passphrase unlock establishes the bridge key. The acceptance criterion for this scenario is "network error shown offline", not "list reachable offline". (F4)

## Open questions

- **O1**: Place `SessionRestorer` in `ios/Shared/Session/` (reusable, matches `Shared/Storage`, `Shared/Models`) vs. `ios/PasswdSSOApp/Auth/`. It depends on `MobileAPIClient`/`AuthCoordinator`, which live in `PasswdSSOApp`, not `Shared` → it likely must live in `PasswdSSOApp` (Shared cannot import the app target). **Tentative decision: `ios/PasswdSSOApp/Auth/SessionRestorer.swift`.** Phase 2 confirms the module boundary before placing the file.

## Go/No-Go Gate

| ID | Subject                                                          | Status |
|----|-----------------------------------------------------------------|--------|
| C1 | `AuthCoordinator.loadPersistedSigner()` + injectable key label  | locked |
| C2 | `MobileAPIClient.ensureValidSession()` public probe             | locked |
| C3 | `SessionRestorer` struct + `RestoredSession`/`SessionValidation`+ routing | locked |
| C4 | `AppState` adds `.launching`/`.unlocking`, drops `.signedIn` tokens | locked |
| C5 | `RootView` `.task` restoration wiring + `.unlocking` flicker fix | locked |
| C6 | Delete DEBUG sign-in path + orphaned `DebugVaultLoader`          | locked |
