# iOS Workspace Draft

This directory is the planned home for the native iOS implementation of `passwd-sso`.

The initial goal is to ship an iPhone MVP that matches the browser extension's core value using native iOS AutoFill primitives.

## Planned Layout

```text
ios/
  PasswdSSO.xcodeproj
  PasswdSSOApp/
  PasswdSSOAutofillExtension/
  Shared/
```

## Target Responsibilities

### `PasswdSSOApp/`

- server URL setup
- sign-in
- vault unlock
- vault list, search, and detail
- settings
- lock/logout flows
- debug/status surfaces useful during MVP development

### `PasswdSSOAutofillExtension/`

- AutoFill extension entrypoints
- credential lookup and matching
- password fill
- TOTP fill
- locked-vault fallback
- no-match fallback

### `Shared/`

- API client
- session state
- secure storage adapters
- vault models
- crypto helpers
- TOTP
- URL matching
- app/extension bridge types

## Initial Architecture Decisions

- Use `SwiftUI` for app UI.
- Use `AuthenticationServices` for AutoFill integration.
- Use `ASWebAuthenticationSession` for initial web-based sign-in unless a blocker appears.
- Use Keychain for secrets.
- Use App Group only for minimal shared state between app and extension.

## Scope Notes

The MVP baseline is the browser extension, not the full web admin surface.

In scope:

- sign-in
- unlock
- password AutoFill
- TOTP AutoFill
- personal vault read path
- team vault read path
- manual credential edit (personal entries)

Out of scope for the first slice:

- tenant admin flows
- SCIM
- audit-log management UI
- MCP/service-account workflows
- browser-specific UI patterns

### Manual edit

The browser extension's "save credential after sign-in" flow has no iOS equivalent (no callback into a third-party AutoFill extension after a successful sign-in). Manual edit inside `PasswdSSOApp` replaces it. Team-vault edit is deferred to a future MVP iteration; for now, edit team entries via the web app.

## Building Locally

