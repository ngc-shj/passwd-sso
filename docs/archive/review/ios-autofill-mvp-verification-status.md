# iOS AutoFill MVP — Verification Status

Date: 2026-05-03
Branch: `feature/ios-autofill-mvp`

This document records exactly which paths have been exercised end-to-end during MVP development and which paths are **deferred until paid Apple Developer Program enrollment** because of Apple capability/provisioning constraints. It is the authoritative untested-paths reference for reviewers and for the followup verification task.

## Verified

### Build / static analysis

- `xcodebuild test -scheme PasswdSSOApp -destination 'platform=iOS Simulator,id=<UDID>'` → 188 unit + 1 UI = **189 tests PASS** on iOS 18.0 Simulator
- Swift 6 strict concurrency, `GCC_TREAT_WARNINGS_AS_ERRORS=YES`, `SWIFT_TREAT_WARNINGS_AS_ERRORS=YES` → **zero warnings**
- `xcodebuild build` for `PasswdSSOApp` and `PasswdSSOAutofillExtension` succeeds for simulator destination
- `pluginkit -m` registers the credential provider extension with the correct bundle id (`com.passwd-sso.PasswdSSOAutofillExtension`) and extension point (`com.apple.authentication-services-credential-provider-ui`)
- `Simulated.xcent` (the simulator runtime entitlements descriptor) contains `application-identifier`, `com.apple.security.application-groups`, `keychain-access-groups`, and `com.apple.developer.authentication-services.autofill-credential-provider`, all keyed to TeamID `9BL8SUVCSG` (Personal Team)

### Server-side endpoints

- `GET /.well-known/apple-app-site-association` returns the canonical AASA JSON with the right TeamID + basePath-aware `components.path`. Verified live at `https://www.jpng.jp/.well-known/apple-app-site-association` and via the Tailscale-served URL.
- `POST /api/mobile/token` returns Zod-validated `VALIDATION_ERROR` for empty body (route reachable through Apache `ProxyPass` + Next.js basePath).
- DPoP `htu` canonicalization preserves basePath (covered by `htu-canonical.test.ts` 14 cases including `https://www.jpng.jp/passwd-sso/api/mobile/token`).
- AASA route handler `/api/mobile/.well-known/apple-app-site-association/route.ts` covered by 5 unit tests (`route.test.ts`).

### Host-app DEBUG fixture flow (Simulator only)

Verified manually against an iPhone 16 Pro simulator running iOS 18.0:

- `ServerURLSetupView` accepts the `https://www.jpng.jp/passwd-sso` URL, performs the AASA + `/api/health/live` probe, transitions to `SignInView`.
- `SignInView` "Load Test Vault (DEBUG)" button (DEBUG builds only) calls `DebugVaultLoader.loadFixtureVault()` which: generates a fresh bridge_key blob, derives cacheKey, generates a synthetic vault_key, wraps it under cacheKey into `WrappedVaultKey`, builds 3 fixture entries (GitHub / Example / Apple ID) with personal-AAD-bound encrypt, writes the encrypted cache file, and transitions `AppState` to `.vaultUnlocked`.
- `VaultListView` displays all 3 fixture entries with title + username.
- Entry detail navigation works: tapping a row pushes `EntryDetailView` showing username / password / TOTP code / notes (when present).
- TOTP fixture (Example.com `JBSWY3DPEHPK3PXP`) generates the correct code matching `oathtool` output.
- Vault lock + recovery: lock button drops bridge_key Keychain item, vault-locked screen shows "Sign in again" recovery button.

## Not verified (deferred — requires paid Apple Developer Program)

The remaining items below all depend on Provisioning Profile capabilities that **Apple does NOT grant to Free Apple ID / Personal Team** signing identities. Per Apple docs:

