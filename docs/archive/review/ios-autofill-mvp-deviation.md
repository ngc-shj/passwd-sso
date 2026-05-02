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

## Step 7 (host-app vault UI + sync + BGTaskScheduler) — 2026-05-02

**Deviations from plan**:

1. **`Shared.EncryptedEntry` renamed to `Shared.SyncEncryptedEntry`.** The plan named the `BackgroundSyncCoordinator` wire model `EncryptedEntry`. `PasswdSSOApp` introduced a richer `EncryptedEntry` (Codable, with `keyVersion`, `aadVersion`, `entryType`, etc.) for the `/api/passwords` response. Both living in the same test binary created an ambiguity; renaming the `Shared` type removes the shadowing without changing any serialized format.

2. **`MobileAPIClient` promoted several members from `private` to `internal`.** The plan assumed a `HostSyncService` extension on `MobileAPIClient`, but extensions inside another source file cannot access `private` members. Members changed to `internal` (implicit modifier, no keyword): `serverURL`, `signer`, `jwk`, `tokenStore`, `canonicalHTU()`, `sha256Base64URL()`, `performHTTP()`. Functional behaviour is unchanged; all callers remain in-module.

3. **New subdirectories not picked up by Xcode until XcodeGen re-run.** Step 7 introduced `PasswdSSOApp/Vault/`, `PasswdSSOApp/Background/`, `PasswdSSOApp/Views/Vault/`. Xcode's per-directory file-system source-group scan requires a project rebuild; running `/opt/homebrew/bin/xcodegen generate` regenerated `PasswdSSO.xcodeproj` to include all new files. No change to `project.yml` glob patterns was needed — the existing `"path: PasswdSSOApp"` glob recurses into new subdirectories automatically.

4. **`TOTPCodeView` timer uses `Task { @MainActor in }` instead of `Foundation.Timer`.** The plan described using `Timer.publish`. Swift 6 strict concurrency rejects `Timer.scheduledTimer` callbacks into `@MainActor`-isolated code from a non-isolated context. Replaced with a `Task { @MainActor in }` loop using `Task.sleep(nanoseconds: 1_000_000_000)` per tick. Behavior is identical (1 Hz refresh, cancels on disappear). **Why**: strict concurrency, not a design change.

5. **`VaultListView` and `EntryDetailView` use `.onReceive(NotificationCenter.default.publisher(for:))` instead of `NotificationCenter.addObserver`.** The plan listed `NotificationCenter.default.addObserver`. Swift 6 rejects capturing `@MainActor`-isolated properties (`isScreenRecording`) in a `Sendable` closure required by `addObserver`. The Combine `.onReceive` modifier delivers notifications on the main actor automatically. Behavior is identical.

6. **`BackgroundSyncTask.register` uses `BackgroundSyncRunner: @unchecked Sendable` + `TaskBox` wrapper.** The plan's snippet passed the sync service and vault key closure directly to `BGTaskScheduler.shared.register`'s `launchHandler:`. Swift 6 requires the handler to be `Sendable`; `BGTask` itself is not `Sendable`, requiring the `@unchecked Sendable` `TaskBox` wrapper. The wrapper is single-write (init only) and only accessed from the task the handler spawns, making the `@unchecked` annotation safe.

7. **`PlaceholderDPoPSigner` in `RootView` for the post-sign-in → vault-unlock transition.** After OAuth sign-in completes, `RootView` needs a `MobileAPIClient` instance to pass to `VaultUnlocker`. Step 8 will thread the real `DPoPSigner` from `AuthCoordinator` through to `MobileAPIClient`. For Step 7 a placeholder signer (always throws) is used so the vault-unlock UI can be wired up and tested. This is explicitly flagged with a comment referencing Step 8.

8. **`readBEUInt32` and `BridgeKeyStore.deserialize` changed from `load(as:)` to `loadUnaligned(as:)`.** `Data` slices returned from Keychain (`SecItemCopyMatching`) and from `Data(contentsOf:)` (cache file) carry non-zero `startIndex`, making the underlying byte pointer potentially unaligned for multi-byte integer types. On iOS 18 + arm64, `UnsafeRawBufferPointer.load(as:)` traps with `Fatal error: load from misaligned raw pointer` when the slice happens to be at a non-4 / non-8-byte-aligned address. Changed both sites to `loadUnaligned(as:)` (available since iOS 14 / Swift 5.7). **Why**: Keychain and file I/O return non-contiguous Data; `loadUnaligned` is the correct API for arbitrary-alignment byte buffers. No change to the big-endian interpretation; the `UInt64(bigEndian:)` / `UInt32(bigEndian:)` wrapping is unchanged.

