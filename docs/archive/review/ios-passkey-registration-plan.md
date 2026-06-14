# Plan: ios-passkey-registration (v2 — DPoP-bound)

> Revised after Phase-1 round-1 review. **Auth design decided (user): keep DPoP
> sender-constraint** (proper security for a password manager) — the iOS AutoFill
> extension signs DPoP with its OWN Secure-Enclave key created in the SHARED
> Keychain group, and the server mints a short-lived, write-scoped token bound to
> that key's jkt. Synchronous upload preserves the no-lockout invariant.
> Spans **server (Next.js) + iOS**. See `ios-passkey-registration-review.md`.

## Project context
- **Type**: mixed — Next.js server (`src/`) + iOS AutoFill extension & host (`ios/`).
- **Test infra**: server = Vitest (`npx vitest run`) + `npx next build`; iOS = XCTest (`xcodebuild test`).
- Base: `feat/ios-passkey-registration` from `ios-main` (== `origin/main`). iOS 17+.

## Objective
Let a relying party create a passkey through the passwd-sso iOS provider: the extension generates a P-256 credential, **durably persists it (E2E-encrypted) to the server within the same ceremony over a DPoP-bound channel**, then returns the attestation. Any failure → `cancelRequest` (fall-through to iCloud Keychain), so a credential is never returned without a confirmed, durable save.

## Why this design (round-1 F1/S1 resolution)
The host's mobile DPoP key is a host-only Secure-Enclave key and is **immutable** — it cannot be shared to the extension. The browser extension itself authenticates with a **DPoP-bound** extension token (no plain-bearer path exists server-side). Decision: the iOS AutoFill extension gets its **own** SE DPoP key in the shared Keychain access group (created in that group from the start, so both host and extension can use it), and the server issues a token bound to it. This keeps full sender-constraint security (no token-replay downgrade), matching the browser extension's posture.

