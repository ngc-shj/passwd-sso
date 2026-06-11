# Plan: iOS app localization (i18n — en + ja via String Catalog)

## Project context
- Type: `mixed` — native iOS app (SwiftUI host + AutoFill extension). NOT security-sensitive: this externalizes ~74 hardcoded English UI strings into String Catalogs and adds Japanese translations. No auth/crypto/data-model/network change. (Security review dimension is therefore expected to be near-empty.)
- Test infrastructure: `unit tests only` (XCTest). SwiftUI rendering + on-device language switching are manual; the String-Catalog **translation-coverage** check IS unit-testable (parse the `.xcstrings` JSON and assert every string unit has a `ja` translation).

## Problem
The iOS app has ZERO localization: every user-facing string is a hardcoded English literal (verified: no `.xcstrings`, no `.lproj`, no `NSLocalizedString`/`String(localized:)`/`LocalizedStringKey`; `project.yml` has `developmentLanguage: en`, no `knownRegions`). The web app is `next-intl` ja-default and the user's data is Japanese; the iOS chrome should localize to Japanese on a Japanese device.

## Objective
On a Japanese-locale device, all app/extension chrome renders in Japanese; on other locales, English (the development language). Achieved with two Xcode **String Catalogs** (`.xcstrings`) — one per bundle (host app, AutoFill extension) — plus `ja` translations, driven by the device locale.

## Technical approach
- **String Catalog (.xcstrings)** (Xcode 15+, compiles on the iOS-18 SDK CI uses — Xcode 16.4). SwiftUI `Text`/`Label`/`Button`/`.navigationTitle`/`.searchable(prompt:)`/`Section`/etc. take `LocalizedStringKey`, so those literals **auto-localize** against the catalog with the English text as the key — NO code change for them. Only **plain-`String`** sites (error-message assignments, enum label properties, the "biometrics" fallback) must switch to `String(localized:)`.
- **Two catalogs** because strings resolve per-bundle: `ios/PasswdSSOApp/Localizable.xcstrings` (host) and `ios/PasswdSSOAutofillExtension/Localizable.xcstrings` (extension). xcodegen globs each target's directory, so dropping the files in places them in the right target. The `Shared` framework has no user-facing strings (verified) → no catalog there.
- **Device-locale-driven**, base = `en`, add `ja`. Out of scope: a forced/in-app locale override synced from the web locale pref (follow-up).
- **Do NOT translate**: brand `passwd-sso`; Apple biometry product names `Face ID` / `Touch ID` (Apple localizes these system-side; we keep the literals and never put them in the catalog as translatable — or mark "don't translate"); URLs/placeholders that are example URLs; `#if DEBUG` strings; `error.localizedDescription` passthroughs (already system-localized).

## Contracts