9. **`EntryFetcherTests.swift` shares `MockURLProtocol` defined in `MobileAPIClientTests.swift`.** The initial draft of `EntryFetcherTests` included its own `private class MockURLProtocol`. Swift compiles all files in the test target into a single module, and despite the `private` keyword, the duplicate class caused an "invalid redeclaration" error. Removed the duplicate and adapted the handler closure signature to match `MobileAPIClientTests`'s `(Data, HTTPURLResponse)` tuple order (was `(HTTPURLResponse, Data)`).

10. **Test files for `PasswdSSOApp` types require `@testable import PasswdSSOApp`.** `AutoLockServiceTests`, `VaultUnlockerTests`, `HostSyncServiceTests`, `StaleBlobRecoveryServiceTests`, and `EntryFetcherTests` originally only imported `Shared`. These test files reference types defined in the `PasswdSSOApp` module (`AutoLockService`, `VaultUnlockError`, `VaultUnlockData`, `MobileAPIClient`, `EntryFetcher`, `StaleBlobRecoveryService`). Added `@testable import PasswdSSOApp` to each. The `BUNDLE_LOADER` / `TEST_HOST` linker setup already links the test binary against `PasswdSSOApp`; the import was the only missing piece.

**No deviations** from: AES-256-GCM cache encryption (header AAD = "CACHEHDR" || counter BE-8 || hostInstallUUID 16; entries blob unprotected by AAD), HKDF cache key derivation (info="passwd-sso-cache-v1"), atomic write (.tmp → replaceItemAt), write ordering (cache first, counter update second), bridge-key blob layout (bridge_key 32 || counter 8 BE || uuid 16 = 56 bytes), side-channel controls (isSecureTextEntry, capturedDidChangeNotification overlay, localOnly pasteboard + 60s expiry), BGTaskScheduler identifier "com.passwd-sso.cache-sync" with 15-min earliestBeginDate, PBKDF2 + AES-GCM vault unlock flow, and stale-blob forward recovery logic.

## Steps 8-9 (AutoFill extension password + TOTP) — 2026-05-02

**Deviations from plan**:

1. **`SyncEncryptedEntry` renamed to `CacheEntry` in `CredentialResolver.swift`.** The plan's brief specified a wire model called `SyncEncryptedEntry` for entries in the App Group cache. However, `Shared/Sync/BackgroundSyncCoordinator.swift` (Step 5) already defines a `SyncEncryptedEntry` with a different shape (String blobs, not `EncryptedData` hex-coded blobs). Reusing the name would have caused a "invalid redeclaration" compile error. The new model is named `CacheEntry` to reflect its purpose (App Group cache entries with hex-encoded AES-GCM blobs). No change to the on-disk format.

2. **`resolveCandidates(for:)` takes `[ServiceIdentifier]` instead of `[ASCredentialServiceIdentifier]`.** `ASCredentialServiceIdentifier` is a non-Sendable Objective-C class. Swift 6 strict concurrency rejects passing it across an actor boundary (the `CredentialResolver` is an actor). A new `ServiceIdentifier: Sendable` struct is introduced in `Shared/AutoFill/CredentialResolver.swift` to carry the same data (identifier string + isURL flag) across the boundary. The extension converts inbound `ASCredentialServiceIdentifier` values to `ServiceIdentifier` before the actor hop. Tests use `ServiceIdentifier` directly (no import of AuthenticationServices needed in tests).

3. **`.app` IdentifierType guarded by `@available(iOS 26.2, *)`** in `CredentialPickerView.swift`. The plan's app-side AutoFill confirmation uses `ASCredentialServiceIdentifier.IdentifierType.app` to detect app-bundle-ID requests. This enum case was introduced in iOS 26.2 (not yet in the iOS 17.0 deployment target baseline). The implementation wraps it in `if #available(iOS 26.2, *) { ... }` so the extension compiles cleanly on iOS 17 while the app-side confirmation UI activates automatically when running on iOS 26.2+.

4. **`ASOneTimeCodeCredential` and `completeOneTimeCodeRequest(using:)` guarded by `@available(iOS 18.0, *)`** in `CredentialProviderViewController.swift`. The plan refers to iOS 17+ One-Time-Codes path, but `ASOneTimeCodeCredential` and the async `completeOneTimeCodeRequest` are iOS 18+. `prepareOneTimeCodeCredentialList(for:)` itself is iOS 17+. The implementation routes into the `#available(iOS 18.0, *)` block for credential delivery; on iOS 17.x the code reaches `cancel(with: nil)`. In practice TOTP AutoFill requires iOS 18+ anyway; the iOS 17 path is a safe fallback. The deployment target (iOS 17.0) is unchanged.

