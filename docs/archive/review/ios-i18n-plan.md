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

### C1 — String Catalogs + xcodegen region derivation (locked, revised R1: F1)
- Add `ios/PasswdSSOApp/Localizable.xcstrings` and `ios/PasswdSSOAutofillExtension/Localizable.xcstrings`, each a String Catalog with `sourceLanguage: "en"` and localizations for `en` (extracted) + `ja` (authored).
- **`knownRegions` mechanism (F1 — corrected)**: do NOT add `knownRegions: [en, ja]` under `project.yml` `options:` — xcodegen **silently ignores** `options.knownRegions` (empirically verified: a project with that key still regenerated `knownRegions = (Base, en)`). The `.xcodeproj` `knownRegions`/`ja` region is **auto-derived by xcodegen from the catalog content**: a `.xcstrings` that contains an authored `ja` localization causes the regenerated pbxproj to list `Base, en, ja`; an `en`-only catalog reverts to `Base, en`. Keep `developmentLanguage: en`. Consequence: **C5 (authoring the `ja` units) is a hard prerequisite for C1's region-verification** — run the region check only after `ja` units exist, not against an `en`-only catalog. There is no working `options:` fallback to force a region; the catalog content is the single lever.
- **CI-parity verification (mandatory)**: CI regenerates the pbxproj from `project.yml` via xcodegen (Xcode 16.4). After authoring `ja`, run a clean `xcodegen generate` and confirm the regenerated `.xcodeproj` lists `ja` in `knownRegions` and includes each catalog in its target's resources, then build-for-testing and confirm the built bundle compiles `ja.lproj`. (Lesson from the ToolbarSpacer CI break: verify against the CI toolchain, not just local Xcode 26. C6 adds a runtime `Bundle.main.localizations` assertion so this top risk is CI-guarded, not manual-only.)
- Forbidden pattern: `pattern: knownRegions:` in `project.yml` — reason: F1, `options.knownRegions` is dead config and signals the wrong mental model; region derivation is catalog-driven.
- Acceptance: with `ja` authored, `xcodegen generate` then build-for-testing succeeds; regenerated pbxproj `knownRegions` includes `ja`; the built app bundle contains `ja.lproj`/compiled catalog for both targets; `Bundle.main.localizations` contains `ja` (C6); switching the simulator to Japanese renders Japanese (manual).

### C2 — Host-app string migration (locked)
- **Auto-localized (NO code change)** — these are already `LocalizedStringKey` literals; just ensure the English text appears as a key in the host catalog: every `Text("…")`, `Label("…", …)`, `Button("…")`, `.navigationTitle("…")`, `.searchable(prompt:)`, `Section("…")`, `SecureField/TextField` placeholders, `ProgressView("…")`, `.accessibilityLabel("…")` enumerated in the inventory (RootView "Sign in again"; SignInView "Signing in…", "Sign in to passwd-sso"; ServerURLSetupView "Continue"/"Server Setup"/instruction; SettingsView headers/pickers/"Done" (NOT the idle-time footer — see F8 below); VaultUnlockView instruction/"Master passphrase"/"Unlock"; EntryEditform→EntryForm sections/placeholders/footer/"Cancel"/"Save" (NOT `navigationTitle` — see F2 below); EntryDetailView "Retry"/"Edit"/"Decrypting…"/"Not set"/"Recording — content hidden" (NOT the `fieldRow` section labels — see F2 below); VaultListView "Settings"/"Lock"/"More"/"Search"/"Clear search"/"Create entry"/"No entries"/"No matches"; TOTPCodeView "Copy"/"Copied!").
- **Plain-`String` → `String(localized:)`** (REQUIRED code changes — these are NOT in a `LocalizedStringKey` position):
  - `VaultUnlockView.attemptUnlock`: `errorMessage = "Incorrect passphrase. Please try again."` and `"Unable to unlock vault. Check your connection and try again."` → `String(localized:)`.
  - `EntryForm.save`: `saveError = "Save failed: \(error.localizedDescription)"` → `String(localized: "Save failed: \(error.localizedDescription)")` (format key `"Save failed: %@"`). **(F4)** Localize at this **assignment** site; `error.localizedDescription` is a system passthrough (not re-localized).
  - `ServerURLSetupView` error strings ("Enter a valid https://…", `ProbeError` "Could not reach \(url)…") → `String(localized:)` (format key for the interpolated one). **(F4)** Convert the literal at the **assignment / `ProbeError.errorDescription`** site (`ServerURLSetupView.swift:35,115`), NOT at `Text(message)` — `Text(message)` with a `String` variable is the non-localizing overload and must stay as-is (it renders the already-localized runtime string). `SignInView` `.error(message:)` → `Text(message)` is the same shape; the `"DEBUG: …"` string stays excluded.
  - `SettingsView` `AppTheme.label` ("System"/"Light"/"Dark") and any enum-derived picker labels that are plain `String` → `String(localized:)`.
  - `RootView` biometry label: `"biometrics"` fallback → `String(localized: "biometrics")`. **`"Face ID"`/`"Touch ID"` stay literal (NOT localized).** The `localizedReason` `"Unlock your passwd-sso vault."` → `String(localized:)`. **(F7)** `"biometrics"` and the consuming template `"Unlock with %@"` (extracted from `Label("Unlock with \(biometryLabel)", …)`, VaultUnlockView.swift:63) are **two separate keys** — author both; the `%@` arg receives either an unlocalized product name (`"Face ID"`) or the localized `"biometrics"`. Do NOT fold `Face ID` into the template.
