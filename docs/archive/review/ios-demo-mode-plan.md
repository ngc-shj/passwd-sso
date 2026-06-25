# Plan: iOS Demo Mode (App Store Guideline 2.1 remediation)

> Round 2 (post plan-review). Core change: demo no longer reuses the live
> `VaultListView`; it renders a **dedicated `DemoVaultView`** that wires only the
> pure rendering subviews over an in-memory cache. This makes NFR1 (no
> shared-state writes) a **structural** property — the demo view has no
> `apiClient`/`hostSyncService`/`FaviconLoader`/Settings code path to gate — rather
> than a "remembered to guard every site" property. Resolves F1, S1, S2, S3, T4, T5.

## Project context

- **Type**: mixed — iOS SwiftUI app (host + AutoFill extension) in a monorepo that also holds the Next.js web/server. This plan touches **only** the iOS host app target.
- **Test infrastructure**: pure XCTest under `ios/PasswdSSOTests` (no Swift Testing, no snapshot library, empty `PasswdSSOUITests` target), runnable via `xcodebuild test -scheme PasswdSSOApp -destination 'id=<sim udid>'` (~526 tests). Established isolation idiom: **inject a temp dir / `MockKeychainAccessor`** — tests never touch the real App Group container (confirmed: zero tests reference `AppGroupContainer.cacheFileURL()`).
- **Verification environment constraints**:
  - **VEC1 — App Store reviewer device**: review happens on iPad Air (M3) despite `TARGETED_DEVICE_FAMILY=1` (iPhone-only). Demo Mode UI must render correctly in iPhone-compatibility (scaled) mode. Classify: `verifiable-local` (run the iPhone scheme on an iPad simulator).
  - **VEC2 — Real App Store review outcome**: cannot be verified locally; only re-submission confirms. Classify: `blocked-deferred`. Anti-Deferral: worst case = second 2.1 rejection (cost: ~24-48h review cycle); likelihood = low (Apple explicitly recommends demo mode); cost to fully de-risk locally = impossible (no reviewer access). Mitigation: maximize feature visibility + reviewer note.
  - **VEC3 — AutoFill QuickType interaction**: cannot exercise the *positive* path on a simulator (third-party AutoFill provider is unselectable in simulator Settings — memory `ios-autofill-host-entitlement`). Classify: `blocked-deferred` for the positive path. The *negative* invariant this plan needs (demo MUST NOT register QuickType identities) is `verifiable-local` — `DemoVaultView` structurally contains no `CredentialIdentityRegistrar` reference (grep gate, C2).

## Objective

Add a user-facing **Demo Mode** to the iOS host app so an App Store reviewer (or any prospective user) can explore the vault UI with realistic sample data **without** a server, account, OAuth sign-in, or master passphrase. Remediates the Guideline 2.1 rejection (reviewer could not sign in via SSO).

## Requirements

### Functional
- FR1: The sign-in screen (and the first-launch server-URL screen) shows a persistent **"Try Demo Mode"** affordance. Tapping it enters a demo vault populated with bundled sample data, with **zero** network calls and **zero** credentials.
- FR2: The demo vault shows all 8 entry types (login×2, credit card, identity, passkey, secure note, bank account, software license, SSH key), each **correctly classified** (browsable in the category grid + entry list + search), each opening a **type-correct** detail (card fields for cards, public key/fingerprint for SSH, etc.). TOTP code display/copy works for entries carrying a TOTP secret.
- FR3: An **"Exit Demo"** affordance returns to the sign-in/setup screen and leaves **no** residual demo state anywhere the real app or AutoFill extension can observe it.
- FR4: Demo Mode is reachable and renders on the App-Store-review device (iPad-compatibility rendering of the iPhone-only app).