### C1 — String Catalogs + xcodegen/`knownRegions` wiring (locked)
- Add `ios/PasswdSSOApp/Localizable.xcstrings` and `ios/PasswdSSOAutofillExtension/Localizable.xcstrings`, each a String Catalog with `sourceLanguage: "en"` and localizations for `en` (extracted) + `ja` (authored).
- `project.yml`: add `knownRegions: [en, ja]` under `options:` (keep `developmentLanguage: en`). Run `xcodegen generate` and confirm the regenerated `.xcodeproj` lists both regions and includes each catalog in its target's resources.
- **CI-parity risk (mandatory verification)**: CI regenerates the pbxproj from `project.yml` via xcodegen (Xcode 16.4). Verify a clean `xcodegen generate` + build resolves `ja` (the catalog's languages must survive the regeneration — xcodegen must not drop `ja` from `knownRegions`). If xcodegen does not propagate catalog languages into `knownRegions`, set them explicitly in `project.yml` and document it. (Lesson from the ToolbarSpacer CI break: verify against the CI toolchain, not just local Xcode.)
- Forbidden pattern: none specific.
- Acceptance: `xcodegen generate` then build-for-testing succeeds; the built app bundle contains `ja.lproj`/compiled catalog for both targets; switching the simulator to Japanese renders Japanese (manual).

### C2 — Host-app string migration (locked)
- **Auto-localized (NO code change)** — these are already `LocalizedStringKey` literals; just ensure the English text appears as a key in the host catalog: every `Text("…")`, `Label("…", …)`, `Button("…")`, `.navigationTitle("…")`, `.searchable(prompt:)`, `Section("…")`, `SecureField/TextField` placeholders, `ProgressView("…")`, `.accessibilityLabel("…")` enumerated in the inventory (RootView "Sign in again"; SignInView "Signing in…", "Sign in to passwd-sso"; ServerURLSetupView "Continue"/"Server Setup"/instruction; SettingsView headers/pickers/footers/"Done"; VaultUnlockView instruction/"Master passphrase"/"Unlock"; EntryEditform→EntryForm titles/sections/placeholders/footer/"Cancel"/"Save"; EntryDetailView sections/"Retry"/"Edit"/"Decrypting…"/"Not set"/"Recording — content hidden"; VaultListView "Settings"/"Lock"/"More"/"Search"/"Clear search"/"Create entry"/"No entries"/"No matches"; TOTPCodeView "Copy"/"Copied!").
- **Plain-`String` → `String(localized:)`** (REQUIRED code changes — these are NOT in a `LocalizedStringKey` position):
  - `VaultUnlockView.attemptUnlock`: `errorMessage = "Incorrect passphrase. Please try again."` and `"Unable to unlock vault. Check your connection and try again."` → `String(localized:)`.
  - `EntryForm.save`: `saveError = "Save failed: \(error.localizedDescription)"` → `String(localized: "Save failed: \(error.localizedDescription)")` (format key `"Save failed: %@"`).
  - `ServerURLSetupView` error strings ("Enter a valid https://…", `ProbeError` "Could not reach \(url)…") → `String(localized:)` (format key for the interpolated one).
  - `SettingsView` `AppTheme.label` ("System"/"Light"/"Dark") and any enum-derived picker labels that are plain `String` → `String(localized:)`.
  - `RootView` biometry label: `"biometrics"` fallback → `String(localized: "biometrics")`. **`"Face ID"`/`"Touch ID"` stay literal (NOT localized).** The `localizedReason` `"Unlock your passwd-sso vault."` → `String(localized:)`.
- Keep `"passwd-sso"` literal everywhere (brand, not in catalog). DEBUG strings (`"Load Test Vault (DEBUG)"`) excluded (leave literal / not translated).
- Acceptance: grep shows no user-facing host string remains a bare non-`LocalizedStringKey` `String` literal except the documented exclusions; build passes.

### C3 — AutoFill-extension string migration (locked)
- Extension catalog gets: CredentialPickerView ("Search all entries"/"Cancel"/"No matches"/"No passwords for this site"/"Search to browse all entries."/"Fill for app?"/the interpolated "Fill **%@** for app:\n%@"/"Fill"/"Confirm Fill"); OneTimeCodePickerView ("Search all entries"/"Cancel"/"No matches"/"No one-time codes for this site"/"Search to browse all entries."); LockedFallbackView ("Vault is Locked"/instruction/"OK"/"Cancel"). All are `LocalizedStringKey` literals → auto-localize; the interpolated CredentialPickerView line uses markdown bold + interpolation — verify it extracts to a sane format key and the `**…**` markdown still renders.
- `"passwd-sso"` literal (brand). 
- Acceptance: extension built bundle contains the ja catalog; manual fill flow shows Japanese on a ja device.

### C4 — Plurals + interpolation (locked)
- `SettingsView` `"\(minutes) minutes"` and `"\(seconds) seconds"` are Picker option `Text`. In the host catalog, mark these keys to **vary by plural** (English: one/other → "%lld minute"/"%lld minutes"; Japanese: single form "%lld 分"/"%lld 秒"). Verify the SwiftUI `Text("\(minutes) minutes")` extraction produces a `%lld`-format key that the catalog's plural variations bind to.
- Interpolated format keys: `"Unlock with %@"`, `"Save failed: %@"`, `"Could not reach %@. …"`, `"Fill **%@** for app:\n%@"` — author en + ja with the args in the right order/positions (`%1$@` etc. where order differs in ja).
- Acceptance: en device shows "1 minute"/"5 minutes" correctly; ja device shows "1 分"/"5 分"; interpolations render with correct substitution in both.

### C5 — Japanese translations (locked)
- Author `ja` strings for every key in both catalogs (the ~74-string inventory). Natural, concise Japanese matching the web app's terminology where applicable (e.g. "設定", "ロック", "検索", "エントリがありません", "このサイトのパスワードはありません", "Vault はロックされています" — align "Vault" wording with existing app copy). Provide the full key→ja mapping in the catalogs.
- Acceptance: C6 coverage test passes (every key has a non-empty `ja` translation marked `translated`).

### C6 — Coverage test + no regression (locked)
- New unit test `LocalizationCatalogTests`: load each `Localizable.xcstrings` (as a bundle resource or via a path relative to the test) , parse the JSON, and for EVERY `strings` entry assert it has a `localizations.ja.stringUnit.value` (non-empty) with `state == "translated"` (and likewise the source `en`). Fail listing any key missing a `ja` translation. (This is the automated guard against shipping an untranslated key — the realistic i18n regression.) Plural entries: assert the `variations.plural` `ja` forms exist.
  - Testability note (RT2): the test reads the `.xcstrings` JSON file — feasible in XCTest (bundle resource or file path). If bundling the raw catalog into the test target is awkward, add it as a test resource or read via `#filePath`-relative path; document the chosen mechanism.
- `build-for-testing` + `test-without-building` pass; all existing ~301 tests green + the new coverage test. No new warnings. `xcodegen`-regenerated build (CI parity) resolves `ja`.

## Testing strategy
- Unit: `LocalizationCatalogTests` (ja coverage for every key, both catalogs, incl. plural variations).
- Manual (device/simulator, documented in `ios-i18n-plan-manual-test.md`): set the device to Japanese → verify each screen (setup, sign-in, unlock, list, detail, edit, settings, AutoFill picker, one-time-code picker, locked fallback) renders Japanese; set to English → renders English; verify plurals (1 vs 5 minutes), interpolations (biometry label, "Save failed: …"), and that `passwd-sso`/`Face ID`/`Touch ID` are NOT translated.

## Considerations & constraints
- **knownRegions/xcodegen** is the main risk — verify the CI toolchain (Xcode 16.4) build resolves `ja` after `xcodegen generate` (C1).
- **Two bundles**: host + extension catalogs are independent; a string used in both (e.g. "Cancel", "passwd-sso") is duplicated across catalogs (acceptable; they're separate bundles).
- **Apple product names**: `Face ID`/`Touch ID` are not translated (Apple's own localization covers the system prompt; our label stays as the product name). `passwd-sso` brand stays literal.
- **`error.localizedDescription`** passthroughs are already device-localized by the system; we don't re-localize them (only our wrapping text, e.g. "Save failed: %@").
- **Out of scope**: in-app locale override / syncing the web locale preference to iOS (device-locale only for now); RTL languages; localizing entry/user data; the password-generator (not present on iOS).

## User operation scenarios
- Japanese device: open app → "設定"/"ロック"/"検索"/"エントリがありません"; unlock screen in Japanese; AutoFill picker "このサイトのパスワードはありません" etc.
- English device: same screens in English.
- Settings auto-lock options read "5 minutes" (en) / "5 分" (ja); "Unlock with Face ID" / "Face ID でロック解除" with "Face ID" kept as the product name.

## Round 1 Review Resolutions (triangulate)
_(appended after Step 1-4)_

## Go/No-Go Gate
| ID  | Subject                                                  | Status |
|-----|----------------------------------------------------------|--------|
| C1  | String Catalogs + knownRegions + xcodegen/CI verify      | locked |
| C2  | Host-app string migration (auto + plain-String→localized)| locked |
| C3  | AutoFill-extension string migration                      | locked |
| C4  | Plurals + interpolation format keys                      | locked |
| C5  | Japanese translations (full key→ja)                      | locked |
| C6  | Coverage test + no regression (CI-parity build)          | locked |