- **Plain-`String` sites the inventory previously mis-bucketed as auto-localized (F2 — REQUIRED conversion)**:
  - `EntryForm.navigationTitle` (`EntryEditForm.swift:124,143-148`): `var navigationTitle: String` returns `"New Entry"`/`"Edit Entry"`, consumed at `.navigationTitle(navigationTitle)`. A `String` **variable** binds the `StringProtocol` overload → NOT localized. Convert the computed property to return `LocalizedStringKey` (or apply `String(localized:)` to the two literals). Add `"New Entry"`/`"Edit Entry"` to the host catalog + ja.
  - `EntryDetailView.fieldRow(label:)` (`EntryDetailView.swift:107,109,153-154`): `Section(label)` where `label: String` (function parameter, callers pass `"Username"`/`"URL"`) → `StringProtocol` overload → NOT localized. Change the parameter to `label: LocalizedStringKey` (callers pass literals → localize) or pass `String(localized:)`. Add `"Username"`/`"URL"` to the host catalog + ja.
  - `SettingsView` idle-time footer (`SettingsView.swift:82-83`): `Text("The vault locks after this much idle time …" + "AutoFill needs the app unlocked … Face ID.")` is a `String + String` **concatenation** → runtime `String` → `StringProtocol` overload → NOT localized, and Xcode auto-extraction emits **no key** for it **(F8)**. Note F3 previously mis-bucketed this footer as auto-localized — it is not. Fix: merge the two literals into a **single** `LocalizedStringKey` string literal (no `+`) so one key extracts, and add that key to the C5 ja authoring checklist as a guaranteed-present key. (This is the only `Text(… + …)` site in host or extension — verified by repo-wide grep.)
- Keep `"passwd-sso"` literal everywhere (brand, not in catalog). DEBUG strings (`"Load Test Vault (DEBUG)"`) excluded (leave literal / not translated).
- **Inventory completeness (F3)**: the per-category lists above end in "etc." — they are NOT the authoritative key set. Before authoring `ja`, build once and inspect the **generated** catalog (Xcode auto-extraction) to get the exact key list, which includes at minimum these previously-omitted host strings: SettingsView `"Auto-Lock"`/`"On Timeout"`/`"Log Out"`/`"Security"`/the idle-time footer/`"Clipboard"`/`"Auto-Clear"`/`"Appearance"`/`"Theme"` (SettingsView.swift:69-96); EntryDetailView `"Couldn't decrypt this entry."`/`"One-Time Code"`/`"Tags"` and its "kept when you save an edit here" footnote (EntryDetailView.swift:46,121,132,139) — **distinct** from EntryForm's similar "kept on save" footnote (EntryEditForm.swift:111); treat the two footnotes as separate keys.
- Acceptance: grep shows no user-facing host string remains a bare non-`LocalizedStringKey` `String` literal except the documented exclusions (incl. the F2 `navigationTitle`/`fieldRow` conversions and the F8 footer); the grep also flags any `Text(… + …)` concatenation (the F8/F9 non-extraction trap) — there must be none after the fix; the generated catalog's key set is the authoring checklist for C5; build passes.