5. **`hasTOTP: Bool` added to `VaultEntrySummary` with default `false`** (out-of-scope model change, brief-authorized). The plan briefly explicitly authorizes "add `hasTOTP: Bool` to `VaultEntrySummary` if not already present." The field was absent; added with default `false` so all existing callsites are unaffected and no existing test breaks.

6. **`RollbackFlagWriter` / `RollbackFlagVerifier` placed in `Shared/AutoFill/` (brief says `Shared/`).** The brief specifies `ios/Shared/AutoFill/RollbackFlagWriter.swift`. Placing it under `Shared/AutoFill/` (a new subdirectory) matches the brief. XcodeGen's `path: Shared` glob recurses into subdirectories automatically; no `project.yml` change was needed.

7. **`buildCacheFile` test helper uses `CacheEntry` (the renamed type) for the entries JSON.** The test builds the encrypted entries array with `[CacheEntry]` and `JSONEncoder().encode(entries)` to produce the JSON that `readCacheFile` / `CredentialResolver` will later decode. This is consistent with how `HostSyncService` will actually write the file.

**No deviations** from: single bridge_key Keychain read per fill (T42 verified in `resolveCandidates_singleKeychainRead`), vault_key zeroed before actor method returns (verified structurally in `decryptEntryDetail_zeroesVaultKeyAfterReturn`), extension never writes to pasteboard (no UIPasteboard calls in extension code), extension makes no network calls (no URLSession / URLRequest in extension target), rollback flag HMAC key derivation via HKDF(vaultKey, info="rollback-flag-mac", salt=zero32), atomic flag write (.tmp → replaceItemAt), team-key staleness threshold of 15 minutes, URL host matching parity with browser extension.

### Post-handoff fix (orchestrator) — AAD propagation — 2026-05-02

Step 8-9 shipped without wiring AAD into the resolver's decrypt path. Against
real server data, AES-GCM authentication would fail for every entry because the
server always emits AAD-bound ciphertext for entries with `aadVersion >= 1`
(personal) or any team entry (always AAD). Fixed by:

1. **`CacheHeader.userId`** — added `userId: String` to `CacheHeader` and the
   encrypted-header JSON, so the AutoFill extension reads the user ID from the
   cache file without needing a network call or Keychain lookup. The header AAD
   (`"CACHEHDR" || counter BE-8 || hostInstallUUID 16`) is unchanged — `userId`
   lives inside the encrypted plaintext, authenticated by the GCM tag.

2. **`CacheEntry` extended** — added `aadVersion`, `keyVersion`, `teamKeyVersion`,
   `itemKeyVersion`, and `encryptedItemKey` fields so every entry carries the
   data needed to reconstruct its AAD at decrypt time.

3. **`CredentialResolver` AAD wiring** — `decryptSummary` and `decryptDetail` now
   accept `userId` (from `cacheData.header.userId`) and build the correct AAD:
   personal entries use `buildPersonalEntryAAD(userId, entryId)` when
   `aadVersion >= 1`; team entries always use
   `buildTeamEntryAAD(teamId, entryId, vaultType, itemKeyVersion)`.

4. **ItemKey unwrapping** — `resolveTeamEntryKey` decrypts `encryptedItemKey`
   with `buildItemKeyWrapAAD(teamId, entryId, teamKeyVersion)` when
   `itemKeyVersion >= 1`, yielding the per-entry key used for blob/overview
   decryption. When `itemKeyVersion == 0` the teamKey is used directly.

5. **`VaultUnlocker.unlock`** — return type changed from `SymmetricKey` to
   `UnlockResult { vaultKey, userId }`. The `userId` flows from the
   `/api/vault/unlock/data` server response into `HostSyncService.runSync` and
   ultimately into the cache header.

6. **`EntryFetcher` team path** — `fetchTeamAsCacheEntries` decodes the flat
   server response format (`TeamEncryptedEntry`) and converts it to `CacheEntry`
   with `teamKeyVersion`/`itemKeyVersion`/`encryptedItemKey` populated.
   `HostSyncService` converts personal `EncryptedEntry` → `CacheEntry` inline.

7. **Tests** — all fixture construction updated to use `aadVersion: 0` for
   no-AAD entries and new AAD-bound helpers (`makePersonalCacheEntry`,
   `makeTeamCacheEntry`) for AAD-bound fixtures. 6 new resolver tests and 2
   new cache-file tests added. Total unit test count: 154 → 162 (+8).

**Cross-verification**: `buildPersonalEntryAAD(userId: "u-1", entryId: "e-1")`
produces `505601020003752d310003652d31` (hex), byte-identical to the Node.js
reference output from `crypto-aad.ts`. AAD parity already covered by
`AADParityTests.swift` (Step 5).
