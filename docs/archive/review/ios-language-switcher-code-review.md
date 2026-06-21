# Code Review: ios-language-switcher

## FULL-BRANCH Code Review (immediate-switch + theme-sheet fixes)
Date: 2026-06-21T14:11:24Z — fresh /triangulate Phase-3 over `origin/main...HEAD` (9 commits).

### Round 1 findings & resolution
- **F1 [Major] — RESOLVED**: residual risk the open Settings sheet would not re-localize in place — cross-`.sheet`-boundary `.environment(\.locale,)` propagation from RootView is unreliable (it had failed on-device once, commit `d56de6df`). Fix: `SettingsView` now directly `@ObservedObject`s `LanguageRefresh.shared`, so a `bump()` re-runs the sheet's OWN body (no dependence on cross-boundary propagation). Round-2 verification confirmed: `@Published token`→`objectWillChange` reliably re-runs `SettingsView.body`; `applyAppLanguage()` re-points the bundle BEFORE `bump()`; all ~20 sheet strings (Section headers, footers, picker titles/options, navigationTitle, Done, LabeledContent, endonym labels) re-resolve; no retain cycle; harmless RootView+SettingsView dual-observation. **F1 resolved, Round-2 clean.**
- **F2 / T1 [Minor] — RESOLVED**: endonyms `"日本語"`/`"English"` were NOT in the catalog (labels worked by absent-key fallback, contradicting the code comment). Added both as `shouldTranslate:false` catalog entries so the documented contract is real and `LocalizationCatalogTests` covers them (it skips `shouldTranslate:false`).
- **F3 [Minor] — RESOLVED**: `LanguageRefresh` doc comment still described the rejected `.id(token)` mechanism; updated to the `@ObservedObject`-driven body re-eval.
- **F4 [Minor] — RESOLVED**: `sheetColorScheme` used `.first` window scene (unordered Set, fragile under multi-window / transitions); now prefers the `.foregroundActive` scene and falls back to `UITraitCollection.current` instead of hard `.light`.
- **T2 [Minor] — RESOLVED**: added `testAppThemeColorScheme` pinning `.light`/`.dark`/`.system→nil` (the explicit-theme slice of the sheet-revert fix; the device-resolution branch is manual).
- **T3 [Minor — acknowledged]**: RootView `.environment(\.locale,)` integration is manual/UITest-only; constituent pieces (`localeOverride`, `token`) are unit-covered.
- **Security: No findings** (S1-S5): swizzle overrides only `localizedString`; the `AppLanguage` enum is the path-construction validation gate (no traversal); `.environment`-not-`.id` preserves vault/lock state; extension path purely presentational; no PII.

### Verification
- Build: pass. Full `xcodebuild test`: pass (incl. LocalizationCatalogTests, both string-path switch tests, theme test). iOS guard: pass.
- **Manual VC (REQUIRED)**: signed-in — (1) Settings open, ja↔en switches the sheet's labels in place without dismissal; (2) switching language while unlocked does NOT re-lock; (3) System→Light→System: sheet AND app both return to device appearance; (4) AutoFill follows language next invocation.

---

## ARCHITECTURE PIVOT — Code Review (immediate-switch rewrite)
Date: 2026-06-21T12:15:25Z

### Why the rewrite
The original restart-to-apply / `AppleLanguages`-write approach had a confirmed runtime bug: システム→英語 worked, but 英語→日本語 left the UI in English. Root cause (empirically verified on the simulator): `Bundle.main.preferredLocalizations` is resolved ONCE at process launch, so an in-app `AppleLanguages` write only affects the *next* launch and was directionally unreliable. Reworked to switch **immediately** (no restart) via a `Bundle.main` swizzle.