### C3 — AutoFill-extension string migration (locked)
- Extension catalog gets: CredentialPickerView ("Search all entries"/"Cancel"/"No matches"/"No passwords for this site"/"Search to browse all entries."/"Fill for app?"/the interpolated "Fill **%@** for app:\n%@"/"Fill"/"Confirm Fill"); OneTimeCodePickerView ("Search all entries"/"Cancel"/"No matches"/"No one-time codes for this site"/"Search to browse all entries."); LockedFallbackView ("Vault is Locked"/instruction/"OK"/"Cancel"). All are `LocalizedStringKey` literals → auto-localize; the interpolated CredentialPickerView line uses markdown bold + interpolation — verify it extracts to a sane format key and the `**…**` markdown still renders.
- `"passwd-sso"` literal (brand). 
- Acceptance: extension built bundle contains the ja catalog; manual fill flow shows Japanese on a ja device.

### C4 — Plurals + interpolation (locked)
- `SettingsView` `"\(minutes) minutes"` and `"\(seconds) seconds"` are Picker option `Text` (`minutes`/`seconds` are `Int`). In the host catalog, mark these keys to **vary by plural** (English: one/other → "%lld minute"/"%lld minutes"; Japanese: single form → **`other` category only** "%lld 分"/"%lld 秒"). **(F6)** Japanese has no count distinction, so the ja `variations.plural` supplies only `other` (no `one`); the C6 coverage test must treat a ja plural unit with `other` and no `one` as complete. Verify the SwiftUI `Text("\(minutes) minutes")` extraction produces a `%lld`-format key that the catalog's plural variations bind to.
- Interpolated format keys: `"Unlock with %@"`, `"Save failed: %@"`, `"Could not reach %@. …"`, `"Fill **%1$@** for app:\n%2$@"` — author en + ja with the args in the right order/positions (`%1$@` etc. where order differs in ja). **(F5)** The CredentialPickerView markdown-bold key (`CredentialPickerView.swift:118`) is the highest-risk one: author it explicitly with positional specifiers — en `"Fill **%1$@** for app:\n%2$@"`, ja keeping `**%1$@**` (so bold still renders) and `\n%2$@`. A dropped/reordered `%@` without positional specifiers yields wrong substitution.
- Acceptance: en device shows "1 minute"/"5 minutes" correctly; ja device shows "1 分"/"5 分"; the CredentialPicker fill line renders bold + correct substitution in both locales; interpolations render with correct substitution in both.

### C5 — Japanese translations (locked)
- Author `ja` strings for every key in both catalogs (the ~74-string inventory). Natural, concise Japanese matching the web app's terminology where applicable (e.g. "設定", "ロック", "検索", "エントリがありません", "このサイトのパスワードはありません", "Vault はロックされています" — align "Vault" wording with existing app copy). Provide the full key→ja mapping in the catalogs.
- Acceptance: C6 coverage test passes (every key has a non-empty `ja` translation marked `translated`).

