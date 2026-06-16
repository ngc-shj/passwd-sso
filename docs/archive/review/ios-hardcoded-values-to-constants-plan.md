# Plan: ios-hardcoded-values-to-constants

Branch: `refactor/ios-hardcoded-values-to-constants`
Type: refactor (behavior-preserving)

Reference: web/extension/cli sweep `refactor: replace hardcoded values with shared constants (#561)`
(`docs/archive/review/hardcoded-values-to-constants-plan.md`), which explicitly deferred
the iOS app under SC1 (`TODO(hardcoded-values-to-constants): iOS constant sweep not planned`).
This plan executes that deferred iOS-side sweep, following the same conventions:
value-identity (zero runtime behavior change), semantic separation (never fold
semantically-distinct values that happen to share a number), and forbidden-pattern greps
as the mechanical completeness gate.

## Project context

- Type: native iOS app (Swift / SwiftUI) — 3 product targets sharing one framework:
  - `Shared` (framework, `APPLICATION_EXTENSION_API_ONLY: YES`) — compiled into BOTH the app and the AutoFill extension.
  - `PasswdSSOApp` (application) — embeds `Shared`, embeds the extension.
  - `PasswdSSOAutofillExtension` (credential-provider app extension) — links `Shared` only.
  - Test targets: `PasswdSSOTests` (unit), `PasswdSSOUITests`.
- Import boundaries (hard constraints):
  - Constants used by code in BOTH the app and the extension (or by `Shared/` code) MUST live in `Shared/`.
  - The extension CANNOT import `PasswdSSOApp/`; the app CANNOT import the extension.
  - `Shared/` builds with extension-only API (`APPLICATION_EXTENSION_API_ONLY`) — new constant files must not pull in app-only APIs.
- Test infrastructure: unit tests only (XCTest), no CI-runnable macOS in this environment (see VE1). Crypto behavior is guarded by parity/vector tests: `KDFTests`, `TeamKeyCryptoTests`, `AADParityTests`, `PasskeyRegistrationTests`, `TOTPVectorTests`, `CredentialResolverTests`, `EntryCacheFileTests`.
- Verification environment constraints:
  - VE1: building/testing requires Xcode/macOS; the orchestrator's shell cannot run `xcodebuild`/`swift test`. All contracts are pure refactors verifiable by **value-identity reasoning + forbidden-pattern greps**; the user (or CI) runs `xcodebuild test` to confirm. Every contract's acceptance therefore lists both the grep gate (runnable here) and the test gate (`blocked-deferred` to the user/CI — Anti-Deferral cost-justification: cost-to-fix is "user runs one xcodebuild command"; worst case a missed adoption causes a compile error caught immediately by that build; likelihood low because edits are mechanical literal→constant swaps with grep verification).
  - VE2: `xcodegen` regenerates `PasswdSSO.xcodeproj` from `ios/project.yml`. New `.swift` files under already-globbed source folders (`Shared/Crypto`, `Shared/Network`) are auto-discovered by the folder globs — no `project.yml` edit needed (confirm the target `sources:` use folder globs, not explicit file lists).

## Objective

Eliminate magic numbers and repeated hardcoded string literals in the iOS Swift code that
bypass (or should become) shared constants, with **zero runtime behavior change**. Every
replaced literal keeps its exact current value/bytes. Scope is the genuine duplication that
creates drift risk; idiomatic single-use values (SwiftUI layout numbers, RFC-default TOTP
params, per-store keychain identifiers) stay inline.

## Requirements

