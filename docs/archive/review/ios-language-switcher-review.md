# Plan Review: ios-language-switcher
Date: 2026-06-21T06:03:24Z
Review round: 3 (cumulative log)

## Round 3 — Extension brought into scope (C7/C8, C1.localeOverride)
After the user asked "AutoFillも修正するのは難しい？", the extension was brought INTO scope (案A). New contracts C7 (extension `.environment(\.locale,)` injection at the single `presentSwiftUI` choke point), C8 (extension catalog no-regression), and C1 gained `localeOverride: Locale?`. Round-3 verification:
- **Load-bearing claim CONFIRMED TRUE** (Functionality): SwiftUI `Text(LocalizedStringKey)` honors `.environment(\.locale,)` for `.xcstrings` lookup, including interpolated/markdown cases; the extension `.appex` compiles both `ja`+`en` (`PasswdSSO.xcodeproj/project.pbxproj:942-946`), so the environment locale has real localizations to select. `presentSwiftUI` (`CredentialProviderViewController.swift:653-672`) is the SOLE SwiftUI host — no bypass. 0 `String(localized:)` in the extension verified.
- **Security: No findings** — a non-secret language-code read across an App Group that already shares wrapped keys; fail-closed getter + closed-enum→`Locale` mapping; purely presentational (no biometric/lock/crypto logic touched).
- **T9 (Major) — applied**: assert `localeOverride?.identifier == "ja"` not `Locale==Locale` (ICU canonicalization → cross-image flakiness).
- **F8/F9 (Minor) — applied**: read + wrap MUST live inside `presentSwiftUI`, never cached at init.
- **T10 (Minor) — applied**: added the one automatable C7 slice (App-Group cross-store read of `appLanguage`); render stays VC3 manual.

## Round 2 — Fix verification
All Round-1 findings (F1-F5, T1-T6) verified RESOLVED. New trivial doc nits: F6 (shouldTranslate:false entries carry no value block — cosmetic), F7 (test count is 30 not ~35 — cosmetic), T7 (pin the array-comparison type in the .standard-guard test), T8 (endonym presence not asserted by the skip — relies on VC). These are non-blocking documentation refinements.

## Changes from Previous Round
Round 1: Initial review. Round 2: verified fixes. Round 3: extension scope added + verified.

## Functionality Findings

### F1 [Critical]: Endonym labels via literal Text/String(localized:) will fail LocalizationCatalogTests
- File: plan C5 (line 125); Evidence: `Localizable.xcstrings:2137` ("System" has `extractionState:"stale"`), `LocalizationCatalogTests.swift:64`
- Problem: The Swift compiler auto-extracts string literals passed to `Text(_:)` / `String(localized:)` into the catalog. So `Text("English")` / `Text("日本語")` become new catalog keys with no `ja` translation → `LocalizationCatalogTests` fails. C5's premise that "literal Swift strings avoid the catalog" is false.
- Impact: The plan's chosen mechanism breaks the very test C5 claims to protect (requirement line 27).
- Fix: Add `"日本語"` / `"English"` as catalog entries with `"shouldTranslate": false` (the test skips those at line 64), OR render endonyms from a Swift `String` variable that does not bind the `Text(LocalizedStringKey)` overload (per the String Catalog memory note).

### F2 [Major]: `launchEffectiveCode` comparison under-specified; wrong pendingRestart for `.system` on non-en device
- File: plan C4 (line 111), C1 forbidden-pattern (line 60); Evidence: `project.yml:7`
- Problem: C4 offers two non-equivalent sources for `launchEffectiveCode` ("bundle resolved OR stored preference"). For `.system` on a `ja` device, comparing the picked enum to a resolved BCP-47 code needs `.system` resolved to a concrete code — but C1 forbids `Locale.current`, the obvious tool. Result: spurious or missed restart notice (Scenario 1/4 mishandled).
- Fix: Define comparison in resolved-code space: `launchEffectiveCode = Bundle.main.preferredLocalizations.first`; add `AppLanguage.effectiveCode` (`.ja→"ja"`, `.en→"en"`, `.system→Bundle.main.preferredLocalizations.first`). Amend C1's forbidden-pattern to permit `Bundle.main.preferredLocalizations` (not `Locale.current`) for the `.system` resolve/display path.

### F3 [Major]: AutoFill extension does NOT honor the host's AppleLanguages override (R41 — declared capability without backing path)
- File: plan SC3 (line 160), C2 (line 69), requirement line 20, Scenario 2 (line 169); Evidence: `project.yml:139,190` (extension is `type: app-extension`, distinct bundle id), `AppSettingsStore.swift:21-22` (cross-process state always via App Group, never `standard`)
- Problem: The extension is a separate process with its own `UserDefaults.standard` domain. The host writing `AppleLanguages` to its OWN standard domain does not reach the extension. The promise that the override applies to the AutoFill UI is unmet.
- Fix: Either (a) scope the extension OUT and correct lines 20/160/169 to host-only, OR (b) have the extension read the App-Group `"appLanguage"` key at its own launch and write its OWN `standard.AppleLanguages` (note timing: `preferredLocalizations` resolves early in launch, so it may only take effect on the following extension launch — validate before promising it).

### F4 [Minor]: C3 test count wrong (22 vs ~35) and the "except" clause is contradictory
- File: plan C3 (line 102); Evidence: `AppSettingsStoreTests.swift` (~35 `func test…`)
- Problem/Fix: Cosmetic. Correct the count; drop the "except where they opt into the new parameter" clause (existing tests need no change — `systemDefaults` is defaulted). The R19 source-compatibility claim itself is correct.