### Non-functional
- NFR1 (**isolation, paramount — now structural**): Demo Mode MUST NOT write to, and `DemoVaultView` MUST NOT even *reference*, the shared App Group cache file (`AppGroupContainer.cacheFileURL()` / `writeCacheFile`), the shared Keychain bridge key (`BridgeKeyStore`), the shared wrapped-key store (`AppGroupWrappedKeyStore` / `saveVaultKey`), the host token store (`HostTokenStore`), the favicon cache + fetch (`FaviconLoader`), the OS QuickType store (`CredentialIdentityRegistrar`), or `HostSyncService` (`runSync`). A real user with a real vault and/or the AutoFill extension enabled must see no change to data, suggestions, or settings from anyone using Demo Mode.
- NFR2: Demo Mode MUST make **no** network request. (Structurally guaranteed: `DemoVaultView` holds no `apiClient`.)
- NFR3: Sample data is bundled in code (no download). Sample secrets are obviously fake — usernames use RFC 2606 reserved domains (`example.com`/`.org`/`.net`); the only "working" secret is the universally-published TOTP test seed `JBSWY3DPEHPK3PXP` (intentional, so TOTP display demos correctly). The Bitwarden-compat export `docs/assets/passwd-sso.json` is **not** consumed at runtime and **not** added to the app bundle's Copy-Resources phase.

## Technical approach

### Why a dedicated DemoVaultView, not a reused VaultListView

The live `VaultListView` (~400 lines) unconditionally wires server/shared-state collaborators that demo must never touch:
- `let apiClient: MobileAPIClient`, `let hostSyncService: HostSyncService`, `let autoLockService: AutoLockService` — all non-optional (VaultListView.swift:19-24).
- `sync()` → `hostSyncService.runSync` writes the **shared** cache file + hits the network; triggered by the "Sync now" menu, **both** `.refreshable` blocks (VaultListView.swift:323,356), and `onChange(of: scenePhase == .active)` (VaultListView.swift:120-125).
- `onAppear` → `FaviconLoader.configure(apiClient:serverURL:)` + `resolveShowFavicons()` reading the **shared** `AppSettingsStore().fetchFaviconsCached`; favicon rows fetch over the network and cache to the **shared** `<AppGroup>/vault/favicon-cache/` (FaviconLoader.swift:117-129).
- A toolbar menu exposing **Settings** (writes the shared app-group `UserDefaults`), **Lock**, and **Sign Out** (autoLockService).
- `createEntry`/`saveEntry`/delete → `apiClient` + `runSync` + `refreshCredentialIdentities` (QuickType).

Gating ~10+ sites with `mode == .live` leaves NFR1/NFR2 as a "no missed guard" property — one slip writes a real user's encrypted vault. Instead, **`DemoVaultView` reuses only the pure rendering subviews** (the category grid, the entry-summary list, and the entry detail) over an in-memory `CacheData`, decrypting via the existing `VaultViewModel.loadFromCache`/`loadDetail` (which read **only** the in-memory `cacheData` value — confirmed VaultViewModel.swift:98-101 — never the file, never the network). `DemoVaultView` holds **no** `apiClient`, `hostSyncService`, `autoLockService`, or `FaviconLoader`; those code paths do not exist in it, so the isolation invariant is structural and grep-provable.

### Data injection (extends the DebugVaultLoader pattern, in-memory + production)

`DebugVaultLoader` (`#if DEBUG`) proves the core: synthetic vault `SymmetricKey` → build server-shaped `OverviewBlobPayload`/`FullBlobPayload` blobs → `encryptAESGCMEncoded` with `buildPersonalEntryAAD(userId:, entryId:, vaultType:)` → assemble `CacheData`. **But** `DebugVaultLoader` also writes the shared cache file + bridge key + wrapped key (it is a DEBUG fixture, not isolation-safe) — `DemoVaultFactory` must NOT copy those write steps.

The export JSON (`docs/assets/passwd-sso.json`) is the **Bitwarden-compat import format, NOT the decoder's blob shape**; demo entries are authored as `EntryBlobDecoder`-shaped fixtures in code, one per type, **in lockstep with the per-type shapes already pinned in `EntryBlobGoldenPayloadTests.swift`** (single source of blob-shape truth — T6).

`DemoVaultFactory.makeDemoVault()` (production, `Shared` target) returns an in-memory `CacheData` + ephemeral `SymmetricKey` **as values**; it writes nothing to disk/Keychain/UserDefaults/network. Each fixture `CacheEntry` sets `entryType` to its type string (`"LOGIN"`/`"CREDIT_CARD"`/`"IDENTITY"`/`"BANK_ACCOUNT"`/`"SSH_KEY"`/`"SOFTWARE_LICENSE"`/`"PASSKEY"`/`"SECURE_NOTE"`) — without this every entry classifies as a login (F2).

