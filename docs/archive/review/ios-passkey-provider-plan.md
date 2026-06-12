# Plan: ios-passkey-provider

## Project context

- **Type**: mixed — native iOS app (Swift / SwiftUI) + AutoFill credential-provider app extension, inside a larger Next.js monorepo. This branch touches the iOS targets only.
- **Test infrastructure**: unit tests (XCTest under `ios/PasswdSSOTests`). No iOS CI for this branch locally; device/simulator testing is manual. Server side is untouched.
- Deployment target: **iOS 17.0** (both host + extension), confirmed in `ios/project.yml`.
- Branch: `feat/ios-passkey-provider`, cut from `ios-main` (= origin/main, includes #544).

## Objective

Reach feature parity with the browser extension's passkey (WebAuthn) provider — **on the USE (assertion) side**: let a user sign in to a third-party website/app on iOS, via native AutoFill, using a passkey that passwd-sso already holds (created by the browser extension and synced E2E). The passkey appears in the iOS system passkey sheet (QuickType) and, when chosen, passwd-sso produces a valid WebAuthn assertion (P-256 ECDSA signature) locally, offline, biometric-gated.

**Explicitly deferred to a follow-up branch**: passkey *registration* (creating a new passkey from iOS) and signature-counter write-back. See "Considerations" for the rationale (the AutoFill extension is read-only / offline; a deferred-upload registration path risks account lockout).

## Requirements

### Functional

1. The AutoFill extension declares passkey support so iOS routes WebAuthn assertion ceremonies to passwd-sso.
2. Stored passkeys (personal `entryType=PASSKEY` entries) are registered as `ASPasskeyCredentialIdentity` in `ASCredentialIdentityStore` while the vault is unlocked, so they surface in the system passkey sheet — registered/cleared on the SAME lifecycle hooks as the existing password QuickType identities (unlock/foreground-sync → register; lock/logout/background/launch → clear).
3. When iOS requests a passkey assertion (`prepareInterfaceToProvideCredential(for:)` with a `.passkeyAssertion` request, or selection from the extension's own list via `prepareCredentialList(for:requestParameters:)`), passwd-sso:
   - resolves the chosen passkey entry by `recordIdentifier`,
   - decrypts its full blob offline (existing biometric-gated unwrap path),
   - builds `authenticatorData` and signs `authenticatorData ‖ clientDataHash` with the entry's P-256 private key,
   - returns an `ASPasskeyAssertionCredential`.
4. Personal entries only (team passkeys out of scope, matching the #537 QuickType precedent).
5. Passkey *registration* requests (`prepareInterface(forPasskeyRegistration:)`) are **explicitly and cleanly cancelled** (not silently mishandled), so the OS falls through to another provider instead of producing a broken/unsaveable credential.

### Non-functional

- **No network and no writes from the AutoFill extension** — it has no bearer token and no `MobileAPIClient` (per-app keychain token, offline by design). All assertion work is local.
- **Per-fill biometric preserved**: exactly one Keychain `readForFill` per fill (reuse `CredentialResolver`'s retained-blob pattern); never fill silently.
- **signCount is emitted as 0** on every assertion (no counter state on iOS). See C7.
- The private-key JWK is carried as `Data` (UTF-8 bytes), never logged, and zeroed via the existing `zeroData(&mutable)` pattern immediately after the `P256.Signing.PrivateKey` is constructed (S4). (Swift `String` cannot be reliably zeroed; `Data` matches the existing `mutableVaultKeyData` zeroing.)
- **userVerification**: we always emit UV=true (UP=true) because every fill is biometric-gated (I2). `userVerificationPreference` is read but `.discouraged` is intentionally NOT honored — emitting UV=true is strictly stronger assurance than requested and carries no downgrade risk; documented as a deliberate, no-security-impact deviation (S10).
- Backward compatible with existing caches and existing password/TOTP AutoFill (no regression).

## Technical approach

- Storage model is fixed by the server/extension (confirmed): a passkey is a `PasswordEntry` with `entryType=PASSKEY`; all material lives in the client-side E2E `encryptedBlob`. Relevant decrypted-blob fields:
  - Overview blob: `title`, `username`, `relyingPartyId`, `credentialId`, `creationDate`, `tags`.
  - Full blob: above **plus** `passkeyPrivateKeyJwk` (stringified P-256 EC JWK with `d`/`x`/`y`), `passkeyUserHandle` (base64url), `passkeySignCount` (Int), `passkeyAlgorithm` (-7), `passkeyPublicKeyCose`, `passkeyUserDisplayName`, `passkeyTransports`.
- iOS signs with CryptoKit `P256.Signing.PrivateKey(rawRepresentation: d)` → `.signature(for:).derRepresentation`. **`ASPasskeyAssertionCredential.signature` is DER/ASN.1-encoded ECDSA, passed unchanged to the RP** — VERIFIED against Apple Developer Forums thread 710457 (a developer who debugged passkey-provider signature verification confirmed `sigdecode_der`) and consistent with the browser extension's own P1363→DER conversion (`extension/src/lib/webauthn-crypto.ts` `p1363ToDer`). So `.derRepresentation` is correct (NOT `.rawRepresentation`).
- **iOS supplies `clientDataHash` directly** in the passkey request — the extension does NOT construct `clientDataJSON` and does NOT perform origin validation (the OS owns RP/origin binding; it generates `clientDataHash` from its own origin-validated `clientDataJSON`, so a caller cannot smuggle a cross-origin hash). This is the key simplification vs. the browser extension. Defense-in-depth: we still assert the chosen entry's stored rpId equals the request's rpId (C6/S2).
- **entryType is NOT on the cache row** (`CacheEntry` has no `entryType`; it is dropped by `HostSyncService` today). To classify passkeys in the extension and to register passkey QuickType identities in the host, add an **optional** `entryType` to `CacheEntry` (nil-tolerant for old caches) AND extend the overview decode with `relyingPartyId`/`credentialId`. `userHandle` lives only in the full blob, so the host decrypts each passkey's full blob during sync to obtain it for `ASPasskeyCredentialIdentity`.

## Contracts

> Conventions: `EncryptedData` = existing hex `{ciphertext, iv, authTag}`. base64url decode = existing `base64URLDecode`. AAD uses existing `buildPersonalEntryAAD(userId, entryId, vaultType)`.

### C1 — Extension passkey capability + entitlements

- **Change**: in `ios/project.yml`, add `ProvidesPasskeys: true` to the extension's `NSExtensionAttributes.ASCredentialProviderExtensionCapabilities` (alongside `ProvidesPasswords`/`ProvidesOneTimeCodes`).
- **Invariant**: the `com.apple.developer.authentication-services.autofill-credential-provider` entitlement is present on BOTH host and extension (already true — verify, do not remove). No `associated-domains` / `webcredentials` is added (assertion does not need it; that is an RP-side concern).
- **Acceptance**: built extension's `Info.plist` shows all three `Provides*` keys true; iOS offers passwd-sso in the passkey sheet on a device that has a matching stored passkey.
- **Forbidden**: `pattern: ProvidesPasskeys:\s*false` — reason: must be true or absent-then-added, never false.

### C2 — Passkey assertion crypto (Shared, new file `ios/Shared/Crypto/PasskeyAssertion.swift`)

Signatures (no bodies):

```swift
public enum PasskeyCryptoError: Error, Equatable {
  case malformedJWK
  case unsupportedKeyType    // kty != "EC" or crv != "P-256"
  case malformedPrivateScalar // d absent or not exactly 32 bytes after base64url-decode
  case rpIdMismatch           // stored rpId != request rpId (C6/S2)
}

/// Parse a stringified JWK ({kty:"EC", crv:"P-256", d, x, y}) into a P-256 signing key.
/// `d` is base64url; MUST decode to exactly 32 bytes → rawRepresentation. Rejects
/// non-EC / non-P-256 / wrong-length d.
public func decodeP256PrivateKeyJWK(_ jwkJSON: Data) throws -> P256.Signing.PrivateKey

/// authData = SHA256(rpId)(32) ‖ flags(1) ‖ signCount(4, big-endian).
/// flags = (userPresent ? 0x01 : 0) | (userVerified ? 0x04 : 0). No attested-cred / extensions.
/// signCount is a parameter for testability; the production assertion path always passes 0 (C7).
public func buildAssertionAuthenticatorData(
  rpId: String, userPresent: Bool, userVerified: Bool, signCount: UInt32
) -> Data

/// Sign authenticatorData ‖ clientDataHash with ECDSA-P256-SHA256; return the DER
/// (ASN.1) signature — `.derRepresentation` (NOT raw r‖s). This is what
/// ASPasskeyAssertionCredential.signature expects (VERIFIED, see Technical approach).
public func signPasskeyAssertion(
  privateKey: P256.Signing.PrivateKey, authenticatorData: Data, clientDataHash: Data
) throws -> Data
```

- **Invariants**: pure crypto; no I/O, no logging of `d`. The function does not own counter state; `buildPasskeyAssertion` (C6) always passes signCount=0 (C7).
- **Acceptance**: (a) a known P-256 JWK + fixed rpId + clientDataHash produces a `.derRepresentation` signature that verifies via `P256.Signing.PublicKey.isValidSignature(_:for:)` over `authData ‖ clientDataHash`; (b) authData layout byte-exact: 37 bytes, `SHA256(rpId)` at [0..31], byte[32]==flags, bytes[33..36]==signCount BE; (c) `buildAssertionAuthenticatorData(userPresent:true,userVerified:true,...)` → byte[32]==0x05; all-false → 0x00 (T11); (d) malformed `d` (≠32 bytes) / non-P-256 → throws (R16). Use a PINNED P-256 `d` scalar + expected public key, not only generate-then-verify (T1).
- **Forbidden**: `pattern: signCount \+ 1|signCount\+1|signCount \+= ` in this file — reason: no counter increment on iOS (C7).

### C3 — Passkey material decode (Shared, extend `EntryBlobDecoder`)

```swift
public struct PasskeyAssertionMaterial: Sendable, Equatable {
  public let entryId: String
  public let relyingPartyId: String
  public let credentialId: String      // base64url, as stored
  public let userHandle: String        // base64url, as stored (may be empty)
  public let privateKeyJWK: Data        // raw UTF-8 bytes of the stringified JWK; zeroable (S4)
}

/// Decode a passkey's FULL blob into assertion material. Returns nil when the
/// blob is not a passkey (no relyingPartyId / no passkeyPrivateKeyJwk).
public static func passkeyMaterial(plaintext: Data, entryId: String) -> PasskeyAssertionMaterial?
```

- `signCount` is NOT carried in material — iOS always emits 0 (C7), so reading/clamping the stored counter is dead weight and is intentionally omitted (removes the overflow-edge surface T4 raised).
- Add a private `PasskeyFullBlobPayload: Decodable` (or extend `FullBlobPayload`) decoding EXACTLY these keys from the full blob: `relyingPartyId: String?`, `credentialId: String?`, `passkeyPrivateKeyJwk: String?` (a JSON **string** that itself contains the JWK object — double-encoded, see Testing/T5), `passkeyUserHandle: String?`. `passkeyMaterial` returns nil unless `relyingPartyId`, `credentialId`, AND `passkeyPrivateKeyJwk` are ALL present (F17 — `credentialId` is required because `PasskeyAssertionOutputs.credentialID` is non-optional; gating here fails fast instead of letting an empty string reach `base64URLDecode` in `buildPasskeyAssertion`); `privateKeyJWK` = the UTF-8 bytes of the `passkeyPrivateKeyJwk` string (still double-encoded — `decodeP256PrivateKeyJWK` parses the inner JSON). The inner JWK may carry extra Web-Crypto fields (`key_ops`, `ext`) — `JSONDecoder` ignores unknown keys (T13).
- Extend `OverviewBlobPayload` with `relyingPartyId: String?`, `credentialId: String?`; extend `VaultEntrySummary` with optional `relyingPartyId: String?`, `credentialId: String?` (default nil) and surface them in `EntryBlobDecoder.summary`. A summary is a passkey iff `relyingPartyId != nil`. (userHandle is NOT in the overview — see C5.)
- **Invariant**: `VaultEntrySummary`'s new fields are additive with defaults so existing `init` call sites and Codable decode of old cached summaries still compile and decode.
- **Acceptance**: a LOGIN overview decodes with `relyingPartyId == nil` (classified non-passkey); a passkey full blob with a **double-encoded** `passkeyPrivateKeyJwk` string decodes to non-nil material with the expected rpId/credentialId/userHandle/privateKeyJWK; the same JSON with a bare JWK *object* at that field → nil (T5).

### C4 — Cache row carries entryType (Shared `CacheEntry`, host `HostSyncService`)

- Add `public let entryType: String?` to `CacheEntry` (optional, default nil) and to its `init`. `HostSyncService` (`ios/PasswdSSOApp/Vault/HostSyncService.swift`, the `personal.map { … CacheEntry(…) }` block) currently DROPS `entryType` though `EncryptedEntry.entryType` is already decoded (`ios/PasswdSSOApp/Vault/EntryFetcher.swift`) — populate it there. Old caches (no field) decode to nil.
- **Team caveat (F5)**: `TeamEncryptedEntry` does not carry `entryType` at all, so team rows have `entryType == nil` permanently. Acceptable — team passkeys are out of scope (I5); the `relyingPartyId != nil` fallback below covers/excludes them correctly.
- **Consumer-flow walkthrough**:
  - Consumer A (`CredentialResolver.decryptSummary/decryptDetail`, `ios/Shared/AutoFill/CredentialResolver.swift`) reads `{ entryType }` only as a fast pre-classifier; it MUST NOT rely on it for correctness — passkey classification still falls back to `relyingPartyId != nil` from the decrypted overview (C3), because old cache rows AND all team rows have `entryType == nil`. So `entryType` is an optimization, not the source of truth.
  - Consumer B (host passkey-identity builder, C5) reads `{ entryType }` to select which personal entries to decrypt-full-blob for userHandle; for `entryType == nil` rows it falls back to decrypting overview and checking `relyingPartyId != nil`. Required fields all present.
- **Invariant**: adding the field does not force a cache version bump that invalidates existing caches — it is decode-optional. CONFIRMED (F7): `EntryCacheFile`'s AES-GCM MAC covers the ciphertext wholesale, not the JSON key set; a missing `entryType` key decodes to `nil` without breaking authentication.
- **Acceptance**: a cache written before this change still loads (no rejection); a freshly synced PASSKEY `EncryptedEntry` produces a `CacheEntry` with `entryType == "PASSKEY"` (HostSyncServiceTests, S6). Old-cache decode test uses a JSON literal lacking the key → `entryType == nil` (T7).

### C5 — Passkey QuickType identity registration (host + Shared `CredentialIdentityRegistrar`)

```swift
public struct PasskeyIdentitySpec: Sendable, Equatable {
  public let relyingPartyIdentifier: String
  public let userName: String
  public let credentialID: Data       // base64url-decoded
  public let userHandle: Data         // base64url-decoded
  public let recordIdentifier: String // vault entry id
}
```

- Extend `CredentialIdentityStoring` so a single replace registers BOTH password and passkey identities in ONE atomic call. Use the iOS 17+ heterogeneous-array API: the ObjC selector is `replaceCredentialIdentityEntries:` but its **Swift name is `replaceCredentialIdentities(_:)`** (via `NS_SWIFT_NAME`), taking `[any ASCredentialIdentity]` — both `ASPasswordCredentialIdentity` and `ASPasskeyCredentialIdentity` conform (F13). The existing code already calls `ASCredentialIdentityStore.shared.replaceCredentialIdentities(identities)` with a homogeneous `[ASPasswordCredentialIdentity]`; passing a mixed `[any ASCredentialIdentity]` selects the heterogeneous overload — one atomic replace of the whole store.

```swift
public protocol CredentialIdentityStoring: Sendable {
  func isEnabled() async -> Bool
  // Back-compat (S5): default passkeys: [] so existing callers/tests using the
  // password-only form keep compiling; one atomic replace covers both kinds.
  func replace(passwords: [CredentialIdentitySpec], passkeys: [PasskeyIdentitySpec]) async
  func removeAll() async
}
extension CredentialIdentityStoring {
  func replace(with passwords: [CredentialIdentitySpec]) async {
    await replace(passwords: passwords, passkeys: [])
  }
}
```

- **Where passkey specs are built and threaded (F14/F15)** — adopt the existing `decryptPersonalOverviews` pattern, NOT a `runSync`/`SyncReport` change. Add a Shared helper, sibling to `decryptPersonalOverviews` in `CredentialIdentityRegistrar.swift`:

```swift
/// Decrypt the FULL blobs of personal PASSKEY entries to build QuickType passkey
/// identity specs. Mirrors decryptPersonalOverviews' signature/timing so the two
/// call sites can invoke both from the same place (post-sync, vaultKey in scope).
public func buildPasskeyIdentitySpecs(
  from cacheData: CacheData, vaultKey: SymmetricKey, userId: String
) -> [PasskeyIdentitySpec]
```

  For each personal entry classified as a passkey (`entryType=="PASSKEY"` OR overview `relyingPartyId != nil`), decrypt the FULL blob (AAD = `buildPersonalEntryAAD(userId, entryId, .blob)`), read `relyingPartyId`, `credentialId`, `passkeyUserHandle`, `userName`, base64url-decode credentialId/userHandle. SKIP entries whose credentialId fails to decode OR whose decoded `userHandle` is EMPTY (0 bytes) — `ASPasskeyCredentialIdentity` requires a non-empty userHandle; registering empty silently drops it (T9). Skips are debug-logged WITHOUT secret material.

- Extend the registrar's higher-level method to thread passkeys: `CredentialIdentityRegistrar.replace(with summaries: [VaultEntrySummary], passkeys: [PasskeyIdentitySpec] = [])` → `store.replace(passwords: Self.specs(from: summaries), passkeys: passkeys)`. The default `[]` keeps the lock/clear paths and any password-only caller compiling.
- **Update BOTH call sites** (`PasswdSSOApp/PasswdSSOAppApp.swift` ~line 59-62 foreground-sync; `PasswdSSOApp/Views/RootView.swift` — the `refreshCredentialIdentities(cacheData:vaultKey:userId:)` chokepoint at ~line 328-329, which already serves both `handleVaultUnlocked` and the DEBUG vault-loaded path): after `decryptPersonalOverviews(...)`, also call `buildPasskeyIdentitySpecs(from: cacheData, vaultKey:, userId:)` and pass both into `replace(with: summaries, passkeys: passkeySpecs)`. Without this, the atomic combined replace with `passkeys: []` would wipe passkey identities on every foreground sync (F14). Confirmed these are the only `replace(with:)` production call sites.
- **Consumer-flow walkthrough** (`ASPasskeyCredentialIdentity(relyingPartyIdentifier:userName:credentialID:userHandle:recordIdentifier:)`): the OS reads all five fields; `credentialID`/`userHandle` must be the raw decoded bytes, `recordIdentifier` is our entry id used later to resolve the entry in the assertion path (C6). userHandle is NOT in the overview blob (confirmed F10), which is why C5 mandates a full-blob decrypt for passkey entries.
- **Invariant**: lifecycle parity (I6) — passkey identities are registered and cleared at exactly the same call sites as the existing password QuickType identities (no new lifecycle). One atomic `replaceCredentialIdentityEntries` swaps the WHOLE set (passwords+passkeys) so a password-only refresh with `passkeys: []` also clears stale passkey identities. Provider-disabled → no-op (existing `isEnabled` gate); `removeAll()` clears both kinds.
- **Acceptance**: after unlock+sync with one stored passkey, the system passkey sheet on a matching RP lists it; after lock/logout/background/launch the identity is gone (store cleared). Unit: `replace(passwords:[…],passkeys:[])` registers only password identities (no stale passkeys); empty-userHandle passkey spec is skipped.
- **Forbidden**: `pattern: import .*MobileAPIClient|URLSession` under `PasswdSSOAutofillExtension/` (the host, not the extension, builds passkey identities — the extension never registers). Assertion-side construction of `ASPasskeyAssertionCredential` in the extension is expected and fine.

### C6 — Assertion handling (extension `CredentialProviderViewController` + a Shared builder)

Shared builder (so it is unit-testable without the extension host):

```swift
/// Inputs the OS gives us for a passkey assertion. clientDataHash is provided by iOS.
public struct PasskeyAssertionRequest: Sendable {
  public let relyingPartyId: String
  public let clientDataHash: Data
  public let userVerificationRequired: Bool
}

/// Build the assertion outputs from decrypted material + the OS request.
/// FIRST asserts material.relyingPartyId == request.relyingPartyId (throws
/// PasskeyCryptoError.rpIdMismatch otherwise — defense-in-depth, S2), then uses
/// request.relyingPartyId (OS-provided, authoritative) for authData. Emits
/// signCount = 0 (C7). UP=true; UV=true (we biometric-gate every fill, S10).
/// Returns the fields needed to construct ASPasskeyAssertionCredential.
public struct PasskeyAssertionOutputs: Sendable {
  public let userHandle: Data
  public let relyingParty: String
  public let signature: Data            // DER (.derRepresentation)
  public let authenticatorData: Data
  public let credentialID: Data
}
public func buildPasskeyAssertion(
  material: PasskeyAssertionMaterial, request: PasskeyAssertionRequest
) throws -> PasskeyAssertionOutputs

/// Pure, Shared, unit-testable: filter decrypted summaries to passkeys whose
/// stored rpId EXACTLY equals the requested rpId (no eTLD+1 expansion — the OS
/// already domain-filters before invoking the provider). Extracted out of the
/// view controller so the list-path logic is testable (T6).
public func filterPasskeyCandidates(_ summaries: [VaultEntrySummary], rpId: String) -> [VaultEntrySummary]
```

Extension wiring (thin coordinators only; all logic in Shared above):
- `CredentialResolver` gains `decryptPasskeyMaterial(entryId:) async throws -> PasskeyAssertionMaterial` (parallels `decryptEntryDetail`; reuses retained blob → same single-biometric-read contract I2; applies the same `defer { zeroData(&mutableVaultKeyData) }` guard, S8; personal entries only — throws `entryNotFound` for team or non-passkey entries, T8). `PasskeyAssertionMaterial` is a short-lived local; the assertion handler zeroes `material.privateKeyJWK` (Data) on both the success path (after the `P256.Signing.PrivateKey` is built) and in the `catch` before re-throwing, so an `rpIdMismatch` throw does not leave `d` lingering (S11). For defense-in-depth, the handler MAY assert `material.relyingPartyId == request.relyingPartyId` before decrypt is even reached via `filterPasskeyCandidates` selection, but `buildPasskeyAssertion` remains the authoritative guard.
- `prepareInterfaceToProvideCredential(for credentialRequest: any ASCredentialRequest)` (Swift 6 `any`, F9): branch on `credentialRequest.type == .passkeyAssertion` → downcast to `ASPasskeyCredentialRequest`, read `relyingPartyIdentifier`, `clientDataHash`, `userVerificationPreference`, and `recordIdentifier` (from `credentialIdentity`, type `String?` — if nil/empty, `cancel` with a descriptive error rather than letting `entryNotFound` propagate, F4) → `decryptPasskeyMaterial` → `buildPasskeyAssertion` → `await extensionContext.completeAssertionRequest(using: ASPasskeyAssertionCredential(...))` (the method is async — F2, mirrors the TOTP `await completeOneTimeCodeRequest`). The existing `.password` branch is unchanged; unknown types still `cancel(with: nil)`.
- `prepareCredentialList(for:requestParameters:)`: when `requestParameters.relyingPartyIdentifier` is non-empty (passkey ceremony), present a picker of `filterPasskeyCandidates(all, rpId:)`. `ASPasskeyCredentialRequestParameters` is `Sendable`, so capture it directly in the picker's `onSelect` closure (no instance var needed, F16); on selection build `PasskeyAssertionRequest` from `requestParameters.clientDataHash`, `requestParameters.relyingPartyIdentifier`, and `requestParameters.userVerificationPreference`, then `buildPasskeyAssertion` → `await completeAssertionRequest`. Password-only ceremonies (empty rpId) keep today's behavior. A no-match passkey ceremony presents an empty/locked sheet and the user can cancel (graceful, F8).
- `provideCredentialWithoutUserInteraction(for:)`: unchanged (always `userInteractionRequired`) — already correct for passkeys.
- `ASPasskeyAssertionCredential` is constructed from `PasskeyAssertionOutputs` via the documented initializer `init(userHandle:relyingParty:signature:clientDataHash:authenticatorData:credentialID:)` (clientDataHash from the request). If the SDK variant that also takes `rawAttestationObject` is used, pass `nil` (assertion, not attestation).
- **Acceptance**: end-to-end on device, selecting a stored passkey signs the user into the RP (signature verifies). Unit: rpId-mismatch material+request → `rpIdMismatch` thrown; non-passkey entry id → `entryNotFound`.
- **Forbidden**: `pattern: import .*MobileAPIClient|URLSession` inside `PasswdSSOAutofillExtension/` — reason: extension stays offline/read-only.

### C7 — signCount semantics: emit 0 unconditionally (no counter state on iOS)

- iOS emits `signCount = 0` on EVERY assertion. It does not read, increment, or write back the stored counter. This is the established behavior for an authenticator that does not maintain a persistent signature counter — the WebAuthn spec's "Signature Counter Considerations" permit a constant 0 when the authenticator does not implement a counter, and Apple's own synced passkeys send 0. (Citation: WebAuthn Level 3 "Signature Counter Considerations" — section number unverified here; confirm before quoting in the PR body.)
- **Why 0 (corrects an earlier "emit stored N" design — S1)**: the browser extension *increments* the counter and persists N+1 to both the blob and the RP. So after a browser sign-in the RP's stored counter is N+1 and our blob is N+1. An RP that strictly enforces monotonicity (`received > stored`) rejects ANY value ≤ N+1 — emitting stored N+1 fails (`N+1 ≤ N+1`), and emitting a decreased value fails too. Emitting stored-N is therefore NO better than 0 against strict RPs, while 0 is the standard "I don't track counters" signal (Apple/iCloud Keychain synced passkeys always send 0) that RP libraries special-case (e.g. SimpleWebAuthn skips the check when both received and stored are 0).
- **Honest known limitation (documented, not hidden)**: a passkey that has already been used via the browser extension against an RP that *strictly* enforces signCount monotonicity may be rejected on iOS (the RP saw a non-zero counter; iOS sends 0). Most RPs do NOT strictly enforce this (it is a SHOULD, widely relaxed precisely because synced/multi-device authenticators break it). The complete fix is counter write-back via the host — deferred to the registration/write-back follow-up branch. This limitation is recorded in the manual-test doc and the PR body.
- **Acceptance**: every iOS assertion presents signCount 0 (authData bytes[33..36]==0); two consecutive assertions are identical in that field; passwd-sso's own RP accepts; a never-browser-used passkey (RP counter 0) is accepted by a standards-conformant RP.

### C8 — Registration explicitly out of scope but safely handled

- `prepareInterface(forPasskeyRegistration registrationRequest: any ASCredentialRequest)` (iOS 17+, Swift 6 `any`) MUST be **explicitly overridden** and call `extensionContext.cancelRequest(withError: NSError(domain: ASExtensionErrorDomain, code: ASExtensionError.failed.rawValue))`. "Omit the override" is NOT an option (S3): with `ProvidesPasskeys: true`, iOS routes registration to us, and the base-class default for an un-overridden registration handler is undefined across iOS versions (may hang the ceremony). An explicit clean cancel makes iOS fall through to another provider.
- **Invariant**: passwd-sso must NEVER return an `ASPasskeyRegistrationCredential` it cannot persist (that would hand the RP a credential whose private key we then lose → permanent account lockout). This is the core safety reason registration is deferred.
- **Acceptance**: on a device, selecting passwd-sso for passkey *creation* does not produce a stored-but-unsaveable credential and does not hang — the user can complete creation with another provider (e.g. iCloud Keychain). The forbidden-pattern grep confirms no `ASPasskeyRegistrationCredential` / `completeRegistrationRequest` appears in the diff.

## Invariants (cross-cutting)

- I1: AutoFill extension performs no network I/O and no writes (C6 forbidden pattern enforces).
- I2: One biometric Keychain read per fill (reuse `CredentialResolver` retained-blob).
- I3: Private-key JWK never logged; cleared after signing.
- I4: Additive model changes (`VaultEntrySummary`, `CacheEntry`) are backward compatible (optional/defaulted) — old caches load, password/TOTP AutoFill unaffected.
- I5: Personal entries only; team passkeys skipped (parity with #537).
- I6: Lifecycle parity for QuickType passkey identities (same register/clear hooks as passwords).

## Forbidden patterns (diff-wide grep keys)

These greps are run as a contract-conformance gate during Phase 2 (post-implementation) and Phase 3 (review) against `git diff ios-main...HEAD` — they are part of the automated/reviewer pre-PR checklist, not merely advisory (T16). The registration-cancel path (C8) is additionally verified by device manual test.

- `pattern: import .*MobileAPIClient` in `PasswdSSOAutofillExtension/` — reason: extension must not gain network/write capability.
- `pattern: URLSession` in `PasswdSSOAutofillExtension/` — reason: same.
- `pattern: signCount \+ 1|signCount\+1|signCount \+= 1` anywhere — reason: no counter increment (C7).
- `pattern: completeRegistrationRequest|ASPasskeyRegistrationCredential` — reason: registration is out of scope; returning one risks lockout (C8). (If present, it must be a deliberate, reviewed exception — default is absence.)
- `pattern: os_log|Logger\.|print\(|NSLog` inside `PasskeyAssertion.swift` and `EntryBlobDecoder`'s passkey-decode methods — reason: no secret logging (I3); the narrow `os_log.*jwk` grep missed `os_log("parse error: \(err)")` where `err` wraps a JWK fragment (S12). Catch blocks MUST re-throw as `PasskeyCryptoError.malformedJWK`/`.malformedPrivateScalar` WITHOUT logging the caught decoder error.

## Testing strategy

- **Unit (XCTest, new files under `ios/PasswdSSOTests`)**:
  - `PasskeyAssertionTests`:
    - **PINNED vector** (T1/T11): a hardcoded P-256 `d` scalar (base64url) + known rpId (`"webauthn.io"`) + fixed `clientDataHash`. Assert authData is byte-exact (37 bytes; `SHA256(rpId)` at [0..31]; byte[32]==0x05 for UP+UV, 0x00 for all-false; bytes[33..36]==signCount BE) AND the `.derRepresentation` signature verifies via `P256.Signing.PublicKey(x,y).isValidSignature(_:for:)` over `authData ‖ clientDataHash`. NOT generate-then-verify alone (would pass even with a wrong shared layout).
    - JWK decode: valid; wrong `kty`/`crv` → `unsupportedKeyType`; `d` ≠ 32 bytes → `malformedPrivateScalar`.
    - `buildPasskeyAssertion` (explicit tests, T14): signature is DER (`.derRepresentation`); UV=true, UP=true; rpId-mismatch material/request → throws `rpIdMismatch`; matching rpIds → `outputs.relyingParty == request.relyingPartyId` (confirms the OS-provided rpId, not the material value, drives authData); signCount always 0 — call twice with the SAME material + DIFFERENT clientDataHash and assert both outputs' authData[33..36] are equal and == BE(0) (T3).
  - `EntryBlobDecoderTests` additions: passkey full-blob (with **double-encoded** `passkeyPrivateKeyJwk` string, T5) → non-nil material; same JSON with a bare JWK *object* at that field → nil; LOGIN overview → `relyingPartyId == nil`; passkey overview → rpId/credentialId surfaced; empty `passkeyUserHandle` decodes (skip happens at registrar, C5).
  - `CredentialIdentityRegistrarTests` (MIGRATION, T2/T12 — the `FakeIdentityStore` change MUST land in the SAME commit as the protocol change: add the required `replace(passwords:passkeys:)` method + a `replacedPasskeySpecs` capture (nil/[] when no passkeys passed) + keep `replacedPasswordSpecs`; the old `replace(with:)` is now a protocol-extension default, so the fake must implement only the new requirement, else "type does not conform"). Tests: `buildPasskeyIdentitySpecs` builds specs from a cache with a passkey full blob; ONE combined replace registers both kinds; empty-userHandle spec skipped (T9); credentialId decode failure skipped; dedup; provider-disabled → no-op; `removeAll` clears both; back-compat `replace(with: [pwd])` → `replacedPasswordSpecs` has the pwd AND `replacedPasskeySpecs` is empty (T15, guards against the wrapper passing a wrong array / stale passkeys).
  - `CacheEntry` decode: an old JSON literal lacking `entryType` → `entryType == nil` (T7); new fixture → "PASSKEY".
  - `HostSyncServiceTests`: a PASSKEY `EncryptedEntry` → `CacheEntry.entryType == "PASSKEY"` (S6).
  - `CredentialResolverTests`: `decryptPasskeyMaterial` on a LOGIN entry id → `entryNotFound` (T8); on a team entry id → `entryNotFound` (I5); biometric-read invariant for `resolveCandidates` → `decryptPasskeyMaterial` mirrors the existing `testResolveCandidates_singleKeychainRead`, which asserts `copyMatchingCallCount == 2` (one biometric-gated bridge-key read + one no-ACL meta read) — assert `== 2`, NOT `== 1` (T17); per-test temp-dir isolation (RT5).
  - `filterPasskeyCandidates` pure-function tests: exact rpId match only; no eTLD+1 expansion (T6).
- **Manual / device** (`docs/archive/review/ios-passkey-provider-manual-test.md`, required by R35 — auth-flow + deployment-surface change; sections Pre-conditions / Steps / Expected / Rollback / Adversarial). Happy path: passkey created via the browser extension on an RP (e.g. webauthn.io), sync, sign in on iOS via the system passkey sheet. **Adversarial scenarios (T10)**: (1) RP that strictly enforces signCount monotonicity after a prior browser use → document accept/reject (the C7 known limitation); (2) team-entry id routed to the passkey path → no crash/hang, clean fail; (3) vault locks between `resolveCandidates` and the user tapping the sheet → locked sheet, no cryptic error; (4) both passwd-sso and iCloud Keychain hold a passkey for the same rpId → no cross-contamination; (5) C8 registration attempt → clean fallthrough, no stuck dialog. Also verify password/TOTP AutoFill unregressed. RS4: use placeholder identities, no real personal data in the doc.
- Run the project's iOS test command (`xcodebuild … test` for the host scheme) and confirm green before completion.

## User operation scenarios

1. Desktop: user creates a passkey on `example.com` via the browser extension → syncs. iPhone: opens `example.com` in Safari, taps Sign in → system passkey sheet lists the passwd-sso passkey → Face ID → signed in.
2. Vault locked on iPhone → passkey ceremony → passwd-sso shows the honest locked sheet / does not offer a broken credential.
3. RP requests a passkey for an rpId with no stored match → passwd-sso contributes nothing; other providers still work.
4. User tries to *create* a passkey on iPhone with passwd-sso selected → falls through to another provider (no lockout); registration is a later branch.
5. Two sign-ins in a row on the same passkey → both accepted despite equal signCount.

## Considerations & constraints

- **Why assertion-only**: the AutoFill extension has no auth token (per-app keychain, no shared access group) and no networking layer; it is read-only/offline. Registration requires durable, synchronous persistence of a freshly generated private key — impossible from the extension, and a deferred "stage to App Group, host uploads later" path creates a window where the RP has the credential but passwd-sso has not persisted the private key → **account lockout** if the host app is never reopened. Shipping that is worse than not having registration. Registration gets its own branch with a correct persistence design.
- **entryType not on cache row**: handled by C4 (optional field + rpId fallback), avoiding a breaking cache-format bump.
- **userHandle only in full blob**: handled by C5 (host decrypts passkey full blobs at sync for identity registration).
- **Out of scope**: passkey registration/creation; counter write-back; team passkeys; PRF/largeBlob extensions; `excludeCredentials` dedup; attestation (assertion only).
- **External dependency**: relies on the browser extension's stored-passkey blob shape (`passkeyPrivateKeyJwk` etc.) — if that shape changes server-side, decode must follow. Pinned by the EntryBlobDecoder tests.

## Go/No-Go Gate

| ID  | Subject                                                    | Status |
|-----|-----------------------------------------------------------|--------|
| C1  | Extension passkey capability + entitlements               | locked |
| C2  | Passkey assertion crypto (Shared)                         | locked |
| C3  | Passkey material decode (EntryBlobDecoder + summary)      | locked |
| C4  | Cache row carries entryType (optional, backward compat)   | locked |
| C5  | Passkey QuickType identity registration                   | locked |
| C6  | Assertion handling (extension + Shared builder)           | locked |
| C7  | signCount semantics (emit 0, no write-back)               | locked |
| C8  | Registration out of scope, safely handled                 | locked |

All contracts `locked` after 3 plan-review rounds (round 3: READY TO LOCK — no blocking findings). Proceeding to Phase 2.