- [Supported capabilities (iOS) — Apple Developer](https://developer.apple.com/help/account/reference/supported-capabilities-ios) — capability availability depends on program membership.
- [com.apple.developer.authentication-services.autofill-credential-provider — Apple Developer](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.authentication-services.autofill-credential-provider) — entitlement exists but is gated by membership.
- [com.apple.developer.associated-domains — Apple Developer](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.associated-domains) — same gating.

### A. AutoFill credential provider end-to-end

Status: **iOS Settings filters the extension out of the AutoFill source list** despite full registration.

What was confirmed today on iOS 18.0 / 18.2 Simulator with Personal Team:
- `pluginkit -m -v` lists `com.passwd-sso.PasswdSSOAutofillExtension(0.1.0)` (registered)
- `LaunchServices observer: Installed plugins (...pluginID=com.passwd-sso.PasswdSSOAutofillExtension...)` in syslog
- No rejection / error logs
- BUT `Settings → AutoFill & Passwords → 自動入力の取得元` shows ONLY Apple's "パスワード"; passwd-sso is absent

Likely cause: the simulator provisioning profile under Personal Team does NOT carry the `com.apple.developer.authentication-services.autofill-credential-provider` capability, so iOS treats the entitlement as un-provisioned and filters the extension from the AutoFill source UI. The same build with paid-Developer-Program signing should surface in Settings.

Items NOT executed:
- A1. Open Safari, navigate to a known login URL, tap the "Passwords" key on the keyboard → see passwd-sso suggestions
- A2. Pick a passwd-sso credential → biometric prompt (`LAContext`, `touchIDAuthenticationAllowableReuseDuration = 0`) fires once per fill
- A3. Username + password actually populate the form fields
- A4. TOTP picker (iOS 17+ One-Time-Codes path) presents passwd-sso TOTP entries
- A5. Locked-vault fallback (`LockedFallbackView`) presents when bridge_key is absent
- A6. App-side AutoFill in apps with Associated Domains (per-fill bundle-ID confirmation when `Tenant.allowAppSideAutofill = true`)

### B. ASWebAuthenticationSession + Universal Link OAuth flow

Status: **`SFAuthenticationSession was cancelled by user` immediately after launch on Personal Team.**

Likely cause: the host app does not carry the `com.apple.developer.associated-domains` entitlement under Personal Team, so iOS does not register the Universal Link claim for the app and `.https(host:path:)` callback fails AASA validation (manifesting as "cancelled by user"). With paid-team signing the entitlement is grantable and the OAuth flow can complete.

Items NOT executed:
- B1. Tap "Sign in to passwd-sso" → ASWebAuthenticationSession opens Safari ephemeral session
- B2. Google OIDC sign-in (or any Auth.js provider) completes inside the ephemeral webview
- B3. Server returns 302 to `/passwd-sso/api/mobile/authorize/redirect?code=...&state=...`
- B4. iOS Universal Link claim delivers the callback URL to the host app via `.https` callback
- B5. `AuthCoordinator.startSignIn` parses the bridge code, exchanges via `/api/mobile/token` with DPoP proof, persists access/refresh tokens to per-app Keychain
- B6. `MobileAPIClient.refreshToken()` end-to-end against the production server
- B7. `MobileAPIClient.updateEntry(...)` end-to-end (Step 10 manual edit save)
- B8. `MobileAPIClient.postCacheRollbackReport(...)` end-to-end (Step 11 rollback flag drain)
- B9. Real `VaultUnlocker.unlock(passphrase:)` against `/api/vault/unlock/data` (DEBUG fixture loader was used as a stand-in for the host vault state)
- B10. `HostSyncService.runSync(...)` against real `/api/passwords` + `/api/teams/[teamId]/passwords`

### C. Side-channel and platform-specific behaviors

Status: Code paths exist; runtime verification depends on either OAuth flow (B) or AutoFill flow (A) reaching them.

Items NOT executed:
- C1. Screen-recording overlay (`UIScreen.capturedDidChangeNotification`) toggles "Recording — content hidden" view in vault list / detail. (Code present in `VaultListView` / `EntryDetailView` but a manual screen-recording trigger has not been exercised.)
- C2. App-Switcher snapshot blur (`scenePhase != .active` overlay) over vault content. (Code present in `PasswdSSOAppApp` but not visually validated against the App Switcher snapshot.)
- C3. `UIPasteboard` write with `localOnly: true` and `expirationDate: now+60s` — the call site exists in `EntryDetailView` and `TOTPCodeView` but actual 60s expiration + Universal Clipboard suppression has not been observed end-to-end.
- C4. Auto-lock timer fires at the configured `autoLockMinutes` boundary on a real wall-clock idle session. (Unit test uses `TestClock`; real wall-clock observation deferred.)
- C5. `BGTaskScheduler` background sync at the 15-minute interval (LLDB `_simulateLaunchForTaskWithIdentifier:` exercise documented in manual-test plan, not executed).

### D. Tier-2 adversarial scenarios from the manual test plan

`docs/archive/review/ios-autofill-mvp-manual-test.md` lists 15 adversarial scenarios. None have been executed yet — they all assume either OAuth-completed sign-in (B) or working AutoFill (A).

Items NOT executed:
- A1-A15 in the manual test plan (homograph host, malicious app overlap, screen-recording fill, MDM behavior, forensic acquisition, refresh-token theft simulation, host-app crash mid-write, bridge-key access-group rotation, server URL TOFU, server URL phishing, cache freshness window, BackgroundTask under Low Power Mode, end-to-end host-sync→extension-fill, server-takeover recovery, BGTaskScheduler exercise).

## What unblocks the deferred items

Apple Developer Program enrollment ($99 / year). With paid signing identity:

1. Set `DEVELOPMENT_TEAM` in `ios/project.yml` to the paid TeamID.
2. Re-add `com.apple.developer.associated-domains: applinks:www.jpng.jp` to `PasswdSSOApp/PasswdSSOApp.entitlements` (it is currently commented out — see commit `d5c8bb82`).
3. Build + sign — Xcode will auto-create App IDs for both `com.passwd-sso` and `com.passwd-sso.PasswdSSOAutofillExtension` with the AutoFill Credential Provider + Associated Domains capabilities.
4. Re-run sections A, B, C, D above on a real iPhone (or Simulator + paid-team signed build).

## Followup task to track

After the merge, file a "post-MVP verification" issue tracking sections A, B, C, D above. The issue should:

- Reference this document.
- Block the MVP "shipped" sign-off until A1–A6 + B1–B10 are observed working.
- Note that C1–C5 and D scenarios can land in subsequent verification cycles.

## References

- Plan: [ios-autofill-mvp-plan.md](./ios-autofill-mvp-plan.md)
- Coding Deviations: [ios-autofill-mvp-deviation.md](./ios-autofill-mvp-deviation.md)
- Manual Test Plan: [ios-autofill-mvp-manual-test.md](./ios-autofill-mvp-manual-test.md)
- Apple — Supported capabilities (iOS): https://developer.apple.com/help/account/reference/supported-capabilities-ios
- Apple — AutoFill Credential Provider Entitlement: https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.authentication-services.autofill-credential-provider
- Apple — Associated Domains Entitlement: https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.associated-domains