### State machine wiring (RootView)

New terminal case `AppState.demo(demo: DemoVault)`. RootView renders `DemoVaultView(demo:onExit:)`. Entry: a "Try Demo Mode" closure in `SignInView`/`ServerURLSetupView` sets `appState = .demo(DemoVaultFactory.makeDemoVault())`. Exit: `DemoVaultView`'s "Exit Demo" → `appState = .setup`, dropping the in-memory cache (ARC frees the key). Entering `.demo` runs no `SessionRestorer`/`VaultUnlocker`/`AutofillTokenRefresher`/`onVaultReady`; exiting runs no token/cache cleanup (there is none) and never calls `CredentialIdentityRegistrar`.

## Contracts

### C1 — `DemoVaultFactory.makeDemoVault()`
- **Signature**: `enum DemoVaultFactory { public static func makeDemoVault() -> DemoVault }` where `public struct DemoVault: Sendable { public let cacheData: CacheData; public let vaultKey: SymmetricKey; public let userId: String }`
- **Invariants**:
  - **app-enforced**: returns a `CacheData` whose `entries` decode to exactly 9 `CacheEntry` records (8 types; login×2); `header.entryCount == 9`; `header.userId == userId`.
  - **app-enforced**: every fixture `CacheEntry` sets `entryType` to its type string, so `EntryTypeCategory.from(rawType:)` classifies each correctly and `EntryBlobDecoder.detail` builds the type-specific sub-struct (F2).
  - **app-enforced**: every blob is encrypted under the returned `vaultKey` with `buildPersonalEntryAAD(userId:, entryId:, vaultType:)` such that the **real decrypt path** (`VaultViewModel.loadFromCache` → public `filteredSummaries`, then `loadDetail`) — not the bare plaintext decoder — succeeds for all 9 (T3). (Note: `decryptOverview` is the private worker `loadFromCache` calls; tests drive the public `loadFromCache`/`loadDetail`, not a private symbol — T9.)
  - **app-enforced (isolation)**: performs no Keychain, file, UserDefaults, or network I/O. (No Swift compile-time effect system exists for "no I/O"; enforced by the Forbidden-patterns grep below + the structural test, NOT by an unreliable real-container assertion — T1/T2.)
- **Forbidden patterns** (must NOT appear in `DemoVaultFactory.swift`):
  - `pattern: BridgeKeyStore` — reason: no shared Keychain bridge key
  - `pattern: AppGroupWrappedKeyStore` — reason: no persisted wrapped keys
  - `pattern: saveVaultKey` — reason: ephemeral key only
  - `pattern: cacheFileURL` — reason: no shared cache file
  - `pattern: writeCacheFile` — reason: in-memory cache only
  - `pattern: HostTokenStore` — reason: no token
  - `pattern: FaviconLoader` — reason: no favicon fetch/cache (S1)
- **Acceptance**:
  - `makeDemoVault()` returns; the **real decrypt path** yields 9 summaries (`loadFromCache` → `viewModel.filteredSummaries.count == 9`, scope defaults to `.personal`; assert the public surface, not internal `allSummaries` — T10) and `header.entryCount == 9`.
  - Per-type detail assertions via `loadDetail`: each non-login type confirms a type-specific field (CREDIT_CARD `brand`, IDENTITY `fullName`, BANK_ACCOUNT `bankName`, SSH_KEY `publicKey`, SOFTWARE_LICENSE `licenseKey`, PASSKEY `relyingPartyId`, SECURE_NOTE `content`) — proving correct classification (F2/F6).
  - The login fixture carrying a TOTP decrypts to `totpSecret == "JBSWY3DPEHPK3PXP"` (T7).
  - Forbidden-patterns grep over `DemoVaultFactory.swift` returns no match (the falsifiable isolation gate). Prove-red: temporarily add a `cacheFileURL` reference → grep must fail (T1/RT7).
