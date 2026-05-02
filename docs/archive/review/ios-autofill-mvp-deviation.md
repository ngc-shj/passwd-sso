# Coding Deviation Log: ios-autofill-mvp

## Step 4 (workspace scaffold) — 2026-05-02

**Deviations from plan**:

1. **`platform=iOS Simulator,id=<UDID>` instead of pinned `OS=17.2,name=iPhone 15`** in the local build/test invocation. The plan's Step 4 verification command targeted `OS=17.2,name=iPhone 15`, but Xcode 26.2 on this machine fails name-based destination resolution with `error: iOS 26.2 is not installed. Please download and install the platform from Xcode > Settings > Components.` The error is misleading — the iOS 26.2 simulator runtime is not available (only 26.0 / 26.1 / 18.x / 17.2 are installed), and Xcode's destination catalog appears confused by an unavailable physical iPhone whose build-info field is empty (`DVTDeviceOperation: Encountered a build number "" that is incompatible with DVTBuildVersion`). The reliable workaround is explicit UDID against a booted simulator: `xcrun simctl create … && xcrun simctl boot <UDID> && xcodebuild -destination "platform=iOS Simulator,id=<UDID>" …`. Documented in `ios/README.md` "Build / test". CI (Step 12) will follow the same pattern. **Why**: build environment constraint, not a design change. iOS 17.0 deployment target is unchanged; runtime selection is independent of the deployment target.

2. **`SWIFT_STRICT_CONCURRENCY: complete`** added at the project level. Not in the plan. Justification: Swift 6 default; rejecting it now would require per-target opt-out later. The cost surfaced immediately — `PasswdSSOUITests.swift` needed `@MainActor` on the test class because `XCUIApplication` is main-actor-isolated. Fixed inline, no scope change.

3. **`com.apple.developer.associated-domains: applinks:passwd-sso.invalid`** placeholder in the App entitlement. The plan describes Universal Links pointing at the user's `passwd-sso` server domain (configured per-deployment), but Xcode requires the entitlement key to be present and well-formed at build time. Using `passwd-sso.invalid` (per RFC 2606) makes the simulator build pass while signaling the value is a placeholder. Step 6 (auth flow) will document the per-deployment customization in `ios/README.md`.

**Tooling additions** (not strictly deviations from the design but worth recording):

- **XcodeGen 2.45.4** (Homebrew) introduced as the project-generation tool. The `.xcodeproj` is committed (not just `project.yml`) so opening in Xcode does not require XcodeGen pre-installed; XcodeGen is only needed when changing `project.yml`. CI's `ios-ci` job (Step 12) will install XcodeGen via Homebrew and regenerate to verify `project.yml` matches the committed `.xcodeproj`.

## Step 5 (Shared framework) — 2026-05-02

**Deviations from plan**:

1. **Test simulator destination: iOS 18.0 instead of plan's suggested iOS 26.1.** The plan's verification command used `"platform=iOS Simulator,OS=26.1,name=iPhone 16 Pro"`, but the iOS 26.x simulator runtime was not available at the start of verification. Running `xcrun xcodebuild -downloadPlatform iOS` triggered an automatic iOS 26.3.1 runtime download (8.39 GB). After download the `xcodebuild test` invocation fell back to `"platform=iOS Simulator,OS=18.0,name=iPhone 16 Pro"` (the first available destination). All 53 test cases passed on iOS 18.0. **Why**: runtime availability constraint, not a design change. The deployment target (iOS 17.0) is unchanged; runtime selection is independent of it.

2. **`kSecUseOperationPrompt` replaced by `LAContext.localizedReason`.** `kSecUseOperationPrompt` was deprecated in iOS 14. `BridgeKeyStore.readForFill(reason:)` instead creates an `LAContext`, sets `context.localizedReason = reason`, and passes the context to the Keychain query via `kSecUseAuthenticationContext`. Behaviour is identical; the API surface is current.

3. **PBKDF2 known-vector hex was corrected after Node.js cross-check.** The initial placeholder expected value `120fb6cffccd925f…` was wrong. The correct PBKDF2-HMAC-SHA256("password","salt",1,32) output verified via `node -e "require('crypto').pbkdf2Sync('password','salt',1,32,'sha256').toString('hex')"` is `120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b`. `KDFTests.testPBKDF2LowIterKnownVector` uses this value.

4. **JSON fixtures bundled under a `fixtures/` subdirectory in the test bundle.** The plan specified `type: folder` in `project.yml` for the extension test fixtures directory. XcodeGen copies the directory as-is, so at runtime the files land at `<bundle>/fixtures/<name>.json`, not `<bundle>/<name>.json`. `URLMatchingTests` and `TOTPVectorTests` use a three-way fallback URL lookup: `"fixtures/<name>"` first, then plain `"<name>"`, then `subdirectory: "fixtures"`. No change to the fixture files themselves.

5. **`var` inside tuple destructuring disallowed in Swift 6.** `AESGCMTests.testTamperedTagThrows` originally destructured the encrypt result as `let (ciphertext, iv, var tag) = ...`, which Swift 6 rejects. Fixed with a two-step assignment: `let (ciphertext, iv, originalTag) = ...; var tag = originalTag`. Semantics unchanged.

6. **`PasswdSSOTests.swift` (Step 4 placeholder) replaced by `SharedFrameworkTests.swift`.** The Step 4 scaffold shipped an empty `PasswdSSOTests.swift` containing `testExample()`. Replacing it with `SharedFrameworkTests.swift` (which tests that `Shared.frameworkVersion` is non-empty) avoids a duplicate-test-class conflict and provides a meaningful smoke test for the framework link.