### F5 [Minor]: Picker label source unspecified; should mirror `AppTheme.label`
- File: plan C4 (line 108-113); Evidence: `SettingsView.swift:13-19,137-141`
- Fix: Specify an `AppLanguage.label` extension mirroring `AppTheme.label`: `.system → String(localized: "System")` (reuse existing key), `.ja`/`.en` via the F1-resolved endonym path.

## Security Findings

**No findings.** This is a localization-code persistence feature; it does not touch auth, crypto, session, or vault data. The plan's classifications are correct:
- App Group UserDefaults (not Keychain) is right for a non-secret enum (matches `AppTheme`/`vaultTimeoutAction`/`tenantAutoLockMinutes`).
- The `appLanguage` getter fail-closes on garbage; `AppleLanguages` receives only validated enum-derived constants, never the raw stored string (RS3/RS5 satisfied).
- Relaunch DROPS the in-memory vault key and the launch invariant clears credential identities (`PasswdSSOAppApp.swift:127-132`) — strictly stronger, no auto-lock bypass.
- RS4: plan file contains no PII/secrets.
- escalate: false.

## Testing Findings

### T1 [Major]: No explicit isolation/teardown contract for the injected `systemDefaults` suite
- File: plan C3 (line 100), strategy (line 150); Evidence: `AppSettingsStoreTests.swift:20-25` (tearDown removes ONE suite)
- Fix: C3 acceptance must require the second suite be created in `setUp` and `removePersistentDomain`'d in `tearDown`, not deferred to "the existing pattern" (which covers one suite).

### T2 [Major]: `systemDefaults = .standard` default re-opens the real-domain leak hole
- File: plan C3 (line 94); Evidence: existing tests use bare `AppSettingsStore(defaults:)` (the copy-paste hazard)
- Problem: A language test that forgets to inject `systemDefaults` writes `["ja"]` into the host process's REAL `UserDefaults.standard.AppleLanguages`, contaminating sibling locale-sensitive tests.
- Fix: C3 acceptance must require EVERY `appLanguage` test inject a throwaway `systemDefaults`; add a guard test asserting `.standard` was not mutated.

### T3 [Minor] (RT7): `.system`-removes-key test is not provable-red without a precondition write
- File: plan C2 acceptance (line 82); Evidence: `AppSettingsStoreTests.swift:185-190` (precondition pattern)
- Fix: Pin the test as Arrange `set .ja` (assert `["ja"]` present) → Act `set .system` → Assert key nil. The garbage-value cases are already provable-red.

### T4 [Minor] (RT6/R12): `AppLanguage.allCases` ordering invariant has no test
- File: plan C1 (line 62), strategy (line 150)
- Fix: Add `testAppLanguageAllCasesOrdering` asserting `allCases == [.system,.ja,.en]` + per-case `rawValue` round-trip. Picker order depends on it.

### T5 [Minor]: C5 endonym literals have zero automated coverage
- File: plan C5 (line 125); Evidence: `LocalizationCatalogTests.swift:56` (only scans catalog keys)
- Fix: Interacts with F1 — if endonyms become `shouldTranslate:false` catalog entries (F1 fix (a)), assert their presence; otherwise record a manual VC3 item so a typo is caught.

### T6 [Minor] (R19): Call-site enumeration complete; add the extension's bare init
- Evidence: 7 production sites + ~30 test constructions all source-compatible. Add `CredentialProviderViewController.swift:602` to C3's enumeration so the reviewer confirms the extension's bare `AppSettingsStore()` is intentional (it never sets `appLanguage`).

### T7 [Minor] [Adjacent → Functionality]: `testHostBundleCompiledJapanese` is robust to T2 pollution
- Confirms the plan's VC1 split (persistence in-process testable; visual flip manual) is accurate. No action.

## Adjacent Findings
- T7 (Testing → Functionality): informational, confirms VC1 testability split; no action.

## Quality Warnings
None (Ollama merge skipped; manual dedup performed — F2/T1/T2 are distinct concerns, not duplicates).

## Recurring Issue Check

### Functionality expert
- R1: Checked — "System" reuse correctly mandated (xcstrings:2136-2152). See F5.
- R2: Checked — enum rawValues/keys appropriate.
- R3: Finding F5 — mirror AppTheme.label / @AppStorage precedents.
- R4-R18: N/A — no mutations/events/DB/migrations/roles for a local UI setting.
- R19: Checked — defaulted systemDefaults source-compatible (F4 corrects count only).
- R20-R24: N/A.
- R25: Finding F2 — persist/read-back symmetric; derived launchEffectiveCode asymmetric for .system.
- R26-R36: N/A.
- R37: Checked — no jargon in user-facing strings.
- R38-R40: N/A.
- R41: Finding F3 — extension override capability has no backing path.

### Security expert
- R1-R41: N/A — iOS-native, local-only, no network/DB/auth surface.
- RS1: N/A — no credential compare.
- RS2: N/A — no new routes (SC1).
- RS3: Checked — getter fail-closes; AppleLanguages gets only whitelisted constants.
- RS4: Checked — no PII/secrets in plan.
- RS5: Checked — closed whitelist enum.

### Testing expert
- R1: Checked — round-trip covers happy path.
- R2: Checked — "System" reuse verified.
- R3-R11: N/A.
- R12: Finding T4 — AppLanguage ordering invariant untested.
- R13-R18: N/A.
- R19: Finding T6 — sites compat; extension site unflagged.
- R20-R41: N/A.
- RT1: Checked — real UserDefaults, no mock.
- RT2: Checked — in-process round-trip on injected suite verifiable.
- RT3: Checked — no literal drift.
- RT4: N/A — no concurrency.
- RT5: Checked — real UserDefaults exercised.
- RT6: Finding T4 — allCases ordering not in strategy.
- RT7: Finding T3 — .system-removes-key needs precondition write.