- **Consumer-flow walkthrough**:
  - Consumer `RootView` (path: `ios/PasswdSSOApp/Views/RootView.swift`) reads `{ cacheData, vaultKey, userId }` and passes them into `DemoVaultView(demo:onExit:)`. All three present in `DemoVault`.
  - Consumer `VaultViewModel.loadFromCache` (path: `ios/PasswdSSOApp/Views/Vault/VaultViewModel.swift`) reads `{ cacheData, vaultKey, userId }` and decrypts overviews; demo calls it with `cacheKey: nil`, `teamDirectory: []` (the actual signature is `teamDirectory: [TeamDirectoryEntry] = []`, not optional — F5). `cacheKey: nil` means `loadTeamKeys` is skipped → no shared wrapped-key read (S6).

### C2 — `AppState.demo` terminal state + entry/exit
- **Signature**: add `case demo(DemoVault)` to `enum AppState` (`RootView.swift`). Entry: `SignInView`/`ServerURLSetupView` "Try Demo Mode" closure → `appState = .demo(DemoVaultFactory.makeDemoVault())`. Exit: `DemoVaultView` `onExit` → `appState = .setup`.
- **Invariants**:
  - **app-enforced**: `.demo` carries only `DemoVault`; no `apiClient`/`hostSyncService`/`autoLockService`/`cacheKey`.
  - **app-enforced**: entering `.demo` does not run `SessionRestorer`/`VaultUnlocker`/`AutofillTokenRefresher`/`onVaultReady`; exiting calls no cleanup and never `CredentialIdentityRegistrar`.
  - **app-enforced**: the `RootView` `switch appState` is exhaustive with `.demo`; the `onChange(of: autoLockService.state)` block stays attached to `.vaultUnlocked` only (no `autoLockService` reference dangles into `.demo`).
- **Forbidden patterns** (must NOT appear in `DemoVaultView.swift` or the `.demo` entry/exit code):
  - `pattern: onVaultReady` — reason: demo wires no sync/drain/token-refresh
  - `pattern: refreshCredentialIdentities` — reason: demo must not seed QuickType
  - `pattern: CredentialIdentityRegistrar` — reason: same
  - `pattern: HostSyncService` / `pattern: runSync` — reason: no sync (S2)
  - `pattern: MobileAPIClient` — reason: no network (NFR2)
  - `pattern: FaviconLoader` — reason: no favicon fetch/cache (S1)
  - `pattern: AppSettingsStore` — reason: demo must not write shared settings (S3)
- **Acceptance**: a state-machine unit test drives `.setup → .demo → .setup` and asserts the transition is reachable + reversible. **Structural (grep) gate** over `DemoVaultView.swift` + the `.demo` wiring asserts none of the Forbidden patterns appear — this is the falsifiable isolation proof (NOT a runtime spy, which would be vacuous because the demo path constructs none of these collaborators — T5). Prove-red: temporarily add a `refreshCredentialIdentities` call to `DemoVaultView` → grep must fail (RT7).

### C3 — `DemoVaultView` (read-only renderer over the in-memory cache)
- **Signature**: `struct DemoVaultView: View { let demo: DemoVault; let onExit: () -> Void }`. Owns a `@State private var viewModel = VaultViewModel()`; on appear calls `viewModel.loadFromCache(cacheData: demo.cacheData, vaultKey: demo.vaultKey, userId: demo.userId, cacheKey: nil, teamDirectory: [])`. Renders the **pure** rendering subviews: the category grid, the entry-summary list, search, and `EntryDetailView` — **without** the live toolbar (no Sync/Settings/Lock/Sign Out), without create/edit/delete, without favicons, without `scenePhase` sync, without `autoLockService`.
- **Invariants**:
  - **app-enforced**: `DemoVaultView` constructs no `MobileAPIClient`/`HostSyncService`/`FaviconLoader`/`AutoLockService`/`CredentialIdentityRegistrar` (grep gate, C2).
  - **app-enforced**: the only navigation control out of demo is "Exit Demo" → `onExit()`; there is no path from `.demo` into a real unlock (scenario 3).
  - **app-enforced**: a persistent "Demo Mode" banner is shown.
  - **app-enforced**: reused subviews (`EntryDetailView`, the category/list rows, `EntrySummaryRow`) are passed `showFavicons: false` so their favicon branch is dead in demo (S1/R3 — the gate propagates to every reused subview, not just the top view).