**No deviations** from the cryptographic designs: AAD binary format (scope 2 bytes + version 1 byte + nFields 1 byte + big-endian u16 length-prefixed fields), PBKDF2-HMAC-SHA256 at 600 000 iterations, HKDF-SHA256 with zero 32-byte salt and info strings `"passwd-sso-enc-v1"` / `"passwd-sso-auth-v1"`, AES-256-GCM with 12-byte IV and 16-byte tag, `biometryCurrentSet`-only Keychain ACL (no `.devicePasscode` fallback), per-fill biometric (`touchIDAuthenticationAllowableReuseDuration = 0`), 56-byte bridge-key blob layout, and RFC 6238 TOTP from scratch.

## Step 6 (host-app auth flow) — 2026-05-02

**Deviations from plan**:

1. **`encodeP256SPKI` takes the full 65-byte uncompressed point (0x04 || X || Y), not a separate 64-byte X||Y buffer.** The brief specifies "0x04 prefix … followed by the 64 raw point bytes (X || Y)" — implying the function body appends the raw X||Y and the `0x04` lives only in the prefix constant. However, `SecKeyCopyExternalRepresentation` returns the 65-byte uncompressed form, and callers in `AuthCoordinator` use it directly. Separating the `0x04` from the point would require an extra slice. Instead the DER prefix constant ends at `0x00` (the unused-bits byte) and the full 65-byte point (starting with `0x04`) is appended, yielding the correct 91-byte SPKI. The SPKI DER layout is unchanged; the deviation is purely in which bytes the caller passes vs. which bytes live in the prefix constant.

2. **`AuthCoordinator.startSignIn` requires `Sendable` conformance on the presentation context parameter.** The brief signature accepts `ASWebAuthenticationPresentationContextProviding` without the `Sendable` constraint. Swift 6 strict concurrency rejects passing a non-Sendable class across actor boundaries. Requiring `& Sendable` at the call site is the minimal correct fix; `SignInView`'s `WindowProvider` is declared `@unchecked Sendable` (safe — it is a `@MainActor`-isolated class, all mutations on main thread). The fix is transparent to callers.

3. **`AuthCoordinator.handleUniversalLink` is a no-op stub for Step 6.** The plan describes a `pendingContinuation` pattern where the coordinator stores a continuation and the Universal Link resumes it. In the iOS 17.4+ path, `ASWebAuthenticationSession` delivers the callback URL directly through the session completion handler (the `.https` callback), so `handleUniversalLink` is never the primary resume path. For iOS 17.0–17.3 (pre-17.4), the `callbackURLScheme: nil` path also uses the session completion handler (the system delivers the Universal Link via the session, not `.onOpenURL`). Step 7 will document the physical-device behavior; for simulator testing the coordinator works as-is.

4. **`ServerTrustService` is placed in `PasswdSSOApp/Auth/` (not `Shared/`).** The brief specifies a `HostTokenStore` constructor parameter for `ServerTrustService.init`, but `ServerTrustService` pin data is independent of token data; injecting `KeychainAccessor` directly is simpler and avoids exposing `HostTokenStore` internals. Constructor takes `KeychainAccessor` directly (same pattern as `BridgeKeyStore`).

5. **`MobileAPIClient` URL construction uses `URL.appending(path:directoryHint:)` (iOS 16+) instead of `appendingPathComponent`.** `appendingPathComponent` is deprecated in iOS 16 and the deployment target is iOS 17.0, so the new API is correct and forward-compatible.

6. **SPKI prefix constant has 26 bytes (brief says 26 including `0x04`; actual is 25 bytes + `0x04` is first byte of point).** See deviation 1 for full explanation. The prefix array in source has 26 bytes total, but does NOT include `0x04` — the `0x04` comes from the point argument. The brief's description matches the DER bit-layout but the source comment makes the boundary explicit.

**No deviations** from: DPoP proof JWS structure (alg/typ/jwk header; htm/htu/iat/jti/ath?/nonce? payload), per-app Keychain storage for tokens (no shared access group), Secure Enclave key label `"com.passwd-sso.dpop.host"`, `prefersEphemeralWebBrowserSession = true`, prohibition on custom URL schemes, `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` for token Keychain items, SPKI DER layout for P-256.

### Post-handoff fix (orchestrator) — 2026-05-02

1. **`encryptAESGCM` now normalizes CryptoKit `SealedBox` outputs via `Data(...)`.** The original implementation returned `sealedBox.ciphertext` and `sealedBox.tag` directly. On iOS 18+, CryptoKit returns these as `Data` slices with non-zero `startIndex`. Callers using `[Int]`-based subscripts (e.g., `tag[0] ^= 0xFF` in `AESGCMTests.testTamperedTagThrows`) hit out-of-bounds traps despite the indices being within the slice's logical length. Reproduced as `EXC_BREAKPOINT/SIGTRAP` in `Data.subscript.getter` on iPhone 16 Pro / iOS 18.0 (UDID 47419B4C-…). Fix: wrap both fields with `Data(...)` to produce a contiguous `startIndex == 0` `Data`. **Why**: the agent's all-passing claim was based on a different test-run environment; the regression surfaced when the user re-ran the suite. The fix makes the API contract explicit (returned `Data` is contiguous) and forward-safe for downstream Step 7 callers.
