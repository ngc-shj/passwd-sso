# Plan: iOS App Icon

## Project context
- Type: `mixed` — native iOS app (Swift/SwiftUI, xcodegen-managed) within a Next.js monorepo.
- Test infrastructure: `unit tests only` (PasswdSSOTests). An app icon has no unit-testable
  surface; verification is the asset-catalog compile during `xcodebuild`. Per Phase-1 project-context
  rule, "add automated tests" findings for this asset-only change are downgraded to Minor notes.

## Objective
Give `PasswdSSOApp` a real app icon. Currently `ios/PasswdSSOApp` has no `Assets.xcassets` and
`project.yml` sets no `ASSETCATALOG_COMPILER_APPICON_NAME`, so the app ships with the blank
placeholder icon on the Home Screen and in Settings → AutoFill & Passwords.

## Requirements
Functional:
- A 1024×1024 single-size iOS AppIcon renders on device Home Screen, Spotlight, Settings.
- Icon is brand-consistent: full-bleed `#5B57D6` background with the white keyhole emblem
  (circle + trapezoid stem) reused from `public/icon.svg`.

Non-functional:
- **No alpha channel / transparency** in the 1024 PNG. App Store validation rejects an alpha
  channel on the marketing icon; iOS applies its own corner mask, so the art must be a full-bleed
  opaque square.
- Reproducible: generation is a committed script (mirrors existing `scripts/generate-icons.sh`),
  not a one-off manual export. Source art is a committed SVG.
- xcodegen-clean: `xcodegen generate` must wire the catalog without manual `.xcodeproj` edits.

## Technical approach
- Add committed source art `ios/scripts/app-icon.svg` (1024 viewBox): opaque `#5B57D6` `<rect>`
  full square + white keyhole centered (circle + trapezoid), scaled/recentered for full-bleed.
  Confirmed no remote `href`/`<image>`/`<foreignObject>`/`<script>` (security review: rendered only
  by `rsvg-convert` at author time, never by the app).
- Add `ios/scripts/generate-app-icon.sh`: `rsvg-convert` → 1024 PNG, then ImageMagick
  `-background "#5B57D6" -flatten -alpha off -depth 8 -define png:color-type=2 PNG24:…` to guarantee
  an opaque, alpha-free, 8-bit RGB PNG (F4: actool/App-Store reject alpha and prefer 8-bit true-color;
  `-alpha off` alone does not pin depth/colortype). Output to
  `ios/PasswdSSOApp/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png`. The script self-asserts its
  output (size 1024×1024, `hasAlpha=no`, depth 8) at the tail and exits non-zero on violation (T3).
- Add asset catalog:
  - `ios/PasswdSSOApp/Assets.xcassets/Contents.json` (catalog root).
  - `ios/PasswdSSOApp/Assets.xcassets/AppIcon.appiconset/Contents.json` (single-size iOS format).
  - `AppIcon-1024.png` (committed; the script regenerates it).
- `ios/project.yml`: add `ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon` to `PasswdSSOApp.settings.base`.
  The existing `sources: - path: PasswdSSOApp` already globs the new `.xcassets` in; no new source
  entry needed.

## Contracts

### C1 — Asset catalog structure (locked)
- `ios/PasswdSSOApp/Assets.xcassets/AppIcon.appiconset/Contents.json` declares exactly one image:
  `{ filename: "AppIcon-1024.png", idiom: "universal", platform: "ios", size: "1024x1024" }`,
  plus `info: { author: "xcode", version: 1 }` (F3: canonical Xcode single-size bytes).
- Acceptance (T1 — build success alone does NOT prove registration; actool downgrades a
  missing/empty icon to a *warning* and the build still exits 0): after `build-for-testing`,
  POSITIVELY assert the built bundle carries the icon:
  `plutil -extract CFBundleIcons.CFBundlePrimaryIcon.CFBundleIconName raw "$BUILT_APP/Info.plist"`
  returns `AppIcon` (exit 0). This is the real proof, not "build passed".
- Note (F2): the merge of `CFBundleIcons` into the bundled Info.plist is done by actool's
  `--output-partial-info-plist`, independent of `GENERATE_INFOPLIST_FILE=NO` and the explicit
  `info:` plist. Do NOT hand-add `CFBundleIcons` to `PasswdSSOApp/Info.plist` — it would be wrong.
- Forbidden patterns:
  - `pattern: "idiom" : "iphone"` in AppIcon Contents.json — reason: using the legacy
    per-size idiom format reintroduces the multi-size requirement; single-size universal is intended.

### C2 — Opaque icon, no alpha (locked)
- `AppIcon-1024.png` is exactly 1024×1024, 8-bit RGB, no alpha channel.
- Acceptance (T2 — `sips -g` is a QUERY that exits 0 regardless of value; it must be turned into a
  real assertion). Parse and test, non-zero exit on violation:
  ```sh
  w=$(sips -g pixelWidth  AppIcon-1024.png | awk '/pixelWidth/{print $2}')
  h=$(sips -g pixelHeight AppIcon-1024.png | awk '/pixelHeight/{print $2}')
  a=$(sips -g hasAlpha    AppIcon-1024.png | awk '/hasAlpha/{print $2}')
  [ "$w" = 1024 ] && [ "$h" = 1024 ] && [ "$a" = no ] \
    || { echo "icon contract violated: ${w}x${h} alpha=$a"; exit 1; }
  ```
  Depth is pinned at generation via `-depth 8 -define png:color-type=2`.