- **Forbidden patterns**: C2's list applies to `DemoVaultView.swift` **and to every file the read-only seam extracts** (see Mandatory read-only seam). The grep gate is scoped by glob `Demo*.swift` **plus** any extracted read-only file (`*ReadOnly*.swift` or whatever the implementer names it) — NOT a hardcoded two-file list (F7/S7/T8).
- **Mandatory read-only seam (was "reuse note" — now required, not optional)**: `categoryGrid`/`entryList` are `private` computed properties of `VaultListView` (VaultListView.swift:293,335) closing over the live deps, so `DemoVaultView` **must reimplement** the grid/list navigation regardless. More binding: BOTH `VaultCategoryListView` (VaultCategoryLanding.swift:75-78) AND `EntryDetailView` (EntryDetailView.swift:15-18) declare **non-optional** `apiClient: MobileAPIClient` / `hostSyncService: HostSyncService` / `autoLockService` — and `MobileAPIClient.init` drags in the forbidden `HostTokenStore`. Reusing either verbatim therefore **contradicts the grep gate**. The implementer MUST extract a read-only rendering seam covering **both** views — either an `isReadOnly`/`mode` parameter that makes those three collaborators optional-and-unused, or trimmed standalone views (`EntryDetailReadOnlyView` + a read-only category list) that take none of them. The per-type detail section renderers (`creditCardSection`/`sshKeySection`/… in EntryDetailTypeSections.swift) are currently `private` to `EntryDetailView` and must be extracted into a standalone view as part of this seam. The seam file(s) are added to the Forbidden-patterns grep scope (above). (F7/S7)
  - **Accepted reads in the extracted seam (F8/S8)**: the reused copy helpers call `autoLockService.recordActivity()` and `SecureClipboard.copy(clearAfter: AppSettingsStore().clipboardClearSeconds)`. In the read-only seam: drop the `autoLockService` activity calls (demo has no idle lock); the `AppSettingsStore().clipboardClearSeconds` **read** (not a write — fail-closed to a secure default, no contamination) is accepted. Because `AppSettingsStore` is a C2-forbidden literal, the seam either inlines a constant clipboard-clear OR records a one-line grep-gate exception noting this is a read-only access. State which in Phase 2.
- **Acceptance**: a pure predicate test — extract `DemoVaultView`'s capability flags into a `DemoVaultPresentation` value type the view actually reads (`showsMutationAffordances == false`, `showsSyncControls == false`, `showsFavicons == false`, `exitLabel`) and unit-test those (no snapshot harness exists — T4). The test must assert the VIEW consumes the same constants (not a parallel value the view ignores — T8/R41). **Prove-red (RT7)**: flip a flag default (e.g. `showsMutationAffordances = true`) and confirm the predicate test goes red. Plus the C2 grep gate over `DemoVaultView.swift` + the extracted seam file(s). The live `VaultListView` is **untouched**, so all existing VaultListView tests pass unchanged.

### C4 — "Try Demo Mode" affordance on entry screens
- **Signature**: a button in `SignInView` body and `ServerURLSetupView` body; both call an injected `onEnterDemo: () -> Void` wired in `RootView` to `appState = .demo(DemoVaultFactory.makeDemoVault())`.
- **Invariants**:
  - **app-enforced**: always visible (not behind a hidden gesture or a specific server URL) — Apple-recommended, reviewer-discoverable.
  - **app-enforced**: tapping it needs no server URL or token.
- **Acceptance**: button visible on first launch (`.setup`) and on `.signIn`; tap transitions to `.demo`; localized label present in `Localizable.xcstrings` (en + ja).

## Go/No-Go Gate

| ID  | Subject                                              | Status |
|-----|-----------------------------------------------------|--------|
| C1  | `DemoVaultFactory.makeDemoVault()` in-memory builder | locked |
| C2  | `AppState.demo` terminal state + entry/exit          | locked |
| C3  | `DemoVaultView` read-only renderer + read-only seam   | locked |
| C4  | "Try Demo Mode" affordance on entry screens          | locked |

## Testing strategy

