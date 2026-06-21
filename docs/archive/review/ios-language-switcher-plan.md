# Plan: iOS In-App Language Switcher (Japanese / English / System)

## Project context

- **Type**: `mixed` — native iOS SwiftUI app (host app + AutoFill extension) within a larger Next.js web monorepo. This change touches only the iOS subtree (`ios/`).
- **Test infrastructure**: `unit tests only` — XCTest target `PasswdSSOTests`, runnable via `xcodebuild test -scheme PasswdSSOApp -destination 'id=<sim udid>'` (Xcode 26.4.1 available in the dev shell). No E2E, no CI for iOS UI flows beyond xcodebuild.
- **Verification environment constraints**:
  - **VC1 — Language-restart effect requires a real app relaunch**: the chosen approach writes `AppleLanguages` and surfaces a "restart to apply" notice. The full string flip is only observable after an actual app process relaunch (kill + reopen), which `xcodebuild test` cannot drive end-to-end in a single unit-test process (the bundle's `preferredLocalizations` is resolved once at launch). Classification: **verifiable-local (manual)** — operator launches the sim, switches language, relaunches, observes the flip. The *persistence + read-back* of the preference IS unit-testable (UserDefaults round-trip); the *visual flip* is manual. No paid tier or hardware required.
  - **VC2 — System-locale fallback rendering**: verifying that "System" choice yields the device language depends on the simulator's configured language. Classification: **verifiable-local (manual)** — set sim language, confirm app follows. The branch logic (write nil/remove key vs explicit array) IS unit-testable.
  - **VC3 — AutoFill extension live locale switch**: verifying the extension renders in the chosen language requires driving the real AutoFill presentation flow (a host app's login form invoking the credential provider). Classification: **verifiable-local (manual)** — `xcodebuild test` cannot present the credential-provider extension UI. The `localeOverride` mapping (`.ja→Locale("ja")` etc.) IS unit-testable; the `.environment(\.locale,)` rendering effect is manual. No paid tier/hardware required (simulator AutoFill works).

## Objective

Let the user pick the iOS app's display language (System / 日本語 / English) from the in-app Settings screen, mirroring the web app's language-switch capability, persisting the choice locally. The **host app** applies it on next launch (restart-to-apply, `AppleLanguages`). The **AutoFill extension** applies it **immediately** on its next presentation via `.environment(\.locale,)` (no restart), because every extension string is a `Text("…")` LocalizedStringKey that honors the SwiftUI locale environment — see C7/C8 and the asymmetry note in Technical approach.

## Requirements

### Functional
- A new **Language** picker in `SettingsView`, in its own `Section` (placed adjacent to the existing Appearance/Theme section).
- Three choices: **System** (follow device), **日本語**, **English**.
- Selecting a non-System language writes the iOS standard `AppleLanguages` user-default so the next launch resolves to that language for `String(localized:)` and `Text("…")` in the **host app**.
- The AutoFill extension reads the same App-Group `appLanguage` preference and applies it via `.environment(\.locale,)` at presentation time (C7/C8) — immediate, no restart.
- Selecting **System** removes the override so the device language governs again.
- After any change away from the currently-effective language, show a non-blocking notice: "言語を変更しました。反映するにはアプリを再起動してください。" / "Language changed. Restart the app to apply." The picker selection itself updates immediately (it reflects the *stored preference*, not the rendered language).
- Default when never set: **System**.

### Non-functional
- No server round-trip (local-only; decided with user).
- Must not regress the existing `LocalizationCatalogTests` (both catalogs keep complete ja/en coverage).
- New user-facing strings (the picker label, the three option labels, the restart notice) must themselves be localized in BOTH `ja` and `en` in `PasswdSSOApp/Localizable.xcstrings`. Option labels **日本語**/**English** are endonyms and are NOT translated (same string in both locales) — see C5.
- The preference is non-secret → App Group UserDefaults is the correct store (consistent with `AppTheme`), NOT Keychain.

## Technical approach

### Host vs. extension asymmetry — two different mechanisms, by design
The two targets have different string-API profiles, so they use different switch mechanisms:

- **Host app → restart-to-apply (`AppleLanguages`)**: the host uses `String(localized: …)` pervasively (e.g. `SettingsView.swift:15-17,91`, `EntryTypeCategory.swift:43-56`, `RootView.swift:214`, `ServerURLSetupView.swift:34`). `String(localized:)` resolves against `Bundle.main.preferredLocalizations`, fixed at process launch and **not** affected by SwiftUI's `\.locale` environment. A live `.environment(\.locale,)` in the host would flip only `Text("literal")` sites and leave every `String(localized:)` site stale — a mixed-language UI. So the host persists `AppleLanguages` and asks for a relaunch. (Decided with user: 再起動案内方式.)
- **AutoFill extension → live `.environment(\.locale,)`**: every user-facing string in the extension is a SwiftUI `Text("…")` LocalizedStringKey — **zero `String(localized:)`** (verified: 16 strings across `CredentialPickerView.swift`, `FillProgressView.swift`, `OneTimeCodePickerView.swift`, `LockedFallbackView.swift`; `grep -rc "String(localized:" PasswdSSOAutofillExtension` = 0). `Text(LocalizedStringKey)` honors the `\.locale` environment value, so injecting `.environment(\.locale, …)` at the single hosting choke point flips all of them with no restart. The extension is a fresh process per invocation anyway, so it always reads the latest preference. (Decided with user: include extension, 案A.)

Why NOT write `AppleLanguages` in the extension instead: the extension's own `Bundle.main.preferredLocalizations` is resolved early in process launch (before `prepareCredentialList`), so a launch-time `AppleLanguages` write would only take effect on the *following* extension launch — a one-invocation lag, visible every time. The `.environment(\.locale,)` path has no such lag and is strictly better for the extension's all-`Text` surface.

### Storage model
Add a `appLanguage` concept analogous to `AppTheme`:
- A new `public enum AppLanguage: String, CaseIterable` in `Shared/Storage/AppSettingsStore.swift` with cases `system`, `ja`, `en`.
- The **source of truth the user picks** is stored under the App-Group `"appLanguage"` key (so the picker is stable and survives even if the OS rewrites `AppleLanguages`).
- The **effect mechanism** is the iOS-standard `AppleLanguages` array in `UserDefaults.standard` (NOT the App-Group suite — `AppleLanguages` is only honored by the OS bundle-localization machinery in the standard domain). Setting `appLanguage`:
  - `.ja` → `UserDefaults.standard.set(["ja"], forKey: "AppleLanguages")`
  - `.en` → `UserDefaults.standard.set(["en"], forKey: "AppleLanguages")`
  - `.system` → `UserDefaults.standard.removeObject(forKey: "AppleLanguages")`
- Read-back of the picker selection comes from the App-Group `"appLanguage"` key (fail-closed to `.system` when absent/garbage), NOT by parsing `AppleLanguages` (which the OS may normalize to region-qualified forms like `ja-JP`).

### Why a dedicated `"appLanguage"` key in addition to `AppleLanguages`
`AppleLanguages` is OS-owned: the system may rewrite/normalize it (e.g. `["ja-JP", "en-US"]`) and it reflects the *device* language list when no override was set. Parsing it to drive the picker is brittle. Storing the user's literal choice separately (mirroring how `AppTheme` is its own key) keeps the picker deterministic.

### UI integration
`SettingsView` gains a Language `Section`. Because the setting cannot apply live, the picker binds to a small `@State`/store-backed selection; on change it (1) writes both keys via the store, (2) sets a `@State var showRestartNotice`. The notice renders as a `Section` footer or an inline `Text` that appears once a pending change exists and the pending language differs from the launch-time effective language.

## Contracts

### C1 — `AppLanguage` enum (Shared)
- **Signature**: `public enum AppLanguage: String, CaseIterable { case system; case ja; case en }`
- **File**: `ios/Shared/Storage/AppSettingsStore.swift`
- **Invariants**:
  - (app-enforced) `rawValue` is exactly one of `"system"|"ja"|"en"`.
  - (app-enforced) `ja`/`en` rawValues equal the catalog localization codes used in `Localizable.xcstrings` and in `LocalizationCatalogTests` (`"ja"`, `"en"`), so the override array elements are valid bundle localizations.
- **Forbidden patterns**:
  - `pattern: Locale\.current\b` in the new language code — reason: the preference, not live `Locale.current`, drives the override. **Carve-out (F2)**: `Bundle.main.preferredLocalizations` IS permitted (and required) for resolving `.system` to a concrete code in the restart-notice comparison and for the System display label — that is the bundle's resolved localization, not the live `Locale.current` foot-gun.
- **`effectiveCode` (F2)**: add `public var effectiveCode: String` to `AppLanguage`: `.ja → "ja"`, `.en → "en"`, `.system → Bundle.main.preferredLocalizations.first ?? "en"`. This is the single normalization point the restart-notice comparison uses (C4).
- **`localeOverride` (C7/C8 — extension)**: add `public var localeOverride: Locale?` to `AppLanguage`: `.ja → Locale(identifier: "ja")`, `.en → Locale(identifier: "en")`, `.system → nil`. The extension injects this into `.environment(\.locale, …)`: a non-nil value forces the locale; `nil` (System) means "do not override" — the extension falls through to its inherited environment locale (the device locale), so System correctly follows the device with no special-casing. **Forbidden-pattern carve-out note**: this constructs `Locale(identifier:)` from the closed enum, NOT from `Locale.current` — consistent with C1's `Locale.current` ban.
- **Acceptance**: enum compiles; `AppLanguage.allCases == [.system, .ja, .en]`; `AppLanguage(rawValue:)` round-trips each case; `effectiveCode` returns `"ja"`/`"en"` for the explicit cases; `localeOverride` for `.ja`/`.en` has `.identifier == "ja"`/`"en"` and `.system` is `nil`. **(T9 — Major)**: assert `localeOverride?.identifier` (a stable `String`), NOT `localeOverride == Locale(identifier:"ja")` — `Locale` value-equality folds in ICU-canonicalized components and can differ across OS images, making a `Locale==Locale` assertion cross-image-flaky.

### C2 — `AppSettingsStore.appLanguage` accessor (Shared)
- **Signature**:
  ```swift
  public var appLanguage: AppLanguage { get nonmutating set }
  ```
  Getter reads App-Group key `"appLanguage"`, fail-closed to `.system`. Setter writes the App-Group `"appLanguage"` key AND mutates `UserDefaults.standard` `AppleLanguages` per the mapping in Technical approach.
- **File**: `ios/Shared/Storage/AppSettingsStore.swift`
- **Invariants**:
  - (app-enforced) Getter returns `.system` for absent OR unrecognized stored values (fail-closed, matching the existing `vaultTimeoutAction` pattern at `AppSettingsStore.swift:69-79`).
  - (app-enforced) Setting `.system` REMOVES `AppleLanguages` from `UserDefaults.standard` (does not write `["system"]` — `"system"` is not a valid localization and would break the bundle).
  - (app-enforced) Setting `.ja`/`.en` writes a single-element array `["ja"]`/`["en"]` to `UserDefaults.standard.AppleLanguages`.
  - (app-enforced) The App-Group `"appLanguage"` key always stores the literal `rawValue` (`"system"`/`"ja"`/`"en"`), so read-back is deterministic regardless of OS normalization of `AppleLanguages`.
- **Forbidden patterns**:
  - `pattern: \.appGroup\b.*AppleLanguages` — reason: `AppleLanguages` MUST be written to `UserDefaults.standard`, never the App-Group suite (the OS only honors it in the standard domain).
- **Acceptance** (unit-testable, VC1 persistence half):
  - Absent key → `.system`.
  - Set `.ja` → getter returns `.ja` AND `standard.AppleLanguages == ["ja"]`.
  - Set `.en` → getter returns `.en` AND `standard.AppleLanguages == ["en"]`.
  - Set `.system` after `.ja` → getter returns `.system` AND `standard.object(forKey: "AppleLanguages") == nil`. **(T3 — provable-red)**: this test MUST Arrange `set .ja` first and assert `["ja"]` is present, THEN Act `set .system`, THEN Assert nil — otherwise a buggy no-op `.system` setter passes spuriously on a fresh suite that never had the key. Mirror `testTenantPolicyAuthoritativeNilClears` (`AppSettingsStoreTests.swift:185-190`).
  - Garbage stored value (`"de"`, `""`, `"123"`) → getter returns `.system`.
- **Consumer-flow walkthrough**:
  - Consumer A (path: `ios/PasswdSSOApp/Views/SettingsView.swift`) reads `store.appLanguage` to seed the picker selection and writes it on change; it uses the returned `AppLanguage` to render the localized option label and to decide whether to show the restart notice (compares pending vs launch-effective).
  - Consumer B (path: `ios/PasswdSSOTests/AppSettingsStoreTests.swift`) reads `appLanguage` and `standard.AppleLanguages` to assert the round-trip and the standard-domain side effect.
  - No consumer needs any field beyond the `AppLanguage` value and the `AppleLanguages` array; both are present.

### C3 — Test-injectable standard defaults (Shared)
- **Problem**: `AppSettingsStore` currently injects only the App-Group `defaults` (`AppSettingsStore.swift:49-53`). To unit-test the `AppleLanguages` side effect without polluting the real `UserDefaults.standard`, the setter must write to an injectable "standard" UserDefaults too.
- **Signature** (extend the initializer, keep the existing one source-compatible):
  ```swift
  public init(defaults: UserDefaults = .appGroup,
              systemDefaults: UserDefaults = .standard)
  ```
  Store `systemDefaults` privately; the `appLanguage` setter writes `AppleLanguages` to `systemDefaults`.
- **File**: `ios/Shared/Storage/AppSettingsStore.swift`
- **Invariants**:
  - (app-enforced) Production call sites that use the zero-arg / single-arg initializer keep their current behavior (`systemDefaults` defaults to `.standard`). Existing call site `SettingsView.swift:30` (`AppSettingsStore()`) and `AppSettingsStoreTests` per-suite construction remain valid — the new parameter is defaulted.
  - (app-enforced) Tests pass a throwaway suite as `systemDefaults` so `["ja"]` does not leak into the host process's real `AppleLanguages`.
- **Forbidden patterns**: none beyond C2's.
- **Acceptance** (F4): the existing `AppSettingsStoreTests` (~35 test methods) and all production call sites compile and pass **unmodified** — the new `systemDefaults` parameter is defaulted, so `AppSettingsStore()` and `AppSettingsStore(defaults:)` remain source-compatible. New `appLanguage` tests opt into `systemDefaults`.
- **Call-site enumeration (R19 / T6)**: 7 production constructions — `RootView.swift:105,279,393`, `SettingsView.swift:30`, `TOTPCodeView.swift:81`, `EntryDetailView.swift:280`, and the AutoFill extension `CredentialProviderViewController.swift:602`. The extension's bare `AppSettingsStore()` is intentional — the extension never sets `appLanguage` (host-only, SC3), so it gets `systemDefaults = .standard` and never writes `AppleLanguages`.
- **Test isolation contract (T1, T2 — Major)**: this is a hard requirement, not "follow the existing pattern":
  - Every `appLanguage` test MUST construct the store with an injected throwaway `systemDefaults` suite — NEVER the bare `AppSettingsStore(defaults:)` form (which would default `systemDefaults` to the real `.standard` and write `["ja"]` into the test host's real `AppleLanguages`, contaminating `LocalizationCatalogTests`).
  - The test class MUST create the `systemDefaults` suite in `setUp` and `removePersistentDomain(forName:)` it in `tearDown`, mirroring the existing single-suite teardown at `AppSettingsStoreTests.swift:20-25` but for BOTH suites.
  - Add a guard test (T2): after `set .ja` on the injected store, assert the process's real `UserDefaults.standard.object(forKey: "AppleLanguages")` is unchanged from a baseline captured in `setUp` — proves no test leaks into the real domain.
- **Consumer-flow walkthrough**:
  - Consumer A (`SettingsView.swift`) constructs `AppSettingsStore()` (both defaults implicit) — unchanged.
  - Consumer B (`AppSettingsStoreTests.swift`) constructs `AppSettingsStore(defaults: suite, systemDefaults: stdSuite)` — reads back `appLanguage` from `suite` and `AppleLanguages` from `stdSuite`. Both fields available.

### C4 — Language `Section` in `SettingsView`
- **Signature** (no function; SwiftUI view fragment): a new `Section("Language")` containing `Picker("Language", selection: <binding>)` over `AppLanguage.allCases`, plus a conditional footer/inline `Text` restart notice.
- **File**: `ios/PasswdSSOApp/Views/SettingsView.swift`
- **Invariants**:
  - (app-enforced, F2) The binding's setter writes `store.appLanguage = newValue` and sets `pendingRestart = (newValue.effectiveCode != launchEffectiveCode)`, where BOTH sides are resolved BCP-47 codes: `launchEffectiveCode = Bundle.main.preferredLocalizations.first` captured once at view init, and `newValue.effectiveCode` is the C1 accessor (`.system` resolves to the same `Bundle.main.preferredLocalizations.first`). This makes "pick the language the device already uses" correctly produce NO notice (Scenario 1/4).
  - (app-enforced) The picker `selection` reflects `store.appLanguage` (the stored preference), so it is stable across re-renders even though the UI language has not flipped yet.
  - (app-enforced, F5) Option labels come from a single `AppLanguage.label` computed property in `SettingsView.swift`, mirroring `AppTheme.label` (`SettingsView.swift:13-19`): `.system → String(localized: "System")` (REUSE the existing key, do not duplicate), `.ja`/`.en` → endonyms via the C5 mechanism (NOT raw `String(localized:)`, to avoid F1).
- **Forbidden patterns**:
  - `pattern: \.environment\(\\.locale` in `SettingsView.swift` — reason: we are NOT doing live locale switching; an `.environment(\.locale,)` here signals the wrong approach was implemented.
- **Acceptance** (manual, VC1 visual half): operator opens Settings → Language, picks English, sees the restart notice; relaunches app; UI is English. Picks System; relaunches; UI follows device.
- **Consumer-flow walkthrough**: the Section is a leaf UI consumer of C2; it reads `store.appLanguage` and writes it. No downstream consumer reads the Section's state.

### C5 — New localized strings in the host catalog
- **File**: `ios/PasswdSSOApp/Localizable.xcstrings`
- **New keys** (each with `en` source + `ja` translation, `state: "translated"`):
  - `"Language"` → ja `"言語"`
  - The restart notice string (single literal, no `+` concatenation per the existing convention at `SettingsView.swift:114-116`): en `"Language changed. Restart the app to apply."` → ja `"言語を変更しました。反映するにはアプリを再起動してください。"`
  - `"System"` already exists (used for Theme at `SettingsView.swift:15`) — REUSE it; do NOT add a duplicate. (R2 — shared-constant/string reuse.)
- **日本語 / English option labels (F1 — DECISION LOCKED)**: add `"日本語"` and `"English"` as catalog entries with `"shouldTranslate": false` and a single value each (endonyms are identical in both locales). **Rationale (F1)**: the prior plan's premise — "use literal Swift strings to avoid catalog extraction" — is FALSE. The Swift compiler auto-extracts any literal passed to `Text(_:)` / `String(localized:)` into the catalog (proven by the existing `"System"` entry's `extractionState:"stale"` at `xcstrings:2137`). A literal `Text("English")` would be extracted as a key with no `ja` unit and FAIL `LocalizationCatalogTests`. The `shouldTranslate:false` entry is explicitly skipped by that test (`LocalizationCatalogTests.swift:64`), so it passes AND is asserted present. The `AppLanguage.label` accessor (C4/F5) renders these via `String(localized:)` whose extracted keys now exist as `shouldTranslate:false` entries.
- **Invariants**:
  - (schema-enforced by `LocalizationCatalogTests`) Every catalog key has a `state: "translated"` ja unit UNLESS `shouldTranslate:false`. New keys (`"Language"`, restart notice) MUST be `translated` in ja; the endonyms (`"日本語"`, `"English"`) MUST be `shouldTranslate:false`.
- **Forbidden patterns**:
  - `pattern: Text\("Language"\)\s*\+` — reason: no `+` concatenation on localized Text (breaks single-key extraction; matches the existing convention note).
- **Acceptance**: `LocalizationCatalogTests` passes; the `"System"` key is REUSED (no duplicate introduced); `"日本語"`/`"English"` exist as `shouldTranslate:false` entries; `"Language"` and the restart notice have `state:"translated"` ja units.

### C6 — knownRegions / project.yml sanity
- **File**: `ios/project.yml` (read-only verification; likely no edit)
- **Invariants**:
  - (app-enforced) `developmentLanguage: en` and the catalog already carries `ja`+`en`, so xcodegen derives `knownRegions` from catalog content (per the iOS String Catalog memory note — `options.knownRegions` is ignored). No project.yml change is expected.
- **Acceptance**: after `xcodegen generate`, `PasswdSSO.xcodeproj/project.pbxproj` `knownRegions` still contains `ja` and `en`; the app builds. If (and only if) `xcodebuild` drops `ja`, revisit — but this is not anticipated since no catalog languages are removed.

### C7 — AutoFill extension reads the preference and injects `.environment(\.locale,)`
- **File**: `ios/PasswdSSOAutofillExtension/CredentialProviderViewController.swift`
- **Integration point**: the single SwiftUI hosting choke point `presentSwiftUI<V: View>(_ view:)` at `CredentialProviderViewController.swift:653-672` — EVERY extension view (`CredentialPickerView`, `FillProgressView`, `OneTimeCodePickerView`, `LockedFallbackView`) is presented through it. Apply the locale once here so all four views inherit it.
- **Signature** (no new function; modify the hosting helper):
  ```swift
  let resolved = AppSettingsStore().appLanguage.localeOverride
  let hosted = resolved.map { AnyView(view.environment(\.locale, $0)) } ?? AnyView(view)
  let host = UIHostingController(rootView: hosted)
  ```
  (Exact form may differ; the contract is: when `localeOverride != nil`, the hosted root view carries `.environment(\.locale, override)`; when `nil`, the view is hosted unchanged so it inherits the device locale.)
- **Invariants**:
  - (app-enforced) `appLanguage == .system` → NO `.environment(\.locale,)` applied → extension follows the device locale.
  - (app-enforced) `appLanguage == .ja`/`.en` → `.environment(\.locale, Locale(identifier:"ja"/"en"))` applied to the hosted root → all 16 `Text("…")` strings render in that language with no restart.
  - (app-enforced, F8) The `localeOverride` read and the conditional `.environment(\.locale,)` wrap MUST live INSIDE `presentSwiftUI` (the single choke point), NOT be scattered across the 5 call sites and NOT cached at controller `init`/`viewDidLoad`. This keeps all four views covered by one edit and lets a within-process re-presentation (spinner → picker; or iOS reusing the VC for a second `prepare*`, `CredentialProviderViewController.swift:565-569`) pick up the current preference.
  - (app-enforced, F9) The override read happens at `presentSwiftUI` call time (each presentation), so a preference change takes effect on the extension's next presentation (extension is a fresh process per invocation anyway).
- **Forbidden patterns**:
  - `pattern: AppleLanguages` in the extension target — reason: the extension uses `.environment(\.locale,)`, NOT an `AppleLanguages` write (which would lag one launch). An `AppleLanguages` write in the extension signals the wrong mechanism was implemented.
- **Acceptance** (manual, VC3 — covers BOTH the wrap decision and the render, since neither is unit-testable): (1) host = English → invoke AutoFill → picker/locked/spinner UI is English immediately (no relaunch); (2) host = System on a Japanese device → AutoFill UI is Japanese (the `nil`→inherit branch follows the device — T10); (3) switch host to 日本語 → next AutoFill invocation is Japanese.
- **Consumer-flow walkthrough**:
  - Consumer (path: `CredentialProviderViewController.presentSwiftUI`) reads `AppSettingsStore().appLanguage` and uses its `localeOverride` to decide whether to wrap the hosted view in `.environment(\.locale,)`. The only field consumed is `localeOverride: Locale?`, which C1/C7 provide.

### C8 — Extension `Text` strings stay catalog-translated (no regression)
- **File**: `ios/PasswdSSOAutofillExtension/Localizable.xcstrings` (read-only verification; no new keys in this PR)
- **Invariants**:
  - (schema-enforced by `LocalizationCatalogTests`) The extension catalog already carries complete ja/en for all 16 strings; this PR adds NO new extension strings, so the existing coverage stands. The `.environment(\.locale,)` switch only changes WHICH translation is selected at render — it does not add keys.
- **Acceptance**: `LocalizationCatalogTests` (which validates BOTH catalogs per `LocalizationCatalogTests.swift:21-27`) stays green; no extension catalog edit.

## Go/No-Go Gate
| ID  | Subject                                            | Status |
|-----|----------------------------------------------------|--------|
| C1  | `AppLanguage` enum (Shared)                         | locked |
| C2  | `AppSettingsStore.appLanguage` accessor            | locked |
| C3  | Test-injectable `systemDefaults`                    | locked |
| C4  | Language `Section` in `SettingsView`               | locked |
| C5  | New localized strings (host catalog)               | locked |
| C6  | knownRegions / project.yml sanity                  | locked |
| C7  | Extension `.environment(\.locale,)` injection      | locked |
| C8  | Extension catalog no-regression                     | locked |

## Testing strategy

- **Unit (`AppSettingsStoreTests`)**: add tests for C1/C2/C3:
  - `appLanguage` round-trip through an injected App-Group suite, and the `AppleLanguages` side effect through an injected `systemDefaults` suite (`.ja`/`.en`/`.system`/garbage). `.system`-removes-key follows the precondition-write pattern (T3).
  - **(T1/T2)** create BOTH suites in `setUp` and `removePersistentDomain` both in `tearDown`; add the `.standard`-not-mutated guard test.
  - **(T4)** `testAppLanguageAllCasesOrdering` — assert `AppLanguage.allCases == [.system, .ja, .en]`, `AppLanguage(rawValue:)` round-trips each case, `effectiveCode` returns `"ja"`/`"en"` for the explicit cases, and `localeOverride?.identifier == "ja"`/`"en"` for `.ja`/`.en` with `XCTAssertNil(AppLanguage.system.localeOverride)` (T9 — assert `.identifier`, not `Locale` value-equality). The picker iterates `allCases` (C4), so this guards UI order against a future case insertion; the `localeOverride` assertion is the unit-testable half of C7 (the rendering effect is VC3 manual).
  - **(T10 — cross-store hand-off, the one automatable C7 slice)** add a test that writes `appLanguage = .ja` through one `AppSettingsStore` and reads `.ja` back through a SECOND store on the SAME App-Group suite — proving the host→extension App-Group hand-off C7 depends on (mirrors the existing `testAutoCopyTotpReadsAcrossSeparateStoresOnSameSuite` at `AppSettingsStoreTests.swift:172-177`). The `.environment(\.locale,)` render itself stays VC3 manual.
- **Unit (`LocalizationCatalogTests`)**: no code change; it automatically validates the new C5 keys (`"Language"`, restart notice) are fully translated, and tolerates the `shouldTranslate:false` endonym entries (`LocalizationCatalogTests.swift:64`). The endonyms (`"日本語"`/`"English"`) now exist as catalog entries (F1), so they are within the catalog's coverage — no manual VC needed for them (T5 resolved).
- **Manual (VC1/VC2/VC3)**: VC1 host restart-to-apply flow (kill + relaunch); VC2 System-follows-device; **VC3 extension live switch** — set host language, invoke AutoFill, confirm the extension UI is in the chosen language with NO relaunch (and that System follows the device). Not automatable in-process (extension presentation requires the real AutoFill flow).
- **Build verification**: `xcodegen generate` (commit regenerated pbxproj per the iOS xcodegen memory) then `xcodebuild test -scheme PasswdSSOApp -destination 'id=<sim udid>'` — all existing + new tests pass. The extension `.environment(\.locale,)` injection (C7) is logic-light and compile-verified; its visual effect is VC3 (manual), since the AutoFill presentation path cannot be driven from a unit test.

## Considerations & constraints

### Scope contract
- **SC1 — Server sync of locale preference**: NOT in scope (decided: local-only). The web `PUT /api/user/locale` endpoint exists but the iOS app will not call it. Owner: future issue if cross-device language sync is desired.
- **SC2 — Live (no-restart) language switching**: NOT in scope (decided: restart-to-apply). Full live switching would require replacing every `String(localized:)` with a custom localizer + bundle swap. Owner: future refactor if UX demands it; tracked here as `SC2`.
- **SC3 — AutoFill extension language is now IN scope (revised)**: the extension is a **separate process with a distinct bundle id** (`jp.jpng.passwd-sso.PasswdSSOAutofillExtension`, `project.yml:190`) and its OWN `UserDefaults.standard` domain, so the host's `AppleLanguages` write does NOT reach it. Rather than the brittle launch-time `AppleLanguages`-write (one-invocation lag), the extension uses `.environment(\.locale,)` (C7), which works because every extension string is a `Text("…")` LocalizedStringKey (0 `String(localized:)`). **Decision (user): include the extension (案A).** The override is read from the shared App-Group `appLanguage` and applied immediately at presentation. Out-of-scope remainder: the extension does NOT get its own Settings UI — the language is set in the host's Settings and shared via App Group. Owner: n/a.

### Known risks
- **AppleLanguages normalization**: the OS may store `["ja"]` as `["ja"]` or normalize on read; we never parse it back for the picker (C2 invariant), so this is contained.
- **Region-qualified device locales**: if the device is e.g. `ja-JP`, the catalog's `ja` localization still matches (base-language fallback). No region-specific catalogs exist, so no gap.

## User operation scenarios

1. **Fresh user, device in Japanese**: opens Settings → Language shows "System" selected; UI already Japanese. No action needed.
2. **User forces English on a Japanese device**: picks "English" → restart notice appears; picker now shows "English". User force-quits and reopens → the host app is English. The AutoFill extension shows English on its **next invocation** (no relaunch needed — C7).
3. **AutoFill with a non-System language**: host language = 日本語 on an English device. User invokes AutoFill in Safari → the credential picker, "Fill for app?" prompt, and locked-fallback sheet all render in Japanese immediately (C7 `.environment(\.locale,)`). With host = System, the same UI is in English (device language).
4. **User reverts to System**: picks "System" → `AppleLanguages` removed → restart → host follows the device language again; the extension follows the device (no override) on its next invocation.
5. **Edge: user toggles back to the currently-effective language**: picking the language that equals the launch-effective one should NOT show the restart notice (nothing to apply). Covered by the C4 `pendingRestart` comparison.
6. **Edge: stored value corrupted by an out-of-band write** (`"de"`): getter fail-closes to `.system`; picker shows System; no crash; the extension applies no override (System).