- Forbidden patterns:
  - `pattern: -alpha on` — reason: generation must strip, not preserve, alpha.

### C3 — project.yml wiring + pre-existing drift fix (locked)
- `PasswdSSOApp.settings.base` gains `ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon`.
- T4 (pre-existing drift, must fix in this PR): origin/main's committed
  `ios/PasswdSSO.xcodeproj/project.pbxproj` ALREADY contains `ASSETCATALOG_COMPILER_APPICON_NAME =
  AppIcon` (2 occurrences) while `project.yml` does NOT — a latent inconsistency. CI runs
  `xcodegen generate` which overwrites pbxproj from project.yml, so today that setting is dead
  (would vanish on CI regen) and the catalog it points to is absent. Adding the setting to
  project.yml + committing the regenerated pbxproj makes the tree self-consistent.
- F1: xcodegen also auto-injects this setting from the `AppIcon.appiconset` presence, so the
  explicit project.yml line is belt-and-suspenders — kept for intent-locking/clarity, not because
  the build depends solely on it.
- Acceptance: after `xcodegen generate`,
  `xcodebuild -showBuildSettings -scheme PasswdSSOApp | grep ASSETCATALOG_COMPILER_APPICON_NAME`
  reports `AppIcon` (proving the value comes from project.yml, not stale pbxproj); committed pbxproj
  matches the regenerated output.

### C4 — Reproducible generation (locked)
- `ios/scripts/generate-app-icon.sh` regenerates `AppIcon-1024.png` from `ios/scripts/app-icon.svg`
  deterministically; re-running produces a byte-stable-enough PNG (same dimensions, no alpha).
- Acceptance: running the script on a clean checkout (with `rsvg-convert` + `magick` present)
  yields a 1024×1024 alpha-free PNG; the script fails fast with a clear message if either tool is absent.

## Testing strategy
- Primary: `cd ios && xcodegen generate` then
  `xcodebuild -project PasswdSSO.xcodeproj -scheme PasswdSSOApp -configuration Debug
  -destination "platform=iOS Simulator,name=iPhone 16 Pro" build-for-testing` — must succeed with
  the catalog compiled (C1/C3).
- `sips` assertion on the PNG for C2.
- No new unit test: an app-icon asset has no logic surface (project-context downgrade applies).
- Manual device check (user): icon appears on Home Screen + Settings → AutoFill list.

## Considerations & constraints
- **Extension icon out of scope**: AutoFill credential-provider extensions display no Home Screen
  icon; Settings → AutoFill & Passwords lists the provider using the host app's icon. So
  `PasswdSSOAutofillExtension` needs no AppIcon. (If a future iOS surface shows a per-extension icon,
  revisit — tracked as a note, not a TODO, since no current surface requires it.)
- **Design**: full-bleed `#5B57D6` + white keyhole; the shield silhouette from `public/icon.svg`
  is intentionally dropped because shield-on-transparent does not survive the opaque-square
  requirement legibly at small sizes. User-approved.
- **No marketing/App Store submission in this PR** — icon presence only; store metadata is separate.

## User operation scenarios
- Fresh install on device → Home Screen shows purple keyhole icon (not blank placeholder).
- Settings → AutoFill & Passwords → provider row shows the host icon, not a generic placeholder.
  (T5: manual, device-only — the simulator cannot list third-party AutoFill providers, per the
  project's `ios-autofill-host-entitlement` note. Not automatable here; not a regression if unchecked.)
- Spotlight search for "passwd" → result row shows the icon. (T5: manual, device-only.)

## Round 1 Review Resolutions (triangulate)
- **F2 (Major-risk, RESOLVED by review)**: icon registers via actool partial-plist merge despite
  `GENERATE_INFOPLIST_FILE=NO` + explicit Info.plist. No code change; documented in C1.
- **F4 → fixed**: magick pipeline pins 8-bit + PNG24 color-type (technical approach + C2).
- **F1 → noted**: explicit `ASSETCATALOG_COMPILER_APPICON_NAME` kept for clarity (C3).
- **F3 → fixed**: canonical single-size Contents.json bytes pinned (C1).
- **F5 → fixed**: appiconset must ship with Contents.json + PNG, never empty (Go/No-Go).
- **T1 (Major) → fixed**: positive `plutil` Info.plist assertion added (C1).
- **T2 (Major) → fixed**: `sips` query converted to a real awk+test assertion (C2).
- **T3 → fixed**: self-assertion appended to `generate-app-icon.sh` (technical approach).
- **T4 (Major) → fixed**: pre-existing pbxproj/project.yml drift reconciled (C3).
- **T5 → noted**: AutoFill-row/Spotlight checks labeled manual-only (scenarios).
- **Security**: No findings. SVG confirmed free of remote refs.

## Go/No-Go Gate
| ID  | Subject                                  | Status |
|-----|------------------------------------------|--------|
| C1  | Asset catalog structure (single-size)    | locked |
| C2  | Opaque 1024 PNG, no alpha                 | locked |
| C3  | project.yml ASSETCATALOG wiring          | locked |
| C4  | Reproducible generation script           | locked |