- **Unit (C1)** `DemoVaultFactoryTests`: call `makeDemoVault()`, drive the **real decrypt path** (`VaultViewModel.loadFromCache`) — assert `allSummaries.count == 9`, `header.entryCount == 9`, one per-type field via `loadDetail` for each of the 7 non-login types (F2), and `totpSecret == "JBSWY3DPEHPK3PXP"` for the TOTP login (T7). NFR3 grep: source contains no email domain outside `example.{com,org,net}`. Follow the existing `DebugVaultLoaderTests`/`EntryBlobGoldenPayloadTests` idioms (T3/T6).
- **Unit (C2)** state-machine test `.setup → .demo → .setup`. **Isolation gate (grep)**: a test (or a pre-PR check script) greps **all `Demo*.swift` files PLUS any extracted read-only seam file** (`*ReadOnly*.swift` or as named in C3) for the Forbidden patterns and fails on any match — a glob, not a hardcoded file list (T8). Documented prove-red step per gate (T1/T5/RT7). No real-container/real-keychain runtime assertion (unreliable — T1/T2).
- **Unit (C3)** pure-predicate test on the demo presentation flags (no snapshot harness — T4), with a prove-red step (flip a flag default → test goes red — RT7). The extracted read-only seam is a new production export and ships with its own test in this PR (RT6).
- **Manual (R35 Tier-1 — UI surface)** `ios-demo-mode-manual-test.md`: fresh-install → Try Demo Mode → browse all 8 types (confirm card/SSH/identity/etc. render type-correct) → copy a TOTP → search → Exit Demo → back at sign-in. Run on an **iPad simulator in iPhone-compatibility mode** (VEC1). Residue check: with a separately set-up real vault on the same simulator, run a demo session, exit, and assert the real cache file mtime + entry count are unchanged, the favicon cache dir is unchanged, and the `ASCredentialIdentityStore` identity count is unchanged (NFR1/S4).

## Considerations & constraints

### Scope contract
- **SC1 — Local-only create/edit/delete in demo**: deferred. Owner: a follow-up PR if Apple/users request mutation. Reason: read-only browse satisfies Guideline 2.1 (reviewer must *see* the app work); local-write would require intercepting the concrete `MobileAPIClient` actor + `runSync`, materially higher-risk. Re-scope trigger: a second rejection citing "cannot exercise features".
- **SC2 — AutoFill extension demo**: out of scope permanently (the extension has no sign-in screen; demo is a host-app concept). The extension is untouched.
- **SC3 — Team/shared-vault entries in demo**: deferred to SC1's follow-up. Demo shows personal entries only (`cacheKey: nil`), matching the existing debug path.

### Known risks
- Fixture drift vs. real server blobs. Mitigation: C1 exercises the **real** decrypt+decode path and the fixtures track `EntryBlobGoldenPayloadTests` (memory `ios-blob-type-drift-bug-class`).
- `EntryDetailView` reuse may require a read-only seam (C3 reuse note). If too invasive, `DemoVaultView` renders a trimmed detail.
- App-switcher snapshot will capture the demo vault list on backgrounding. Accepted: demo data is fake (NFR3); documented rather than mitigated (the live screen-recording overlay keys on `UIScreen.isCaptured`, a separate concern).

### Out of scope
- Web/server changes (none).
- Changing `TARGETED_DEVICE_FAMILY` (the app stays iPhone-only; demo just renders in compatibility mode).
- `DebugVaultLoader` removal/refactor — left as-is (`#if DEBUG`). Possible future DRY (have it call `DemoVaultFactory`) is out of scope to avoid changing a working debug path.

## User operation scenarios

1. **Reviewer, fresh install, iPad**: launch → `.setup` (server URL screen) → "Try Demo Mode" (no URL entered) → demo vault, 9 entries → category "Logins" → open "AWS Console (IAM)" → reveal password + copy TOTP → back → search "ssh" → open "Deploy Key" → see public key/fingerprint → "Exit Demo" → back at server URL screen.
2. **Real user with existing vault, curious**: has a real unlocked vault; signs out to `.setup`; tries demo; exits; signs back in → real vault unlocks unchanged, AutoFill suggestions unchanged, settings unchanged.
3. **Edge — demo then real sign-in without exit**: from `.demo` the only forward control is "Exit Demo" → `.setup`; no path from `.demo` into a real unlock, so demo state cannot bleed into a real session.
