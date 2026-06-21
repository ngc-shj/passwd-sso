# Code Review: ios-language-switcher
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