### New mechanism
- `ios/Shared/Storage/LanguageBundle.swift` (new): a `Bundle` subclass installed on `Bundle.main` via `object_setClass`, overriding `localizedString(forKey:value:table:)` to resolve from the chosen `.lproj`. Covers `Text("…")` / `NSLocalizedString`. Plus `L10n.string(_:)` (resolves `String(localized:bundle:)` against the active `.lproj`, since Swift's bare `String(localized:)` does NOT route through the swizzle) and `LanguageRefresh` (ObservableObject token for re-render).
- All ~27 host `String(localized:)` sites swept to `L10n.string(...)`.
- `AppSettingsStore.appLanguage` no longer writes `AppleLanguages`; adds `applyAppLanguage()`. Removed `systemDefaults` param + `effectiveCode`.
- App `init()` calls `applyAppLanguage()` at launch; root re-localizes via `.environment(\.locale,)` keyed off `languageRefresh.token`. The extension calls `applyAppLanguage()` at presentation.

### Findings & resolution
- **F1 [Critical] — RESOLVED**: the first cut used `.id(languageRefresh.token)` on the root ZStack, which would tear down `RootView` and reset its `@State appState` — dropping the in-memory `vaultKey` and **re-locking the vault on every language change**. (Functionality expert flagged it; the Security expert's S3 reached the opposite conclusion, claiming vault state lived on the App struct — resolved by reading the code: the vault key is in `RootView.appState`'s `.vaultUnlocked` case, `RootView.swift:43,70`, inside the `.id()`'d subtree, so F1 is correct.) Fixed by removing `.id()` and re-localizing via a `\.locale` environment change keyed to the refresh token (`PasswdSSOAppApp.swift:136-159`), which re-evaluates subtree bodies WITHOUT changing RootView identity — vault/session state preserved.
- **Security: No findings** (S1-S4). The flagged path-traversal probe (appLanguage code → `Bundle(path:)`) is NOT exploitable: the `AppLanguage` enum is the validation gate (`appLanguage` getter fail-closes unknown values to `.system`), production callers pass only `nil`/`"ja"`/`"en"`, and `path(forResource:ofType:)` does not do raw path concatenation. The swizzle overrides ONLY `localizedString` (no Info.plist / code-signing / resource shadowing). The `.id`-removal fix keeps vault/session/lock state untouched.
- **T1 [Major] — RESOLVED**: the process-global swizzle reset was in a body-`defer`; moved to `tearDown()` (`LanguageBundle.setLanguage(nil)`) so a leaked override cannot make sibling tests locale-dependent.
- **T2 [Major] — RESOLVED**: `testAppLanguageLabels` compared two different resolution paths; now compares `AppLanguage.system.label` against the same-path `L10n.string("System")`.
- **T3 [Major] — RESOLVED**: added `testApplyAppLanguageRePointsL10nStringBothDirections` — the swizzle test only proved the `Text`/NSLocalizedString path; this covers the `L10n.string` path the swept call sites actually use. Also added `testLanguageRefreshBumpIncrementsToken` (RT6).
- **T6 [Minor — acknowledged, manual]**: the F1 fix's "re-localize without teardown, preserve RootView `@State`" guarantee is a SwiftUI view-graph behavior — not unit-testable; covered by manual VC (on-device ja↔en switch while unlocked, confirm vault stays unlocked).

### Verification
- Build: pass. Full `xcodebuild test`: pass (incl. new L10n/swizzle/refresh tests). iOS diagnostic-logging guard: pass.
- **Manual VC (REQUIRED before merge)**: on sim/device — (1) ja↔en immediate switch with no restart; (2) switching language while the vault is UNLOCKED does NOT re-lock it (the F1 fix); (3) AutoFill extension follows the language on next invocation.

---

# (Prior round — original restart-to-apply approach, superseded by the pivot above)
Date: 2026-06-21T06:47:57Z
Review round: 1

## Changes from Previous Round
Initial code review (Phase 3) of the implemented diff (`git diff origin/main...HEAD`; local `main` is stale, real base is `origin/main`). 8 files: 5 code + 3 docs.

## Functionality Findings
No Critical/Major findings. Implementation is contract-faithful (C1-C8 verified against the code):
- C2 getter fail-closes; setter writes App-Group `appLanguage` + `systemDefaults` `AppleLanguages` (standard domain, never the App-Group suite).
- C4 `pendingRestart` compares `effectiveCode` vs `launchEffectiveCode` in resolved-code space; no `.environment(\.locale,)` in the host.
- C5 catalog: `"Language"`/restart-notice translated ja/en; `"日本語"`/`"English"` are `shouldTranslate:false`; `"System"` reused (no duplicate).
- C7 `.environment(\.locale,)` applied at the single `presentSwiftUI` choke point, read fresh (not cached); `.system → nil → unchanged view`.
- D1 production code (`.system` → `removeObject`) confirmed correct; only the test assertion was adjusted for the suite→global fall-through.

- **F1 [Minor — no action]**: `@State language` seeded via a second `AppSettingsStore()` (SettingsView.swift) — forced by Swift's stored-property-init ordering (can't reference `store`). Both read the same App-Group suite; behavior correct.
- **F2 [Minor — no action]**: `@State language` seeded once; cannot drift because this view is the sole writer of `appLanguage` and the screen is re-presented fresh. Intended design.

## Security Findings
**No findings.** Non-secret language code; closed-enum validation; fail-closed reads; no logging; `AppleLanguages` write receives only enum-derived `["ja"]`/`["en"]`/removal (no raw-string injection); extension change is purely presentational (does not touch biometric/lock/decrypt). RS3 (boundary validation) and RS4 (no PII in diff/docs) pass. escalate: false.

## Testing Findings
- **T3 [Major] — RESOLVED**: `AppLanguage.label` (new computed property in SettingsView.swift) was unit-testable but untested; it encodes the C5/F1 endonym-reuse contract (a regression swapping an endonym or routing `.system` through a different/untranslated key would ship silently). Fixed by adding `testAppLanguageLabels` asserting `.ja.label == "日本語"`, `.en.label == "English"`, `.system.label == String(localized: "System")`.
- **T1/T2/T4/T5/T6/T7/T8 [Minor — confirmations]**: leak guard, `.system`-removes-key provable-red (precondition write + `!= ["ja"]`), `localeOverride?.identifier` (T9 contract), `allCases` ordering, dual-suite setUp/tearDown, cross-store hand-off — all verified correct.
- **T9 [Minor] — RESOLVED**: stale class doc comment updated to mention auto-copy TOTP / tenant policy / app language.

## Adjacent Findings
- Functionality F-side noted the D1 test-assertion as [Adjacent → Testing]; covered by the Testing expert's T2 (confirmed correct).

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
- R1-R41: Checked. Key passes — R2 ("System" reuse, no duplicate), R12 (exhaustive `AppLanguage` switches, no `default`), R19 (defaulted `systemDefaults` keeps all 7 call sites compatible), R23 (no `Locale.current`; bundle-localizations / explicit identifiers per C1 carve-out), R41 (`AppleLanguages` written only to standard domain; `.environment(\.locale,)` for the all-`Text` extension). Remainder N/A (no SQL/auth/crypto/network/migration).

### Security expert
- R1-R41: N/A — iOS-local UserDefaults + SwiftUI + string catalog; no injection sink/auth/crypto/route/dependency change.
- RS1: Pass (no secrets; language codes only). RS2: Pass (no auth/authz touched). RS3: Pass (closed-enum fail-closed validation). RS4: Pass (no PII in diff/docs). RS5: Pass (no logging added).

### Testing expert
- R1-R41: R2 pass ("System" reused, no duplicate); R12 pass (rawValues match catalog codes, ordering test guards `allCases`); R19 pass (defaulted param, 7 call sites compatible). Remainder N/A.
- RT1: Pass (UUID suites, torn down, no real-domain pollution). RT2: Pass (injected UserDefaults suites at the boundary). RT3: Pass (fresh suite per test). RT4: Pass (no sleeps; `.identifier` + loose `.system` contains avoid cross-image flakiness). RT5: Pass (asserts stored value + side-effect array). RT6: Pass after T3 fix (`AppLanguage`/`appLanguage`/`effectiveCode`/`localeOverride`/`label` all covered). RT7: Pass (all new tests provable-red).

## Environment Verification Report
Phase 1 declared VC1 (host restart-to-apply), VC2 (System-follows-device), VC3 (extension live locale switch).
- **VC1 — blocked-deferred (manual)**: the host visual string flip requires a real app relaunch, which `xcodebuild test` cannot drive in-process. The persistence half IS verified: `verified-local` via `testAppLanguageJa/En/SystemSetsAppleLanguages` (`xcodebuild test -scheme PasswdSSOApp` — all pass). Links to Phase 1 VC1. No deviation-log cost-justification needed beyond the inherent OS constraint (relaunch resolves `preferredLocalizations` once at launch).
- **VC2 — blocked-deferred (manual)**: System-follows-device rendering depends on the sim's configured language; the branch logic (remove key) IS `verified-local` via `testAppLanguageSystemRemovesAppleLanguages`. Links to Phase 1 VC2.
- **VC3 — blocked-deferred (manual)**: the extension `.environment(\.locale,)` render requires the real AutoFill presentation flow (host app's login form invoking the credential provider), not drivable from a unit test. The unit-testable halves ARE `verified-local`: `testAppLanguageLocaleOverride` (the `localeOverride` mapping) and `testAppLanguageReadsAcrossSeparateStoresOnSameSuite` (the App-Group hand-off). Links to Phase 1 VC3.

All three are inherent OS/runtime constraints predicted in Phase 1, not hidden skips. The maximal unit-testable slice of each path is verified-local.

## Resolution Status
### T3 [Major] AppLanguage.label untested
- Action: Added `testAppLanguageLabels` asserting endonyms + `.system` reuse of the "System" key.
- Modified file: ios/PasswdSSOTests/AppSettingsStoreTests.swift:333-341
- Verified: `xcodebuild test` — testAppLanguageLabels passes; full suite green.

### T9 [Minor] Stale class doc comment
- Action: Updated the class doc to list auto-copy TOTP / tenant policy / app language.
- Modified file: ios/PasswdSSOTests/AppSettingsStoreTests.swift:7-10

## Tightening-only skip — Round 2
Round-2 verification confirmed T3 RESOLVED. Two new findings, both applied directly (no Round 3 — every finding is inline-minor, within the Round-1 fix scope, no security-boundary touch):
- **T10 [Minor]** — `.system` label assertion was value-tautological; added `XCTAssertNotEqual(.system.label, .ja.label/.en.label)` so a regression routing `.system` to an endonym key is caught. (ios/PasswdSSOTests/AppSettingsStoreTests.swift testAppLanguageLabels)
- **T11 [Trivial]** — `AppLanguage.label` doc comment clarified: `.system` is safe because it reuses an existing TRANSLATED "System" key (en "System"/ja "システム"), distinct from the `shouldTranslate:false` endonyms — not because it is untranslated. (ios/PasswdSSOApp/Views/SettingsView.swift:23-28)

Justification: both findings scoped within the Round-1 fix range (the `testAppLanguageLabels` test and the `label` accessor), inline minor (test-assertion strengthening + comment wording), no security-boundary touch. Verified: testAppLanguageLabels passes; full suite green.