### C6 — Coverage test + no regression (locked, revised R1: T1/T2/T3/T4/T5/T6)
- New unit test `LocalizationCatalogTests` in the `PasswdSSOTests` target. For EVERY non-skipped `strings` entry, **branch on shape (T7)**: if the entry has `localizations.ja.stringUnit`, assert its `value` is non-empty with `state == "translated"`; if instead it has `localizations.ja.variations.plural`, apply the plural assertion below (a plural key has NO top-level `stringUnit` — do not assert one on it, or the auto-lock keys false-fail); a non-skipped entry with neither shape is a failure. Fail listing any key missing a `ja` translation. (This is the automated guard against shipping an untranslated key — the realistic i18n regression.)
- **Source-language assertion (T8)**: for the source `en` units, assert only non-empty `value` (presence) — do NOT require `state == "translated"`; auto-extracted source units often carry no explicit `state`, and asserting it produces false failures. The `state == "translated"` check applies to the `ja` (target) units only.
- **Coverage scope caveat (F9)**: this test guards translation-completeness of **extracted** keys only. A string that never extracts into the catalog (a runtime-`String` `Text`, a `Text(… + …)` concatenation — see F8) is invisible to it. That non-extraction class is caught by the C2 grep-acceptance (now flagging `Text(… + …)`) plus the manual device pass — not by C6.
- **Load mechanism (T1/T2 — locked, not open-ended)**: read each **source** `Localizable.xcstrings` via a **`#filePath`-relative path** (`URL(filePath: #filePath)` → walk up to repo `ios/` → `PasswdSSOApp/Localizable.xcstrings` and `PasswdSSOAutofillExtension/Localizable.xcstrings`), then parse the raw JSON. Rationale: a `.xcstrings` added to the test target's *resources* build phase is **compiled** into `.lproj`/`.strings`, so `url(forResource:"Localizable", withExtension:"xcstrings")` returns nil — the bundle-resource idiom used by `URLMatchingTests`/`TOTPVectorTests` does not work for a raw catalog. The `#filePath` source-of-truth read validates the committed catalogs directly. **Caveat (documented)**: `#filePath` resolves to the compile-machine source path and relies on the iOS Simulator sharing the host filesystem — true for this project's CI (`xcodebuild test` on a simulator) but it would break on a physical-device runner; if device testing is ever added, switch to a verbatim-copied `type: file` resource.
- **Do-not-translate carve-out (T3 — required)**: brand/product strings that the auto-extractor may pull into a catalog key (`passwd-sso`, `Face ID`, `Touch ID`) must be marked `"shouldTranslate": false` in the catalog, and the coverage test MUST **skip** entries where `shouldTranslate == false`. This prevents a false failure (red on an intentionally-English key) and a false fix (a brand name getting translated to satisfy the test). Full strings that merely *contain* the brand inline (e.g. `"Sign in to passwd-sso"`) are normal translatable keys — only standalone brand/product keys get `shouldTranslate: false`.
- **Plural assertion (T4/F6)**: for plural keys, require `en` has `one` + `other` and `ja` has at least `other` (no `one`), each non-empty + `translated`. Cover the two auto-lock plural keys (minutes, seconds).
- **Runtime region guard (T6)**: add an assertion that the **built host bundle** actually compiled `ja`: `XCTAssertTrue(Bundle.main.localizations.contains("ja"))`. This converts the C1 knownRegions/xcodegen "top risk" from manual-only to a CI-guarded check (a regression that drops `ja` from the build then fails CI instead of shipping green). The JSON-content checks validate source completeness for both catalogs; this guards the host build's `ja` resolution.
- **Keychain safety (T5)**: `LocalizationCatalogTests` does pure JSON parsing — it MUST NOT instantiate `BridgeKeyStore` or any keychain/production type (the `precondition(service.hasSuffix("bridge-key"))` process-abort trap, BridgeKeyStore.swift:100-101, would crash the whole bundle — the #540 trap). Confirmed N/A as long as the test stays JSON-only.
- `build-for-testing` + `test-without-building` pass; all existing tests (≈299) green + the new coverage test (the earlier "~301" figure was approximate). No new warnings. `xcodegen`-regenerated build (CI parity) resolves `ja` (now asserted by the runtime guard above). Create `docs/archive/review/ios-i18n-plan-manual-test.md` with the device/locale-switch steps; it must use placeholder server URLs/emails (RS4 pre-emptive guard).

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

Three experts reviewed against the live codebase. Security: **no findings** (static-string i18n; no auth/crypto/data-flow change). Functionality: 1 Critical + 2 Major + 4 Minor. Testing: 3 Major + 3 Minor. All accepted and folded into the contracts above. Full review: `ios-i18n-review.md`.

- **F1 (Critical) → C1**: `options.knownRegions` is a no-op; `ja` region is auto-derived from catalog content → C5 is a prerequisite for C1's region check. Added forbidden pattern `knownRegions:` in project.yml.
- **F2 (Major) → C2**: added `EntryForm.navigationTitle` (String var) and `EntryDetailView.fieldRow(label: String)` → `Section(label)` as required `LocalizedStringKey` conversions; added `"New Entry"`/`"Edit Entry"`/`"Username"`/`"URL"` to the inventory.
- **F3 (Major) → C2**: replaced "etc." inventory with a build-then-inspect-the-generated-catalog instruction; enumerated the ~12 omitted SettingsView/EntryDetailView strings; flagged the two distinct footnotes.
- **F4/F5/F6/F7 (Minor) → C2/C4**: assignment-site localization for interpolated errors; positional `%1$@/%2$@` for the markdown-bold fill key; ja plural `other`-only; biometrics as two separate keys.
- **T1/T2 (Major) → C6**: locked the load mechanism to `#filePath`-relative source read (bundle-resource fails — raw `.xcstrings` is compiled); documented the simulator-FS caveat.
- **T3 (Major) → C6**: do-not-translate keys marked `shouldTranslate: false`; coverage test skips them.
- **T4/T5/T6 (Minor) → C6**: plural assertion shape; corrected test count + keychain-free test; runtime `Bundle.main.localizations` guard for the knownRegions top risk; manual-test doc with placeholder URLs (RS4).

**Round 2** verified all R1 fixes correct and surfaced 4 more (2 Major, 2 Minor), now folded in:
- **F8 (Major) → C2**: `SettingsView.swift:82-83` idle-time footer is a `String + String` concatenation → non-localizing, no key extracted; F3 had mis-bucketed it as auto-localized. Fix: merge into one `LocalizedStringKey` literal; add to C5 checklist. (Only `Text(… + …)` site in the app.)
- **T7 (Major) → C6**: plural keys have no top-level `localizations.ja.stringUnit` (value is under `variations.plural`); the test must branch per-entry on shape or the auto-lock keys false-fail.
- **F9/T8 (Minor) → C2/C6**: C2 grep now flags `Text(… + …)` to close the non-extraction blind spot C6 can't see; source `en` units assert value-presence only (not `state == "translated"`, which auto-extracted source units often omit).

Note (non-blocking): R2 observed the plan's "Xcode 16.4" references may be stale vs the actual `ci.yml` toolchain (uses `xcode-select` latest stable; sim step comments reference Xcode 26.x). The verification mechanism doesn't depend on the exact version, so left as prose.

**Round 3** confirmed all R2 fixes correct and surfaced one residual: **F10 (Minor) → C2** — the auto-localized bucket still listed SettingsView "footers" (and EntryForm "titles"/EntryDetailView "sections"), contradicting F8/F2 which reclassify those as required conversions. Fixed by carving them out of the auto-localized enumeration. Plan **converged** — all C1–C6 `locked`, ready for Phase 2.

## Implementation Checklist (Step 2-1)

**Code conversions (plain-String → localized):**
- [ ] `RootView.swift:164` `"biometrics"` → `String(localized:)`; `:172` `localizedReason` → `String(localized:)` (Face ID/Touch ID stay literal)
- [ ] `ServerURLSetupView.swift:35` literal → `String(localized:)`; `:115` `ProbeError.errorDescription` → `String(localized:)` (key `"Could not reach %@. …"`)
- [ ] `SettingsView.swift:13-18` `AppTheme.label` System/Light/Dark → `String(localized:)`; `:81-84` footer merge `+` into one `LocalizedStringKey` literal (F8)
- [ ] `EntryEditForm.swift:208` save error → `String(localized:)` (key `"Save failed: %@"`); `:143-148` `navigationTitle` → `LocalizedStringKey` (F2)
- [ ] `EntryDetailView.swift:153` `fieldRow(label: String)` → `label: LocalizedStringKey` (F2)
- [ ] `VaultUnlockView.swift:139,143` errors → `String(localized:)`

**Catalogs (build-then-extract, then author ja):**
- [ ] `ios/PasswdSSOApp/Localizable.xcstrings` (host) + `ios/PasswdSSOAutofillExtension/Localizable.xcstrings` (ext)
- [ ] `shouldTranslate:false` keys: `passwd-sso`, example URLs (`https://my.passwd-sso.example`, `https://example.com`), `Load Test Vault (DEBUG)` (host); `passwd-sso` (ext)
- [ ] Plural keys `%lld minutes` / `%lld seconds` (host): en one+other, ja other-only
- [ ] Interpolation keys: host `Save failed: %@`, `Could not reach %@. …`, `Unlock with %@`; ext `Fill **%@** for app:\n%@` (ja uses `%1$@/%2$@`)

**Wiring / test:**
- [ ] `project.yml` — NO `knownRegions` under options (F1); catalogs auto-glob into target dirs; `xcodegen generate`
- [ ] `PasswdSSOTests/LocalizationCatalogTests.swift` — `#filePath` source read, branch stringUnit/plural, skip `shouldTranslate:false`, en presence-only, runtime `Bundle.main.localizations` host guard
- [ ] `docs/archive/review/ios-i18n-plan-manual-test.md` (placeholder URLs)

**Reused patterns:** existing tests use `Bundle(for:)` for JSON fixtures (`URLMatchingTests.swift:29`); the catalog test deliberately uses `#filePath` instead (T1/T2 rationale). No shared i18n helper exists (greenfield). CI: `.github/workflows/ci.yml` runs `xcodegen generate` + `xcodebuild test` on simulator.

## Go/No-Go Gate
| ID  | Subject                                                  | Status |
|-----|----------------------------------------------------------|--------|
| C1  | String Catalogs + xcodegen region derivation (R1: F1)    | locked |
| C2  | Host-app string migration (R1: F2/F3/F4/F7)              | locked |
| C3  | AutoFill-extension string migration                      | locked |
| C4  | Plurals + interpolation format keys (R1: F5/F6)          | locked |
| C5  | Japanese translations (full key→ja)                      | locked |
| C6  | Coverage test + no regression (R1: T1–T6)                | locked |