The Xcode project is generated from `project.yml` via [XcodeGen](https://github.com/yonaskolb/XcodeGen). The `.xcodeproj` is committed for ease of opening in Xcode but must be regenerated whenever `project.yml`, entitlements, or target source layouts change.

### Prerequisites

- Xcode 17 (Xcode 26.x) with iOS Simulator runtime ≥ 17.2 installed (for AutoFill TOTP path testing) and ≥ 26.0 (matching SDK family) for actual builds
- `brew install xcodegen` — version pinned via Homebrew; CI uses the same Homebrew install

### Regenerate the Xcode project

```bash
cd ios
xcodegen generate
```

Run this any time `project.yml`, an entitlements file, or an `Info.plist` template changes.

### Build / test

The most reliable destination spec on Xcode 26.x is an explicit simulator UDID against a booted simulator. Name-based lookup (`name=iPhone 16 Pro`) can flake when an unavailable physical device confuses Xcode's destination catalog.

```bash
# from repo root — boot any iOS-17+ iPhone simulator first
SIM_UDID=$(xcrun simctl create "iPhone 16 Pro" "iPhone 16 Pro" "iOS26.1")
xcrun simctl boot "$SIM_UDID"

# Build
xcodebuild \
  -project ios/PasswdSSO.xcodeproj \
  -scheme PasswdSSOApp \
  -destination "platform=iOS Simulator,id=$SIM_UDID" \
  -configuration Debug \
  build

# Run unit + UI tests
xcodebuild \
  -project ios/PasswdSSO.xcodeproj \
  -scheme PasswdSSOApp \
  -destination "platform=iOS Simulator,id=$SIM_UDID" \
  -configuration Debug \
  test
```

For the iOS 17.0 minimum-deployment-target validation (AutoFill TOTP `prepareOneTimeCodeCredentialList(for:)` regression check), substitute `iOS17.2` for the runtime parameter when creating the simulator.

### Targets

| Target | Type | Bundle ID |
|--------|------|-----------|
| `PasswdSSOApp` | iOS application | `com.passwd-sso` |
| `PasswdSSOAutofillExtension` | iOS app extension (`ASCredentialProvider`) | `com.passwd-sso.PasswdSSOAutofillExtension` |
| `Shared` | iOS framework | `com.passwd-sso.Shared` |
| `PasswdSSOTests` | XCTest unit bundle | `com.passwd-sso.PasswdSSOTests` |
| `PasswdSSOUITests` | XCUITest UI bundle | `com.passwd-sso.PasswdSSOUITests` |

### Entitlements

`PasswdSSOApp`, `PasswdSSOAutofillExtension`, and `PasswdSSOTests` all share:

- **App Group**: `group.com.passwd-sso.shared` — shared file container for opaque ciphertext blobs
- **Keychain Access Group**: `$(AppIdentifierPrefix)com.passwd-sso.shared` — shared `bridge_key_blob` storage

The shared entitlement on `PasswdSSOTests` is intentional and required for the cross-process bridge-key XCTest (per plan §"Cross-Process Bridge-Key Test — split into XCTest + XCUITest", T17).

`PasswdSSOAutofillExtension`'s `Info.plist` declares `NSExtension.NSExtensionAttributes.ASCredentialProviderExtensionCapabilities.ProvidesOneTimeCodes = YES` for the iOS 17+ TOTP AutoFill path.

## Side-channel controls

Four defenses are active in the host app to prevent credential leakage through OS-level side channels:

### 1. App-Switcher snapshot blur

`PasswdSSOAppApp.swift` observes `@Environment(\.scenePhase)`. When `scenePhase != .active` (i.e., `.inactive` or `.background`), a full-screen `Rectangle().background(.ultraThinMaterial)` overlay is shown via a `ZStack`. The overlay fires during `.inactive`, which is the phase iOS uses when compositing the App Switcher snapshot — earlier than `.background`. This ensures no vault content appears in the system's thumbnail.

### 2. `.privacySensitive()` on sensitive text

Three sites carry `.privacySensitive()`:

| View | Field |
| ---- | ----- |
| `EntryDetailView` | Revealed password text (`Text(password)` inside `passwordRow`) |
| `EntryDetailView` | Notes body (`Text(d.notes)`) |
| `TOTPCodeView` | Live TOTP code display (`TextField` bound to `currentCode`) |

iOS redacts these fields in system screenshots, Siri suggestions, and the QuickType bar when the view is marked privacy-sensitive.

### 3. Screen-recording overlay

`VaultListView` and `EntryDetailView` listen for `UIScreen.capturedDidChangeNotification`. When `UIScreen.main.isCaptured == true`, an opaque overlay obscures the vault content. This blocks screen-recording and AirPlay mirroring leakage.

### 4. Pasteboard protection

`TOTPCodeView.copyToClipboard()` uses `UIPasteboard.general.setItems(_:options:)` with:

- `.localOnly: true` — prevents the code from syncing to Handoff / Universal Clipboard
- `.expirationDate: Date().addingTimeInterval(60)` — auto-clears the pasteboard after 60 seconds

## Rollback flag drain

The rollback flag mechanism guards against a compromised host app writing a stale cache counter into the extension's App Group container (cache rollback attack).

### Flag format (written by `AppGroupRollbackFlagWriter`)

```text
<canonical JSON payload>\n<HMAC-SHA256 base64url>
```

HMAC key is derived via `HKDF(inputKeyMaterial: vaultKey, info: "rollback-flag-mac", salt: Data(repeating: 0, count: 32))`. The JSON payload records `expectedCounter`, `observedCounter`, `headerIssuedAt`, and `rejectionKind`.

### Host-app drain (run before every foreground sync)

`RollbackFlagDrain.drainPendingFlags(vaultKey:)` is called in `PasswdSSOAppApp`'s `.onChange(of: scenePhase)` handler **before** `HostSyncService.runSync`. The drain:

1. Reads `rollback-flag.json` from the App Group directory.
2. Verifies the HMAC with the current `vaultKey`.
3. On **valid HMAC**: posts `CacheRollbackReportBody` to `POST /api/mobile/cache-rollback-report` with the payload's `rejectionKind`.
4. On **invalid HMAC** (tampered flag): posts with `rejectionKind: "flag_forged"`.
5. Deletes the flag file on HTTP 200; keeps it on any error for the next drain cycle.

The stable `deviceId` in every report is a UUID generated once and stored in App Group `UserDefaults` (`group.com.passwd-sso.shared`) via `DeviceIdentifier.stable()`.

## References

- Plan: [docs/archive/review/ios-autofill-mvp-plan.md](../docs/archive/review/ios-autofill-mvp-plan.md)
- Browser extension baseline: [extension/](../extension)