## Requirements
### Functional
- Server: a host-authenticated endpoint mints a short-lived, `passwords:write`-scoped, **DPoP-bound** token for `clientKind: IOS_AUTOFILL`, bound to a host-supplied jkt (the extension key's thumbprint).
- iOS host: generate/maintain the extension DPoP key in the shared group; mint + cache the AutoFill token after unlock; clear on lock/sign-out.
- iOS extension: implement `prepareInterface(forPasskeyRegistration:)` — generate keypair, build a spec-correct `none`-attestation, build+encrypt the PASSKEY blob, DPoP-sign + POST `/api/passwords`, and complete the registration ONLY on confirmed persistence.
- Declare the `ProvidesPasskeyRegistration` extension capability (F4) so iOS routes the ceremony to us.

### Non-functional / Security (load-bearing invariants)
- **No-lockout**: `completeRegistrationRequest` is reachable from EXACTLY ONE place, after a confirmed 2xx + id-match. Every other branch (unsupported-alg, no/invalid token, DPoP fail, crypto fail, vault-locked, network/non-2xx, id-mismatch) → `cancelRequest`. (F5: the deferred-foreground guard is reset per entry so registration work can't be silently dropped.)
- DPoP sender-constraint preserved (the extension signs with the shared SE key; the token's `cnf.jkt` matches).
- Private key only ever exists in memory + the E2E vault blob; zeroed after (S4).
- The minted token is short-lived (≤ ~1h), `passwords:write` only, cleared on lock/sign-out; never the refresh token.

## Contracts

### Server
#### S-C1 — `clientKind: IOS_AUTOFILL` + DPoP-bound token validation
- Extend the `ExtensionTokenClientKind` enum (Prisma) with `IOS_AUTOFILL`. `validateExtensionToken` accepts these rows with the SAME DPoP enforcement as `BROWSER_EXTENSION` (cnfJkt required, proof verified) — NOT a non-DPoP bypass.
- **Invariant**: no code path validates an `IOS_AUTOFILL` token without a matching DPoP proof.
- **Acceptance**: Vitest — a valid IOS_AUTOFILL token + correct DPoP proof → accepted on `POST /api/passwords` with `passwords:write`; wrong/absent DPoP → 401.

#### S-C2 — `POST /api/mobile/autofill-token`
- Host-authenticated (existing mobile DPoP access token + DPoP). Body: the extension key's public JWK (or jkt). Mints a short-lived (config, default ~1h) extension token row: `clientKind: IOS_AUTOFILL`, `cnfJkt = thumbprint(jwk)`, scope `["passwords:write"]`, family-grouped, revocable.
- **Invariant**: only an authenticated host session/token can mint; the minted token is scope-minimised (no `vault:unlock-data`, no read).
- **Consumer-flow walkthrough**: the extension reads `{ token }` from the cache and `{ jkt }` it owns the key for; it signs DPoP with the shared SE key whose thumbprint == the token's `cnf.jkt`, and calls `POST /api/passwords`. The server validates token+DPoP+scope. All fields present. ✓
- **Acceptance**: Vitest — happy path issues a bound token; rate-limited; rejects unauthenticated callers; the issued token's cnfJkt equals the supplied jkt.

### iOS — crypto & blob (server-independent; build first)
#### C1 — WebAuthn registration crypto (`ios/Shared/Crypto/PasskeyRegistration.swift`)
- P-256 keygen (`P256.Signing.PrivateKey`), random 32-byte credentialId, COSE EC2 encoder, minimal CBOR encoder, attestation authData, `none` attestationObject.
- **Flags**: registration authData sets `UP|UV|AT|BE|BS` (`0x5D`) — iOS credential providers must set BE|BS=1 (matches the shipped assertion path). Device testing CONFIRMED this is correct: registration works in Safari with `0x5D`. (History: a mid-investigation change to `0x45` was wrong — it followed the desktop browser-extension reference, the wrong platform, and was tested only in non-Safari iOS browsers which have an Apple-acknowledged WebAuthn bug; reverted. See deviation log.) Zero AAGUID (iOS overwrites it to zero anyway).
- **Testability (T1)**: ship **golden byte vectors** captured from the browser extension's TS encoder for a pinned keypair (COSE key, authData, attestationObject) AND a minimal CBOR *decoder in the test target* to assert `fmt=="none"`, authData length, COSE map keys. Both.
- **Forbidden**: non-zero AAGUID literal; flags byte != 0x5D in registration authData.
- **Acceptance**: byte-equality vs golden vectors; the produced public key verifies a signature from the matching private key via the shipped assertion verifier.

#### C2 — Passkey blob builder (`ios/Shared/Vault/PasskeyEntryBlobBuilder.swift`)
- `buildCreate(...) -> (blob, overview)` matching the extension's PASSKEY shape (Exploration §3): `passkeyPrivateKeyJwk` is a **double-encoded JSON string** including `x`/`y` (F6: encode the full JWK, not just `d`), `passkeyPublicKeyCose`, `credentialId`(b64url), `passkeyUserHandle`(b64url), `passkeySignCount:0`, `passkeyAlgorithm:-7`, transports, `entryType:"PASSKEY"`; overview carries title/rpId/credentialId/username/creationDate.
- **Acceptance (T4)**: round-trip a **real pinned keypair** → build → `EntryBlobDecoder.passkeyMaterial`/`summary` → and pass the stored JWK through `decodeP256PrivateKeyJWK`, asserting it recovers the original public key (a bare-object encoding is a known failure mode).

#### C3 — `registrationOutcome` pure decision function (`ios/Shared/...` or extension target, testable)
- **Mandatory extraction (T2/T6)**: exact signature, pure, no `ASCredentialProviderExtensionContext`:
  ```swift
  enum RegistrationDecision: Equatable { case cancel(reason: String); case complete(/* credential inputs */) }
  func registrationOutcome(supportedAlgorithms: [Int], hasToken: Bool, crypto: Result<…,Error>,
                           upload: Result<String,Error>, expectedEntryId: String) -> RegistrationDecision
  ```
- **Branches tested (the no-lockout matrix)**: unsupported-alg→cancel, no-token→cancel, crypto-fail→cancel, vault-locked→cancel, upload-fail→cancel, id-mismatch→cancel, success→complete. The VC delegates to this; only `.complete` calls `completeRegistrationRequest`.

### iOS — auth wiring (after the server endpoint)
#### C4 — Extension DPoP key in the shared group + `EntryUploader` in `Shared`
- New `SecureEnclaveDPoPSigner` key created with `kSecAttrAccessGroup = $(AppIdentifierPrefix)jp.jpng.passwd-sso.shared` and a distinct label (`com.passwd-sso.dpop.autofill`), generated once, usable by host (to mint) and extension (to sign). (S1: a NEW shared-group key sidesteps the immutable host key.)
- **`EntryUploader` is a NEW `Shared` type** (F2: `MobileAPIClient` is `PasswdSSOApp`-only and cannot move under `APPLICATION_EXTENSION_API_ONLY`). It takes a `DPoPSigner`, the cached token, and reuses the create HTTP/DPoP path (ath = SHA256(token), htm=POST). Stage the **DPoP nonce** alongside the token (S5; nonce is non-secret) so the first create doesn't force a 401-retry.
- **Regression guard (T5)**: keep `MobileAPIClientTests.testCreateEntry_athIsSHA256OfAccessTokenAndHtmIsPost` green (or port it to `EntryUploader`).
- **Acceptance**: extension target links `EntryUploader`; a DPoP proof signs with the shared-group key; host createEntry regression passes.

#### C5 — `UploadTokenStore` (`ios/Shared/Storage/UploadTokenStore.swift`)
- Shared Keychain access group, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (S6), NOT biometric-gated, via the existing `KeychainAccessor` protocol (T3 — `MockKeychainAccessor` in tests, NO device-only fallback). Stores `{ token, expiresAt, dpopNonce? }`.
- **Acceptance**: save/load/expiry + clear, mock-Keychain unit tests.

#### C6 — Host mints/caches/clears the AutoFill token
- After unlock + on foreground-sync, the host calls `POST /api/mobile/autofill-token` (with the shared DPoP key's jkt), caches the result in `UploadTokenStore`; clears on lock/sign-out alongside existing teardown.
- **Acceptance**: unlock writes a valid bound token; lock/sign-out clears it.

#### C7 — Extension registration flow + capability
- Add `ProvidesPasskeyRegistration: true` to `project.yml` `ASCredentialProviderExtensionCapabilities` (F4).
- `prepareInterface(forPasskeyRegistration:)`: reset the foreground-work guard (F5); cast to `ASPasskeyRegistrationRequest`; require ES256; biometric (bridge_key) → vault key + userId/keyVersion; `generatePasskey` → attestation over `clientDataHash`; build+encrypt blob (zero key after, S4); read token (C5) → `EntryUploader.createEntry` with `entryType:"PASSKEY"` (S7); on 2xx+id-match persist to cache + register QuickType identity, then `completeRegistrationRequest(using: ASPasskeyRegistrationCredential(relyingPartyIdentifier:, clientDataHash:, credentialID:, attestationObject:))`. Else cancel.
- **Verify**: the `ASPasskeyRegistrationCredential` initializer takes `clientDataHash` (OS owns clientDataJSON) — confirm against the iOS 17 SDK before locking.

#### C8 — signCount + orphan handling
- New passkey starts signCount 0; the shipped `PasskeySignCountStore` seeds from 0 → first assertion emits 1 (cite `testFirstUseEmitsFloorPlusOne`).
- **Orphan (S3)**: document the upload-succeeds-then-complete-crashes case (server entry exists, RP didn't get the credential; user re-registers; orphan is harmless encrypted key material). Follow-up: a "delete unused passkeys" host view (out of scope here, tracked).

## Testing strategy
- Server: Vitest for S-C1/S-C2 (token mint bound to jkt; DPoP-required validation; scope minimisation; unauthorised mint rejected) + `next build`.
- iOS: golden-vector + CBOR-decoder crypto tests (C1); real-keypair blob round-trip through the assertion decoders (C2); the `registrationOutcome` no-lockout matrix incl. crypto-fail/vault-locked (C3); token store mock-Keychain (C5/C6); `EntryUploader` DPoP `ath` regression (C4).
- **Manual-test** (R35 Tier-2, security-critical): register on webauthn.io via the provider — (a) success persists + immediately authenticates + works on a second device after sync; (b) airplane-mode/no-token → graceful cancel → iCloud Keychain, no orphaned RP credential; (c) post-upload kill → server entry exists, re-register succeeds; (d) no key material in logs. Reproducible adversarial steps (T8): Link Conditioner 100% loss after the RP "create" tap; Keychain token delete; expired token.
- Full `xcodebuild test` + `npx vitest run` + `npx next build`.

## Considerations & constraints
- **DPoP preserved** (user decision): no token-replay downgrade; the cost is the extension owning a shared-group SE DPoP key + a small server mint endpoint.
- **No-lockout** is the invariant the Phase-3 review must attack hardest (every branch of C7 vs C3).
- **Scope-minimised token**: `passwords:write` only, short-lived, revocable family — the extension cannot read vault data or unlock.
- **Attestation `none`/zero AAGUID**: same as iCloud Keychain; enterprise-attestation RPs won't accept (expected).
- **Out of scope**: team-vault passkeys; PRF/largeBlob; non-`none` attestation; the "delete unused passkeys" cleanup UI (tracked follow-up).

## Go/No-Go Gate
| ID | Subject | Status |
|----|---------|--------|
| S-C1 | `IOS_AUTOFILL` clientKind + DPoP-enforced validation | done (`c21ef211`) |
| S-C2 | `POST /api/mobile/autofill-token` (jkt-bound, scope-min) | done (`c21ef211`) |
| C1 | Registration crypto (BE\|BS flags, golden vectors + CBOR decoder) | done (`8a568876`) |
| C2 | Passkey blob builder (full JWK, real-keypair round-trip) | done (`8a568876`) |
| C3 | `registrationOutcome` pure fn (no-lockout matrix) | done (`8a568876`) |
| C4 | Shared-group DPoP key + `EntryUploader` (new Shared type) + nonce staging | done |
| C5 | `UploadTokenStore` (AfterFirstUnlock, mock-Keychain) | done |
| C6 | Host mint/cache/clear token | done |
| C7 | Extension flow + `ProvidesPasskeyRegistration` capability + single completion point | done |
| C8 | signCount + orphan documentation | done |

> Verify before locking C7: the iOS 17 `ASPasskeyRegistrationCredential` initializer (clientDataHash vs clientDataJSON).
> → VERIFIED (iOS 26.4 SDK header): `init(relyingParty:clientDataHash:credentialID:attestationObject:)` — takes `clientDataHash`; the OS owns clientDataJSON. `completeRegistrationRequest(using:completionHandler:)` exists since iOS 17.

## Implementation Checklist (C4–C8, Step 2-1)

Reuse obligations (existing shared assets — do NOT reimplement):
- [ ] `KeychainAccessor`/`SystemKeychainAccessor` (`Shared/Storage/BridgeKeyStore.swift:26`) — C5 store DI; tests use `FakeKeychain` (HostTokenStoreTests.swift:9) / `MockKeychainAccessor`
- [ ] `generateDPoPKey`/`loadDPoPKey`/`exportPublicKeyJWK`/`computeJWKThumbprint` (`Shared/Crypto/SecureEnclaveKey.swift`) — C4 key creation; access group is the DEFAULT keychain group (single `…shared` entitlement on both targets — explicit literal group fails with errSecMissingEntitlement on device, per BridgeKeyStore comment)
- [ ] `buildDPoPProof` (`Shared/Auth/DPoPProofBuilder.swift`) + `SecureEnclaveDPoPSigner` — C4 uploader signing
- [ ] `encryptAESGCMEncoded` + `buildPersonalEntryAAD` + `VaultType` (`Shared/Crypto/`) — C7 blob encryption (mirror `VaultViewModel.createEntry:189`)
- [ ] keyVersion recovery idiom: `max(1, first personal entry keyVersion ?? 1)` (`VaultUnlocker.unlockWithBiometrics:232`)
- [ ] entryId idiom: `UUID().uuidString.lowercased()` (`VaultViewModel.createEntry:197`)
- [ ] cache write protocol: write file at counter N+1 FIRST, `incrementCounter` after (`HostSyncService.runSync`)
- [ ] `passkeyRegistrationOutcome` (C3, shipped) — the ONLY completion gate in C7
- [ ] `PasskeyEntryBlobBuilder.buildCreate` / `buildRegistrationAuthData` / `buildNoneAttestationObject` / `generatePasskey` (C1/C2, shipped)
- [ ] `CredentialIdentityRegistrar` seam — extend protocol with append-style `add(passkeys:)` (replace() would drop other identities)
- [ ] `MockURLProtocol`/`FakeSigner`/`httpResponse` (MobileAPIClientTests.swift, top-level) — reusable by new test files
- [ ] ISO8601 expiresAt from server has fractional seconds (`.toISOString()`) → parse with `.withFractionalSeconds`

Files to add/modify:
- [ ] ADD `ios/Shared/Storage/UploadTokenStore.swift` (C5) + `ios/PasswdSSOTests/UploadTokenStoreTests.swift`
- [ ] ADD `ios/Shared/Auth/AutofillDPoPKey.swift` (C4 — label `com.passwd-sso.dpop.autofill`)
- [ ] ADD `ios/Shared/Network/EntryUploader.swift` (C4 — owns `CreateEntryRequest` MOVED from MobileAPIClient.swift; shared `canonicalHTU`/`sha256Base64URL` free functions) + `ios/PasswdSSOTests/EntryUploaderTests.swift` (port T5 ath test)
- [ ] MODIFY `ios/PasswdSSOApp/Network/MobileAPIClient.swift` (remove moved struct; delegate htu/ath helpers; add `mintAutofillToken`)
- [ ] ADD `ios/PasswdSSOApp/Auth/AutofillTokenRefresher.swift` (C6) + tests
- [ ] MODIFY `ios/PasswdSSOApp/Vault/AutoLockService.swift` (clear upload token on lock/signOut) + tests
- [ ] MODIFY `ios/PasswdSSOApp/Views/RootView.swift` + `PasswdSSOAppApp.swift` (mint after unlock/foreground sync)
- [ ] MODIFY `ios/Shared/AutoFill/CredentialResolver.swift` (C7: `encryptPasskeyEntry` + `appendEntryToCache`) + tests
- [ ] MODIFY `ios/Shared/AutoFill/CredentialIdentityRegistrar.swift` (append API) + tests
- [ ] MODIFY `ios/PasswdSSOAutofillExtension/CredentialProviderViewController.swift` (C7 flow + F5 guard reset)
- [ ] MODIFY `ios/project.yml` (`ProvidesPasskeyRegistration: true`) → `xcodegen generate`
- [ ] ADD `docs/archive/review/ios-passkey-registration-manual-test.md` (R35 Tier-2, adversarial scenarios per plan §Testing)
- [ ] C8 doc: signCount-from-0 + orphan note (extension README + manual-test)

CI gate parity: iOS CI (`.github/workflows`) runs xcodebuild test + xcodegen-regenerated project; server gates = vitest + next build (no server changes in C4–C8; run anyway as mandatory checks). No new-file-pattern CI gates detected for `ios/**.swift` beyond the xcodegen regeneration rule (project.yml is SSoT).
