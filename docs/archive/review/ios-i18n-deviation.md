# Coding Deviation Log: ios-i18n

## D1 — Xcode-editor `%@` extraction placeholders added as `shouldTranslate:false`
The compiler (xcodebuild / CI) emits `%lld`-spelled keys for `Int` interpolations
(`%lld minutes`, `%lld seconds`, `%lld`) — verified in the compiled
`ja.lproj/Localizable.stringsdict` (`NSStringFormatValueTypeKey => "lld"`, value `%lld 分`).
The Xcode 26 String Catalog **editor** separately writes `%@`-spelled preview keys
(`%@`, `%@ minutes`, `%@ seconds`) into the source on each build. To keep the runtime
keys translated (`%lld …`) AND keep the catalog stable against the live editor + green
under `LocalizationCatalogTests`, the `%@` placeholders are committed as
`shouldTranslate:false` (the test skips them; the editor stops re-adding them as empty
translatable). Runtime localization uses the `%lld` keys; the `%@` entries are inert.

## D2 — `Shared framework v%@` (ContentView scaffold) marked `shouldTranslate:false`
`ContentView.swift` is unused Xcode-template scaffold (the app roots at `RootView`, not
`ContentView`). Its `Text("Shared framework v\(…)")` auto-extracts to `Shared framework v%@`.
Out of i18n scope (not live UI); marked `shouldTranslate:false` rather than translated.
Deleting the dead scaffold is a separate cleanup, not folded into this i18n change.

## D3 — Vault → 保管庫 (user terminology directive)
Per user instruction mid-implementation, "Vault" is rendered as 「保管庫」 in all ja strings
(unlock prompt, lock-error, locked-fallback, settings footer, biometric reason). English
source strings keep "vault"/"Vault" as written.

## D4 — `.gitignore`: `ios/.build*/`
Added so the local verification derived-data dir (`ios/.build-i18n/`) cannot be committed;
generalizes the existing `ios/build/` / `ios/DerivedData/` entries.

## Verification
- `xcodegen generate` → regenerated pbxproj `knownRegions` includes `ja` (auto-derived from catalog content; no `options.knownRegions` needed — confirms plan F1).
- `xcodebuild build-for-testing` + `test` on iPhone 16 / iOS 18.2 simulator: **302 tests, 0 failures** (299 existing + 3 new `LocalizationCatalogTests`), incl. the runtime `Bundle.main.localizations.contains("ja")` host guard.
- No iOS-26-only API introduced (`String(localized:)` iOS 15+, `URL(filePath:)` iOS 16+); deployment target 17.0.