- Functional: no observable behavior change. All constant values byte/numerically identical pre/post. Crypto wire formats unchanged (golden/parity tests prove it).
- Non-functional: single definition per shared value within the iOS build boundary. Constants live in `Shared/` so app + extension share one definition.
- Convention (match the codebase's existing patterns): namespace via caseless `enum` with `static let` members (precedent: `AutoLockLimits` in `Shared/Models/LockState.swift`, `VaultType` in `Shared/Crypto/AAD.swift`). Do NOT introduce free global `let`s for new groups (the existing `pbkdf2Iterations` global stays as-is — already centralized, not in scope to move).
- Semantic separation: the literal `32` appears with ≥6 distinct meanings (256-bit symmetric key length, HKDF/PBKDF2 output length, P-256 coordinate length, HKDF zero-salt length, PKCE/credential-ID random length, ECDSA component length). Each meaning gets its own named constant even when the number coincides — mirroring the reference PR's `VERIFIER_BITS` vs `AES_KEY_LENGTH` separation. Folding all `32`s into one constant is a forbidden anti-pattern.

## Technical approach

Investigation (3 parallel codebase sweeps, 2026-06-16) produced a verified inventory.
Fix clusters become contracts C1–C4. Each new constant file is a caseless-enum namespace
under `Shared/` so both product targets resolve one definition.

## Contracts

> No contract changes any wire format, persisted-state shape, network payload, or on-disk
> cache format — all VALUES (bytes, strings, numbers) are identical pre/post; only the
> source spelling moves from literal to constant. Consumer-flow walkthroughs are N/A for
> every contract (no shape is created or modified).

### C1 — Crypto params namespace + adoption (Shared/Crypto)

New file `ios/Shared/Crypto/CryptoParams.swift`, a caseless-enum namespace (no imports beyond `Foundation`), with **semantically-named** members. Numbers that coincide stay separate constants:

```swift
public enum CryptoParams {
  // AES-256-GCM wire parameters (match crypto-client.ts / AESGCM.swift wire format)
  public static let aesGCMNonceByteCount = 12   // IV length
  public static let aesGCMTagByteCount = 16     // auth tag length
  // 256-bit symmetric key material expressed in bytes (AES-256 key, HKDF/PBKDF2 output)
  public static let symmetricKeyByteCount = 32
}

public enum P256Params {
  public static let coordinateByteCount = 32                 // JWK x / y length, scalar length
  public static let keySizeBits = 256                        // SecKey kSecAttrKeySizeInBits
  // uncompressed EC point: 0x04 ‖ x(32) ‖ y(32)
  public static let uncompressedPointPrefix: UInt8 = 0x04
  public static let uncompressedPointByteCount = 1 + coordinateByteCount + coordinateByteCount  // 65
}
```

Adoption (verified sites from investigation; exact line numbers re-confirmed at edit time):
- `Shared/Crypto/AESGCM.swift:26,54` (`== 12`) → `CryptoParams.aesGCMNonceByteCount`; `:55` (`== 16`) → `CryptoParams.aesGCMTagByteCount`.
- `Shared/Crypto/KDF.swift`: `hkdfZeroSalt = Data(repeating: 0, count: 32)` (:10), `derivedKey = Data(repeating: 0, count: 32)` (:28), `derivedKeyPtr ... 32` (:38), `outputByteCount: 32` (:59,73,87) → `CryptoParams.symmetricKeyByteCount`. (The zero-salt length and key length both equal 32; both are "256-bit material in bytes" here, so one constant is correct — but keep the explanatory comments on each site.)
- `Shared/Crypto/TeamKeyCrypto.swift`: zero-salt `count: 32` (:12) and HKDF `outputByteCount: 32` (:30,96,118,131) → `symmetricKeyByteCount`; JWK x/y validation `count == 32` (:65-66) → `P256Params.coordinateByteCount`; `:68` `Data([0x04])` x963 uncompressed-point marker → `Data([P256Params.uncompressedPointPrefix])` (same value/meaning as the SecureEnclaveKey prefix; **F5** — fold it, do not leave raw).
- `Shared/Crypto/PasskeyAssertion.swift:73` (P-256 scalar `32`) → `P256Params.coordinateByteCount`.
- `Shared/Crypto/PasskeyRegistration.swift:54-55,125-126` (x/y `prefix(32)`/`suffix(32)` and JWK encode) → `P256Params.coordinateByteCount`; `:159` random credential-ID `32` → **file-local** `private let credentialIdByteCount = 32` (semantically a random-ID length, NOT a coordinate; named locally with a comment that it coincides with the coordinate size).
- `Shared/Crypto/SecureEnclaveKey.swift:32` (`kSecAttrKeySizeInBits: 256`) → `P256Params.keySizeBits`; `:106` uncompressed-point `65` and `0x04` prefix → `P256Params.uncompressedPointByteCount` / `.uncompressedPointPrefix`; `:109-110` x slice `1..<33` and y slice `33..<65` → expressed from `P256Params.coordinateByteCount` (`1 ..< (1 + coordinateByteCount)`, `(1 + coordinateByteCount) ..< uncompressedPointByteCount`); `:170-173` ECDSA component padding `32` → **file-local** `private let ecdsaComponentByteCount = 32` (ASN.1/raw signature component length — semantically distinct from key/coordinate; named locally).
  - **NOTE (T1)**: `:32` `keySizeBits` lives in `generateDPoPKey`, a Secure-Enclave path NOT runnable in the simulator and NOT exercised by any unit test. Its correctness rests on compile-check + value-identity + the C1 value-pin test (see Testing strategy), NOT on the crypto vector suites. Do not count it under the test-guarded invariant.
- `Shared/Crypto/SPKIEncoder.swift:31-32` (**F1** — `guard uncompressedPoint.count == 65, uncompressedPoint[startIdx] == 0x04`) → `P256Params.uncompressedPointByteCount` / `.uncompressedPointPrefix`. This file was missed by the initial inventory; it is the same uncompressed-point validation as `SecureEnclaveKey.swift:106` and MUST be migrated or the duplication survives the refactor.
- `Shared/Storage/BridgeKeyStore.swift` (**F2**): the bridge-key length `32` appears THREE ways in this file — the existing `internal let bridgeKeyV2Size = 32` (:22, the value `readBlob` validates against at :237), the allocation `count: 32` (:129), and the random-fill `32` (:134). Reconcile to ONE: adopt the **existing** `bridgeKeyV2Size` at both :129 and :134 (it is the file's canonical storage-layout size and the read path already uses it). Do NOT introduce `CryptoParams.symmetricKeyByteCount` here — `bridgeKeyV2Size`/`bridgeMetaV2Size`/`legacyBridgeKeyBlobSize` are storage-layout sizes kept file-local by design (add to the file-local exclusion note below).
- `Shared/AutoFill/RollbackFlagWriter.swift:37` (zero-salt `32`), `:42` (HKDF `outputByteCount: 32`) → `CryptoParams.symmetricKeyByteCount`.
- `PasswdSSOApp/Auth/AuthCoordinator.swift:224-225` (PKCE verifier + state random `32`) → **file-local** `private let pkceRandomByteCount = 32` (random entropy length, distinct meaning).
- **Deliberately NOT folded** (semantic-separation / SC-iOS list): the various `32`s named as file-local constants above (`credentialIdByteCount`, `ecdsaComponentByteCount`, `pkceRandomByteCount`); `BridgeKeyStore.swift` storage-layout sizes (`bridgeKeyV2Size`, `bridgeMetaV2Size`, `legacyBridgeKeyBlobSize` — kept file-local; the bridge-key length is unified on the existing `bridgeKeyV2Size`, see F2 above); `Shared/Crypto/SecureEnclaveKey.swift` DER tag bytes (`0x30`,`0x02`,`0x10` etc.) and other ASN.1/encoding bytes; AAD field-length caps (`0xFFFF`); `EntryCacheFile.swift` header byte offsets (file-format layout, single-file, already named `fileHeaderSize`); `Debug/DebugVaultLoader.swift:93` `.bits256` (CryptoKit idiom, not a bare literal); `pbkdf2Iterations` (already a centralized public constant — leave in `KDF.swift`).
- Invariants:
  - (test-guarded, app-enforced) `KDFTests`, `TeamKeyCryptoTests`, `AADParityTests`, `PasskeyRegistrationTests`, `EntryCacheFileTests`, `CredentialResolverTests` pass unchanged — proves byte-identical crypto. This is the strongest available guard (no schema-enforced equivalent for in-code constants).
  - `CryptoParams.swift` imports only `Foundation` → safe in the `APPLICATION_EXTENSION_API_ONLY` framework and both targets.
- Forbidden patterns (acceptance greps, run from `ios/`):
  - pattern: `count == 12` / `count == 16` in `Shared/Crypto/AESGCM.swift` — reason: bare AES-GCM nonce/tag length. After edit, grep returns 0 in that file.
  - pattern: `outputByteCount: 32` in `Shared/Crypto/` — reason: bare HKDF output length. Returns 0 after edit.
  - pattern: bare `count == 32` in `Shared/Crypto/TeamKeyCrypto.swift` for JWK x/y — replaced by `P256Params.coordinateByteCount`.
  - pattern (F1, broadened): bare `65` and `0x04` in **`Shared/Crypto/`** (NOT just `SecureEnclaveKey.swift`) at uncompressed-point parse/build sites — replaced. Covers `SecureEnclaveKey.swift:106`, `SPKIEncoder.swift:31-32`, `TeamKeyCrypto.swift:68`. After edit, grep `grep -rn '== 65\|\[0x04\]\|== 0x04' Shared/Crypto` returns only sites that reference `P256Params`.
  - NOTE: a blanket `grep '\b32\b'` will still match the deliberately-retained file-local `32` named-constant declarations (`= 32`) — those are the named exclusions above and are NOT failures; the greps target the literal-at-use-site forms only.
- Acceptance: forbidden greps above return 0 at the named use sites; the file-local named constants exist (grep `credentialIdByteCount`, `ecdsaComponentByteCount`, `pkceRandomByteCount` each return ≥1); `xcodebuild test` (incl. all crypto/parity suites) passes (VE1 → user/CI).

### C2 — API path constants (Shared/Network)

New file `ios/Shared/Network/APIPath.swift` (caseless-enum namespace, `Foundation` only). Centralize every `/api/...` path literal used by network code; the API surface belongs in one place even for currently-single-use endpoints (an API client's endpoint list is a legitimate cohesive surface, not premature DRY).

```swift
public enum APIPath {
  public static let mobileToken = "/api/mobile/token"
  public static let mobileTokenRefresh = "/api/mobile/token/refresh"
  public static let mobileAutofillToken = "/api/mobile/autofill-token"
  public static let mobileAuthorize = "/api/mobile/authorize"
  public static let mobileCacheRollbackReport = "/api/mobile/cache-rollback-report"
  public static let vaultUnlockData = "/api/vault/unlock/data"
  public static let passwords = "/api/passwords"
  public static let healthLive = "/api/health/live"
  public static let teams = "/api/teams"
  // Interpolated paths keep a builder so the {id}/{teamId} interpolation stays at the call site:
  public static func password(id: String) -> String { "\(passwords)/\(id)" }
  public static func teamPasswords(teamId: String) -> String { "\(teams)/\(teamId)/passwords" }
  public static func teamMemberKey(teamId: String) -> String { "\(teams)/\(teamId)/member-key" }
}
```

Adoption: replace literals at the verified sites (`MobileAPIClient.swift` ~200,254,304,312,323,349,398,448,497; `Shared/Network/EntryUploader.swift`; `PasswdSSOApp/Auth/AuthCoordinator.swift:243`; `PasswdSSOApp/Views/ServerURLSetupView.swift:80`; `PasswdSSOApp/Vault/HostSyncService.swift:240`; `PasswdSSOApp/Vault/EntryFetcher.swift:157`). Interpolated team/password paths use the builder funcs. The `include=blob` query param stays inline (single-use query string, not a path).
- **F4 — fused path+query literal**: `EntryFetcher.swift:157` passes `"/api/passwords?include=blob"` as one string (not a `.appending(path:)` site). Adopt as `"\(APIPath.passwords)?include=blob"` so the `/api/` part comes from the constant and only the query stays inline.
- Invariant (app-enforced): concatenated request URLs are byte-identical to today — the builder funcs reproduce the exact `"\(base)/\(id)"` interpolation currently inline. Verify each builder against its current call-site interpolation before adopting.
- Forbidden pattern: `"/api/` outside `Shared/Network/APIPath.swift` — reason: bypasses APIPath.
- Acceptance: `grep -rn '"/api/' Shared PasswdSSOApp PasswdSSOAutofillExtension --include='*.swift'` returns only `APIPath.swift` (T6: the test target lives under `PasswdSSOTests/`, outside the three grepped dirs, so its legitimate `/api/` fixture literals do not appear — and intentionally stay, per SC-iOS-6); URLs unchanged (spot-check each builder, incl. the F4 fused literal); `xcodebuild test` passes (VE1).

### C3 — HTTP header / method / content-type / scheme constants (Shared/Network)

New file `ios/Shared/Network/HTTPConstants.swift`:

```swift
public enum HTTPHeader {
  public static let contentType = "Content-Type"
  public static let authorization = "Authorization"
  public static let dpop = "DPoP"
  public static let dpopNonce = "DPoP-Nonce"
}
public enum HTTPMethod {
  public static let get = "GET"
  public static let post = "POST"
  public static let put = "PUT"
}
public enum HTTPContentType {
  public static let json = "application/json"
}
public enum HTTPAuthScheme {
  public static let bearerPrefix = "Bearer "
  public static let dpopPrefix = "DPoP "
}
```

Adoption: `MobileAPIClient.swift` (header set/get sites ~224-226,277-281,369-372,418-421,468-471,517-520,626,632,676-687,746-797) and `Shared/Network/EntryUploader.swift`. `"Bearer "` / `"DPoP "` prefixes adopted at the `Authorization` value-construction sites.
- **F3 — `htm:` DPoP-proof method argument**: every request passes the SAME method string twice — `request.httpMethod = "POST"` AND `htm: "POST"` to `buildDPoPProof` (MobileAPIClient.swift `htm:` sites ~209,231,265,286,359,377,408,426,458,476,507,525,621; EntryUploader.swift:114). These MUST stay equal (the DPoP proof's `htm` claim is validated server-side against the actual method). Adopt `HTTPMethod.*` at BOTH the `httpMethod =` assignment AND the paired `htm:` argument so the invariant `htm == httpMethod` is structurally guaranteed.
- Invariant (app-enforced): header names/values byte-identical — wire requests unchanged. Note: `"DPoP"` (header name) and `"DPoP "` (auth-scheme prefix, trailing space) are DISTINCT constants — do not conflate. `htm:` value == `httpMethod` value at every call site.
- Forbidden patterns:
  - pattern: `"Authorization"` / `"Content-Type"` / `"DPoP-Nonce"` outside `HTTPConstants.swift` — reason: bypasses HTTPHeader.
  - pattern: `httpMethod = "POST"|"GET"|"PUT"` — reason: bypasses HTTPMethod.
  - pattern (F3): `htm: "(POST|GET|PUT)"` — reason: bypasses HTTPMethod at the DPoP-proof site (the literal-method form the `httpMethod =` grep cannot see).
  - pattern: `"Bearer "` outside `HTTPConstants.swift` — reason: bypasses HTTPAuthScheme.
- Acceptance: greps return 0 in production code (excluding `HTTPConstants.swift` and tests); `xcodebuild test` passes (VE1).

### C4 — Logger subsystem constant (Shared)

`"jp.jpng.passwd-sso"` is passed as `subsystem:` to `Logger`/`os.Logger` in 6 files across all three targets. Add a single shared constant and adopt it.
- Home: extend `Shared/Storage/AppGroupContainer.swift` (already the canonical home for the related App Group identifier `"group.jp.jpng.passwd-sso.shared"`) with `public static let loggerSubsystem = "jp.jpng.passwd-sso"`, OR a new tiny `Shared/AppIdentifiers.swift` namespace if AppGroupContainer is not a fitting home (decide at edit time; prefer co-locating with the App Group id for cohesion).
- Adoption: `Shared/AutoFill/CredentialIdentityRegistrar.swift`, `Shared/AutoFill/CredentialResolver.swift`, `Shared/Storage/BridgeKeyStore.swift`, `PasswdSSOApp/Auth/AutofillTokenRefresher.swift`, `PasswdSSOApp/Views/RootView.swift`, `PasswdSSOAutofillExtension/CredentialProviderViewController.swift`.
- Invariant (app-enforced): subsystem string unchanged → Console/log filtering by subsystem unaffected.
- Forbidden pattern: `subsystem: "jp.jpng.passwd-sso"` (literal) outside the constant's home — reason: bypasses the shared constant.
- Acceptance: grep returns only the definition site; `xcodebuild test` passes (VE1).

## Go/No-Go Gate

| ID | Subject                                              | Status |
|----|------------------------------------------------------|--------|
| C1 | Crypto params namespace + adoption (Shared/Crypto)   | locked |
| C2 | API path constants (Shared/Network)                  | locked |
| C3 | HTTP header/method/content-type/scheme constants     | locked |
| C4 | Logger subsystem constant (Shared)                   | locked |

(Locked after plan review closed: 2 functionality rounds + 1 security + 1 testing; all findings resolved.)

## Testing strategy

- `xcodebuild test -scheme PasswdSSO ...` (or `swift test` where applicable) — full XCTest suite. Crypto parity/vector suites (`KDFTests`, `TeamKeyCryptoTests`, `AADParityTests`, `PasskeyRegistrationTests`, `TOTPVectorTests`, `EntryCacheFileTests`, `CredentialResolverTests`) are the primary behavior guard for C1. Run by the user/CI (VE1).
- Forbidden-pattern greps (runnable in this environment) are the migration-completeness gate per contract.
- Value-pin tests (T5 — **required for the vector-uncovered constants, optional for the rest**): add a small `PasswdSSOTests/CryptoParamsTests.swift`. The AES-GCM / symmetric-key constants are already transitively pinned by the known-vector suites (a wrong `aesGCMTagByteCount` makes `decryptAESGCM` throw → `AADParityTests`/`TeamKeyCryptoTests` fail end-to-end), so pinning them is decorative/optional. The constants **NO existing vector pins** — `P256Params.keySizeBits == 256` (the SE-only `:32` site from T1), `P256Params.uncompressedPointByteCount == 65`, `P256Params.uncompressedPointPrefix == 0x04` — MUST be pinned here; this is the only test-time guard for the Secure-Enclave path that the simulator cannot run. (These pins are non-tautological per RT7: they compare the symbol against an independent literal.)
- No new behavior to test (pure refactor); existing suites + value-identity reasoning cover correctness.

## Considerations & constraints

- **Crypto is the highest-risk surface.** Mitigation: value-identity (no value changes), semantic separation (file-local constants for distinct-meaning `32`s), parity/vector tests, no HKDF/AAD info strings touched (those are versioned protocol strings and stay where they are).
- **Import boundary**: all new constant files live in `Shared/` and import only `Foundation` → safe under `APPLICATION_EXTENSION_API_ONLY` and resolvable from both product targets.
- **xcodegen**: confirm `Shared/Crypto` and `Shared/Network` are folder-globbed in `project.yml` so new files are picked up without a manifest edit (VE2).

### Scope contract

- **SC-iOS-1 — Time/duration normalization**: out of scope. Unlike the web PR's `MS_PER_*` work, Swift time literals are mostly single-use or already centralized (`AutoLockLimits`, `TeamEntryDecryptor.teamKeyMaxAge`, `SecureClipboard.min/maxClearSeconds`, `MobileAPIClient.refreshSkewSeconds`). `15 * 60` for seconds is idiomatic and readable. Introducing `SEC_PER_*` base constants is churn without dedup benefit. `TODO(ios-hardcoded-values-to-constants): time-base constants not planned — values are single-use or already named`.
- **SC-iOS-2 — Keychain/service identifiers** (`"com.passwd-sso.host-tokens"`, `.bridge-key`, `.dpop.host`, `.deviceId`, `.cache-sync`, …): out of scope. Each is a DISTINCT identifier already assigned to a single named constant in its store; they share only the `"com.passwd-sso."` reverse-DNS vendor prefix. Splitting the prefix reduces readability without removing duplication (mirrors reference PR SC4 "per-route key prefixes"). Not duplication → not in scope.
- **SC-iOS-3 — Enumerated domain strings** (entry types, cache-rejection reasons, TOTP algorithms, AAD scopes, vault-timeout actions, team roles): out of scope — already centralized as Swift enums (`EntryTypeCategory`, `CacheRejectionKind`, `TOTPHashAlgorithm`, `AADScope`, `VaultTimeoutAction`, `TeamRole`). The "not done" gap this plan addresses does not include these.
- **SC-iOS-4 — UI layout magic numbers** (SwiftUI spacing/padding/frame sizes): out of scope — single-use, idiomatic; investigation found no value repeated ≥3× across files.
- **SC-iOS-5 — RFC-default protocol numbers** (TOTP digits=6, period=30 per RFC 6238; DER/ASN.1 tag bytes; AAD field-length caps): out of scope — spec-mandated idiom, not arbitrary magic.
- **SC-iOS-6 — Test-fixture literals** (`expiresIn: 3600/86400`, `600000` in `MobileAPIClientTests`): leave ALL of them as inline fixture data. Testing review (T3) confirmed per-site that the iOS suite has **zero** tests asserting a production-owned numeric constant: `expiresIn`/`addingTimeInterval` durations are arbitrary inputs chosen to straddle the 60s refresh skew, and `kdfIterations: 600000` in the mock unlock-data JSON is a **server-response field** the client reads (never compares to `pbkdf2Iterations`) — coupling it to the iOS constant would be incorrect. Net: no test literal adopts a production constant. Bonus (T4): the tests' hardcoded `"Authorization"`/`"/api/..."` literals act as an independent drift cross-check against C2/C3 constants (test goes red if a constant's value drifts), which is another reason to keep them inline.

## User operation scenarios

- A user unlocks the vault (PBKDF2 + HKDF), views/edits entries (AES-GCM decrypt/encrypt with AAD), uses AutoFill (team-key ECDH unwrap), registers/uses a passkey (P-256 key parsing) — all crypto paths must produce/accept byte-identical bytes (parity/vector tests + manual smoke).
- The app and the AutoFill extension both make network requests (token refresh, fetch entries, upload) — header names, methods, and URL paths must be byte-identical so the server contract is unchanged.
- Console.app log filtering by subsystem `jp.jpng.passwd-sso` continues to surface all three targets' logs.
