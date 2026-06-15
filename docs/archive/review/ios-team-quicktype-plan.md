# Plan: iOS team-entry AutoFill + QuickType (team key pipeline)

## Project context

- **Type**: mixed repo; primarily iOS (Swift). **Plan originally assumed "no server change"** because the data
  contracts (`/api/vault/unlock/data` ECDH fields; `/api/teams/{teamId}/member-key`) already existed. **During
  implementation this proved false**: the proxy Bearer-bypass allowlist did not include `/api/teams`, so the
  iOS mobile token was rejected with 401 before reaching the (correctly authorizing) handler. A one-line proxy
  change was required — see the **Implementation deviations** section at the end. The change touches
  `src/lib/proxy/cors-gate.ts` (+ tests), so server proxy tests (`npx vitest run`) are now part of the gate.
- **Test infrastructure**: XCTest unit tests + CI (macos-latest, Xcode 16.4 / iOS 18 SDK). Tests expected.
  **No iOS 26-only APIs** (CI is iOS 18 SDK).
- **Security-critical**: this is cryptographic-material handling (account ECDH key, team keys). R35 **Tier-2** —
  a manual-test artifact with adversarial scenarios is required. Golden-vector tests are mandatory.
- **BridgeKeyStore(service:)** in tests must end with `"bridge-key"` (precondition aborts otherwise).

## Objective

Make TEAM password entries fillable on iOS — both as inline QuickType suggestions (host registrar) and via the
AutoFill picker (CredentialResolver). Today the team-key scaffolding exists (`WrappedTeamKey`, resolver team
path, 15-min staleness, "wrap under cacheKey") but **the pipeline that populates it was never built**:
`saveTeamKeys()` is called only in tests, so `loadTeamKeys()` always returns `[]` and team entries fill nowhere.

## Background — verified facts (file:line)

### Crypto recipe (mirror the browser extension exactly)
The extension (`extension/src/lib/crypto-team.ts`) is the source of truth. The chain to obtain a team
entry-decryption key:

1. **Unwrap account ECDH private key** (needs the vault **secretKey**):
   `ecdhWrappingKey = HKDF-SHA256(secretKey, salt=Data(count:32, zeros), info="passwd-sso-ecdh-v1", 32B)`
   (crypto-team.ts:192-210, `deriveEcdhWrappingKey`); then AES-256-GCM **decrypt** `encryptedEcdhPrivateKey`
   (IV `ecdhPrivateKeyIv`, tag `ecdhPrivateKeyAuthTag`) → **PKCS#8** private-key bytes
   (`unwrapEcdhPrivateKey`, crypto-team.ts:~218; `importEcdhPrivateKey` imports `"pkcs8"`, P-256, crypto-team.ts:169-178).
   The ECDH-privkey unwrap uses **no AAD** (confirm during impl).
2. **ECDH agree + derive team wrapping key** (per team member-key):
   `sharedBits = ECDH(memberPrivateKey, ephemeralPublicKey)` (raw X-coord, 32B; WebCrypto `deriveBits` 256 ==
   CryptoKit `SharedSecret` raw); `teamWrappingKey = HKDF-SHA256(sharedBits, salt=hexDecode(hkdfSalt),
   info="passwd-sso-team-v1", 32B)` (crypto-team.ts:265, `deriveTeamWrappingKey`).
3. **Decrypt the wrapped team key** with AAD:
   `rawTeamKey = AES-256-GCM.decrypt(encryptedTeamKey, teamKeyIv, teamKeyAuthTag, teamWrappingKey,
   aad=buildTeamKeyWrapAAD{teamId,toUserId,keyVersion,wrapVersion})` (`unwrapTeamKey`, crypto-team.ts:280-317).
   AAD scope is `"OK"`, 4 fields (crypto-team.ts:145-152).
4. **Derive the team ENCRYPTION key** (the value entries are actually encrypted under):
   `teamEncKey = HKDF-SHA256(rawTeamKey, salt=Data(count:32, zeros), info="passwd-sso-team-enc-v1", 32B)`
   (`deriveTeamEncryptionKey`, crypto-team.ts:325-348).

### iOS resolver consumes the DERIVED enc key directly (critical)
`CredentialResolver` (the consumer) does **not** apply the team-enc HKDF: `decryptTeamKey` unwraps the stored
`WrappedTeamKey` under cacheKey and uses the result **directly** as the entry key (itemKeyVersion==0) or to
unwrap the per-entry ItemKey (itemKeyVersion>=1) — `CredentialResolver.swift:756-771` (decryptTeamKey),
`:721-752` (resolveTeamEntryKey). The extension reaches the same point only after `deriveTeamEncryptionKey`.
**Therefore the host MUST store the step-4 `teamEncKey` (not the raw step-3 team key) in `WrappedTeamKey`** so
the resolver/registrar decrypt correctly. End-to-end golden vectors must prove this.

### Server contracts (no change)
- `GET /api/vault/unlock/data` returns (among others) `ecdhPublicKey`, `encryptedEcdhPrivateKey`,
  `ecdhPrivateKeyIv`, `ecdhPrivateKeyAuthTag` (all may be null for accounts without an ECDH keypair)
  (`src/app/api/vault/unlock/data/route.ts:114-135`; model `prisma/schema.prisma:142-146`).
- `GET /api/teams/{teamId}/member-key` returns `{encryptedTeamKey, teamKeyIv, teamKeyAuthTag,
  ephemeralPublicKey, hkdfSalt, keyVersion, wrapVersion}` (route.ts GET; model `schema.prisma:662-681`).
  Requires `EXTENSION_TOKEN_SCOPE.PASSWORDS_READ` — the iOS mobile token already reads team entries via
  `/api/teams/{teamId}/passwords` (same scope), so it is authorized; **verify during impl**. Error envelopes:
  `KEY_NOT_DISTRIBUTED`, `MEMBER_KEY_NOT_FOUND`.

### Key lifecycle seam (where each step runs)
- **secretKey** is in scope ONLY during passphrase unlock (`VaultUnlocker.swift:130-147`), discarded after
  deriving vaultKey. Biometric/offline unlock has **no** secretKey (`VaultUnlocker.swift:186-242`).
- **cacheKey** = `deriveCacheVaultKey(bridgeKey:)` — derived from bridge_key (no passphrase), available to host
  AND extension at any time the bridge_key is readable.
- **Sync** (`HostSyncService.performSync`, foreground + background via `BackgroundSyncCoordinator`) has vaultKey
  + readable bridge_key, but **NOT** secretKey.
- **Design A (chosen)**: persist the unwrapped ECDH private key **re-wrapped under cacheKey** at passphrase
  unlock (when secretKey exists), mirroring `WrappedVaultKey`. Then sync (incl. background, incl. after
  biometric unlock) loads + unwraps it with cacheKey, fetches team member-keys, derives team enc keys, and
  writes `WrappedTeamKey` blobs (wrapped under cacheKey) every sync. The 15-min staleness self-refreshes.
  Design B (derive team keys only at passphrase unlock) is rejected: team keys would expire 15 min post-unlock
  with no way to refresh in background.

## Requirements

- Functional: team entries appear as QuickType suggestions AND are fillable via the picker, biometric-gated,
  offline (from cache), matching personal-entry behavior. Personal-only behavior unchanged.
- Crypto: byte-for-byte compatible with the extension's team-key crypto (golden vectors prove it).
- Resilience: accounts without an ECDH keypair, teams without a distributed key, or background sync without a
  persisted ECDH key MUST degrade gracefully (personal sync/fill keeps working; team entries simply absent).
- Security: ECDH private key and team enc keys are persisted only **wrapped under cacheKey** (same protection
  level as the already-persisted vaultKey). No plaintext key material persisted. Cleared on sign-out.

## Technical approach

Mirror the extension crypto in a new `Shared/Crypto/TeamKeyCrypto.swift` using CryptoKit
(`P256.KeyAgreement`, `HKDF<SHA256>`, existing `AESGCM`/`AAD`/`hex`). Persist the ECDH private key via a new
`WrappedECDHPrivateKey` in `WrappedKeyStore` (mirrors `WrappedVaultKey`). Populate `WrappedTeamKey` blobs in
`HostSyncService`. Extend `CredentialIdentityRegistrar` to register team entries (it already has all the
decrypt building blocks in `CredentialResolver` — factor the shared team-decrypt helper to avoid duplication,
R1).

## Contracts

### C1 — `VaultUnlockData` gains optional ECDH fields
- **Location**: `ios/PasswdSSOApp/Network/MobileAPIClient.swift` (`VaultUnlockData`, ~lines 7-58; CodingKeys).
- **Add (all `String?`, optional — may be null server-side)**: `ecdhPublicKey`, `encryptedEcdhPrivateKey`,
  `ecdhPrivateKeyIv`, `ecdhPrivateKeyAuthTag`.
- **F6**: the struct has an **explicit `CodingKeys` enum** — the 4 new fields MUST be added there too, else the
  decoder silently skips them → always `nil` → ECDH key never persisted. Wire names are snake-less camelCase
  matching the server JSON (`ecdhPublicKey`, `encryptedEcdhPrivateKey`, `ecdhPrivateKeyIv`,
  `ecdhPrivateKeyAuthTag` — confirm exact casing against `src/app/api/vault/unlock/data/route.ts`).
- **Invariant**: decode tolerates absence (no team support for that account) — never throws on missing fields.
- **Acceptance**: unlock-data JSON with and without the ECDH fields both decode; a fixture WITH the fields
  populated round-trips into non-nil properties (guards the CodingKeys wiring).

### C2 — team-key-wrap AAD + local-wrap AAD on iOS
- **Location**: `ios/Shared/Crypto/AAD.swift`.
- **Add (server-compat, mirrors extension)**: `case teamKey = "OK"` to `AADScope`;
  `public func buildTeamKeyWrapAAD(teamId:toUserId:keyVersion:wrapVersion:) throws -> Data`
  = `buildAADBytes(scope: .teamKey, fields: [teamId, toUserId, String(keyVersion), String(wrapVersion)])`.
  Byte-identical to extension `buildTeamKeyWrapAAD` (scope `"OK"`, aadVersion 1, 4 length-prefixed fields).
- **Add (iOS-local, NEW — S1/S2 blob-binding)**: `case localWrap = "LW"`;
  `public func buildLocalWrapAAD(kind: String, userId: String, teamId: String = "") throws -> Data`
  = `buildAADBytes(scope: .localWrap, fields: [kind, userId, teamId])`. Used ONLY for the on-device cacheKey
  wraps introduced by this plan (`kind` ∈ {`"ecdh"`, `"team"`}). This binds each persisted blob to the user
  (and team) it was derived for, so a blob transplanted from another user/team fails AEAD. It is **not** shared
  with the server/extension (purely an iOS-internal integrity binding). The pre-existing `WrappedVaultKey`
  remains AAD-less (out of scope; same threat model as today).
- **Invariant**: `"OK"` AAD byte-identical to the extension; `"LW"` AAD is consumed symmetrically by the host
  writer (C5/C7) and the on-device reader (`CredentialResolver.decryptTeamKey`, C8) — same `kind`/`userId`/`teamId`.
- **Acceptance**: a golden-vector test asserts the **full byte sequence** (not just header bytes — follow
  `AADParityTests` pattern) for the `"OK"` AAD against the extension output, and for the `"LW"` AAD against a
  hand-computed known-good sequence (T3).

### C3 — `Shared/Crypto/TeamKeyCrypto.swift` (new) — the crypto mirror
- **Functions** (pure, `nonisolated`, throwing):
  - `deriveEcdhWrappingKey(secretKey: SymmetricKey) -> SymmetricKey` — HKDF(secretKey, salt=32 zero bytes,
    info `"passwd-sso-ecdh-v1"`, 32B). (NB: the extension JSDoc says "salt=empty" but the code uses
    `new ArrayBuffer(32)` = 32 zero bytes — follow the code; same for `deriveTeamEncryptionKey`.)
  - `unwrapEcdhPrivateKey(encrypted: EncryptedData, wrappingKey: SymmetricKey) -> P256.KeyAgreement.PrivateKey`
    — AES-GCM decrypt (no AAD) → PKCS#8 bytes → import → return the **key directly**. The intermediate PKCS#8
    `Data` is **zeroized** in a `defer` before returning (S9 — mirrors `VaultUnlocker.zeroData`), so the caller
    never holds raw private-key bytes.
  - **import detail** (internal to the above): use `P256.KeyAgreement.PrivateKey(derRepresentation:)` — **NOTE
    (F15): `pkcs8DERRepresentation` does NOT exist on CryptoKit's P256 key types; the correct API is
    `derRepresentation`**, which for a private key emits/accepts PKCS#8 `PrivateKeyInfo` DER (verified against
    the iOS SDK: bytes begin `30 81 87 02 01 00 30 13…`). WebCrypto exports PKCS#8 (`importEcdhPrivateKey` uses
    `"pkcs8"`, crypto-team.ts:173), so `derRepresentation` is format-compatible with the wrapped bytes. **F10**:
    no expected fallback; if `init(derRepresentation:)` throws on the real bytes, parse the 32-byte private
    scalar out of the PKCS#8 and use `init(rawRepresentation:)`. The golden vector (C9) pins which path the real
    bytes take — do not ship the fallback unless the vector proves it is needed.
  - `importEphemeralPublicKey(jwk: String) -> P256.KeyAgreement.PublicKey` — parse `{kty,crv,x,y}`; **validate
    `kty == "EC"` and `crv == "P-256"`** before use, throwing `TeamKeyCryptoError.unsupportedKeyType` otherwise
    (S6); base64url-decode x/y (32B each) → `P256.KeyAgreement.PublicKey(x963Representation: 0x04‖x‖y)`.
  - `unwrapTeamKey(encrypted:EncryptedData, ephemeralPublicKeyJWK:String, memberPrivateKey:P256.KeyAgreement.PrivateKey, hkdfSalt:String, teamId:String, toUserId:String, keyVersion:Int, wrapVersion:Int) -> SymmetricKey`
    — ECDH `sharedSecret(with:)` → raw bytes → HKDF(salt=hexDecode(hkdfSalt), info `"passwd-sso-team-v1"`, 32B) →
    AES-GCM decrypt with `buildTeamKeyWrapAAD` → **rawTeamKey**.
  - `deriveTeamEncryptionKey(rawTeamKey: SymmetricKey) -> SymmetricKey` — HKDF(rawTeamKey, salt=32 zero bytes,
    info `"passwd-sso-team-enc-v1"`, 32B). **This is the value stored in `WrappedTeamKey`** (per the resolver
    consumption fact above).
- **Invariant**: ECDH shared secret uses the raw X-coordinate (SEC1 Z), matching WebCrypto `deriveBits`. HKDF
  salts/infos exactly as above. No AAD on ECDH-privkey unwrap; AAD `"OK"`/4-field on team-key unwrap.
- **Forbidden patterns**:
  - `pattern: SharedSecret.*hkdfDerivedSymmetricKey` — reason: must feed raw shared bytes to the project HKDF to
    match the extension's two-step (deriveBits → HKDF) exactly; CryptoKit's combined helper uses a different
    construction.
- **Acceptance (golden vectors, mandatory)**: with fixtures captured from the extension's own functions
  (known secretKey, encryptedEcdhPrivateKey, member-key blob, a team entry overview), iOS reproduces: (a) the
  unwrapped PKCS#8 privkey bytes, (b) the rawTeamKey, (c) the teamEncKey, (d) a decrypted team entry overview
  identical to the extension's. Consumer-flow: the produced teamEncKey, when stored as `WrappedTeamKey` and fed
  to `CredentialResolver`/registrar, decrypts a real team entry overview (full round-trip golden vector).

### C4 — `WrappedECDHPrivateKey` persistence
- **Location**: `ios/Shared/Storage/WrappedKeyStore.swift`.
- **Add**: `WrappedECDHPrivateKey` struct (ciphertext/iv/authTag: Data) mirroring `WrappedVaultKey`;
  protocol `saveECDHPrivateKey(_:)` / `loadECDHPrivateKey() -> WrappedECDHPrivateKey?`; a `clearTeamKeys()`
  protocol method (S11 — used by C7's stale-branch); a private `ecdhPrivateKeyURL()` path helper; and **delete
  the ECDH path in `clearAll()`** (S4/S10 — sign-out must wipe it). Persisted as
  `vault/wrapped-ecdh-private-key.json` (App Group, atomic write).
- **Stored value**: the PKCS#8 ECDH private-key bytes AES-GCM-encrypted under **cacheKey with AAD =
  `buildLocalWrapAAD(kind:"ecdh", userId:)`** (S1).
- **Mock update obligation (T4/F14/S11)**: the `WrappedKeyStore` protocol gains 3 methods
  (`saveECDHPrivateKey`, `loadECDHPrivateKey`, `clearTeamKeys`) → EVERY conformer must be updated in the SAME
  change or the test target fails to compile: `MockWrappedKeyStore`
  (`PasswdSSOTests/CredentialResolverTests.swift:18-37`), `TempDirWrappedKeyStore`
  (`WrappedKeyStoreTests.swift:~147`), and any other conformer (grep `: WrappedKeyStore`). Add in-memory ECDH
  storage; `clearTeamKeys()` resets the in-memory team-key array to `[]`; `clearAll()` resets ECDH + team-key
  in-memory state to nil/[] (not just file paths) so `HostSyncServiceTests` (T10) observe the clear.
- **Invariant (R25 persist/hydrate)**: cleared by `clearAll()` (sign-out) alongside vault/team keys; stored only
  wrapped under cacheKey (with userId AAD).
- **Acceptance**: round-trip save/load; **`clearAll()` removes the file (mandatory pre-merge test gate, not just
  a nice-to-have)** — the test seeds an ECDH blob then asserts `loadECDHPrivateKey() == nil` after `clearAll()`.

### C5 — persist ECDH key at passphrase unlock
- **Location**: `ios/PasswdSSOApp/Vault/VaultUnlocker.swift` (passphrase path, where `secretKey` + `cacheKey` are
  in scope, ~line 130-160).
- **Behavior**: if `unlockData` carries the ECDH fields → `deriveEcdhWrappingKey(secretKey)` →
  `unwrapEcdhPrivateKey` (returns the imported key; re-export its PKCS#8 via
  `privateKey.derRepresentation` for re-wrapping — F15: `derRepresentation`, not `pkcs8DERRepresentation`) → re-encrypt those PKCS#8 bytes under **cacheKey with AAD
  `buildLocalWrapAAD(kind:"ecdh", userId:)`** (S1) → `wrappedKeyStore.saveECDHPrivateKey(...)`, zeroizing the
  re-export bytes after. If fields absent or unwrap fails → skip (log, non-fatal).
- **Biometric path**: no secretKey → no-op (relies on the ECDH key persisted at the last passphrase unlock).
- **Invariant**: `UnlockResult` shape unchanged; failure here never blocks unlock (personal vault must still
  open).
- **Acceptance**: after passphrase unlock with ECDH fields, `loadECDHPrivateKey()` returns a blob that unwraps
  (under cacheKey) to the same PKCS#8 bytes; absent fields → no blob, unlock still succeeds.

### C6 — `MobileAPIClient.fetchTeamMemberKey`
- **Location**: `ios/PasswdSSOApp/Network/MobileAPIClient.swift`.
- **Signature**: `func fetchTeamMemberKey(teamId: String) async throws -> TeamMemberKeyResponse` — GET
  `/api/teams/{teamId}/member-key` (DPoP, existing auth ladder).
- **`TeamMemberKeyResponse: Decodable`**: `encryptedTeamKey, teamKeyIv, teamKeyAuthTag, ephemeralPublicKey,
  hkdfSalt: String; keyVersion, wrapVersion: Int`.
- **Invariant**: a `KEY_NOT_DISTRIBUTED` / `MEMBER_KEY_NOT_FOUND` / 404 surfaces as a **named typed error**
  `MobileAPIError.teamKeyNotDistributed` (T8) that the caller treats as "skip this team" (not a hard sync
  failure). Map both the 403/404 status and the error-code body to this case (reuse the C-quota body-envelope
  decode pattern from the shipped `decodeBodyResponse`).
- **Acceptance**: 200 decodes into `TeamMemberKeyResponse`; `KEY_NOT_DISTRIBUTED` / `MEMBER_KEY_NOT_FOUND` /
  bare 404 → `MobileAPIError.teamKeyNotDistributed`.

### C7 — `HostSyncService` populates `WrappedTeamKey`
- **Location**: `ios/PasswdSSOApp/Vault/HostSyncService.swift` (`performSync`).
- **Behavior**: derive `cacheKey = deriveCacheVaultKey(bridgeKey: blob.bridgeKey)`; load+unwrap the persisted
  ECDH private key (under cacheKey, AAD `buildLocalWrapAAD(kind:"ecdh", userId:)`) → import. For each team
  membership: `fetchTeamMemberKey` → `unwrapTeamKey` → `deriveTeamEncryptionKey` → AES-GCM encrypt that key
  under **cacheKey with AAD `buildLocalWrapAAD(kind:"team", userId:, teamId:)`** (S2) →
  `WrappedTeamKey(teamId:, ciphertext:, iv:, authTag:, issuedAt: now(), teamKeyVersion: resp.keyVersion)`.
  Collect all → `wrappedKeyStore.saveTeamKeys(blobs)` (one write; overwrites the previous set so revoked/
  key-not-distributed teams drop out).
- **Resilience**:
  - ECDH key **available** → always rewrite the FULL set (a team that now returns
    `teamKeyNotDistributed` simply isn't in the new array → revocation drops it). Per-team fetch/unwrap failure →
    skip that team, continue others.
  - ECDH key **unavailable** (e.g. background sync before any passphrase unlock) → do NOT blow away a possibly
    still-valid set, BUT avoid keeping revoked keys forever: if **all** existing `WrappedTeamKey` blobs are
    already older than the 15-min staleness window, clear them via `wrappedKeyStore.clearTeamKeys()` (S11 — a
    dedicated protocol method, NOT a direct file delete, so mocks capture it); otherwise leave the set untouched
    (F3/S3). Never call `saveTeamKeys([])` as a "skip" — that would wipe a valid set (T10).
- **Clock**: `issuedAt` and the staleness comparison use the injected clock (testable).
- **Invariant**: personal sync path and its cache write are unchanged; team-key population is additive and
  best-effort. `issuedAt` uses the injected clock (testable).
- **Consumer-flow walkthrough**:
  - `CredentialResolver.resolveCandidates` (extension) reads `loadTeamKeys()` → `decryptTeamKey(cacheKey:)` →
    uses the key directly (itemKeyVersion==0) or unwraps ItemKey (>=1). It needs: `teamId` (lookup), `issuedAt`
    (staleness), `ciphertext/iv/authTag` (the cacheKey-wrapped **teamEncKey**), `teamKeyVersion`. All provided. ✔
  - `CredentialIdentityRegistrar` (C8) reads the same set the same way. ✔
- **Acceptance**: after a sync with a team membership + distributed key, `loadTeamKeys()` returns a blob whose
  cacheKey-unwrap → resolver decrypts the team entry overview (golden round-trip).

### C8 — `CredentialIdentityRegistrar` registers team entries (+ shared helper, + AAD consumer change)
- **R1 shared helper**: extract the team-decrypt logic into a single new type
  `ios/Shared/AutoFill/TeamEntryDecryptor.swift` exposing e.g.
  `decryptTeamSummary(entry: CacheEntry, teamKeys: [WrappedTeamKey], cacheKey: SymmetricKey, userId: String, now: () -> Date) -> VaultEntrySummary?`
  — it does: team-key lookup by `teamId`, 15-min staleness (`teamKeyMaxAge`), `decryptTeamKey` (now AAD-aware),
  `resolveTeamEntryKey`, overview decrypt (team-entry AAD). **Both** `CredentialResolver` and the registrar call
  it (do NOT duplicate). `CredentialResolver`'s existing inline team path is refactored to use it.
- **AAD consumer change (S2)**: `decryptTeamKey` must now pass `buildLocalWrapAAD(kind:"team", userId:, teamId:)`
  to `decryptAESGCM` (matching the host write in C7). Signature gains `userId` + uses `wrapped.teamId`. This
  changes existing `CredentialResolver.decryptTeamKey` (safe — the team path was never exercised in production
  since `saveTeamKeys` was test-only).
- **AAD symmetry enforcement (F16/F17/S12)**: to guarantee the host writer (C7) and the on-device reader use the
  identical AAD, both wrap and unwrap of the team enc key go through **one shared pair** on `TeamEntryDecryptor`
  (or a sibling `LocalKeyWrap` helper): `wrapTeamKey(teamEncKey, cacheKey, userId, teamId) -> WrappedTeamKey`
  and `unwrapTeamKey(WrappedTeamKey, cacheKey, userId) -> SymmetricKey`. `HostSyncService` calls the wrap
  helper; the resolver/registrar call the unwrap helper. **F16**: the `userId` passed on BOTH sides MUST be
  `cacheData.header.userId` (the value the host wrote at sync time) — never a session-layer userId sourced
  independently. At `CredentialResolver` call sites (resolveCandidates ~199, decryptEntryDetail ~327) `userId`
  is already bound from `cacheData.header.userId` — pass that. **S12**: the unwrap helper asserts
  `wrapped.teamId == lookupTeamId` (debug assert) so a lookup-key logic bug surfaces directly rather than as an
  opaque AEAD failure. The same shared-pair pattern applies to the ECDH key (`wrapEcdhKey`/`unwrapEcdhKey` with
  `kind:"ecdh"` AAD) so C5's write and C7's read agree.
- **Registrar behavior** (`CredentialIdentityRegistrar.swift`): `decryptPersonalOverviews` /
  `buildPasskeyIdentitySpecs` currently skip `where entry.teamId == nil`. Add a team branch that calls
  `TeamEntryDecryptor` for `entry.teamId != nil` entries and includes them with `teamId: entry.teamId`.
- **Call-site cacheKey provisioning (F2/F4/R3)** — `refreshCredentialIdentities(...)` gains `cacheKey:
  SymmetricKey?` and `wrappedKeyStore:`. Each caller supplies cacheKey by `deriveCacheVaultKey(bridgeKey:)` from
  a `BridgeKeyStore.readDirect()`:
  - `RootView.swift:~318` (handleVaultUnlocked) and `:~413` (debug) — bridge_key readable post-unlock; derive there.
  - `PasswdSSOAppApp.swift:~92` (foreground `.active` sync) — **`BackgroundSyncContext` must gain a
    `BridgeKeyStore` reference** (or store the derived cacheKey at unlock) so this site can pass it.
  - `VaultViewModel.swift:~227` and `:~285` — `VaultViewModel` has no bridge access today; **inject `cacheKey:
    SymmetricKey?` into the relevant methods (or the VM)** from the view layer that already holds it. When
    cacheKey is `nil`, the registrar falls back to personal-only (no crash).
- **Background QuickType (F13)** — decide + document: `BackgroundSyncTask` currently does NOT call
  `refreshCredentialIdentities` after `runSync`. To make team entries appear in QuickType after a background
  refresh (User scenario 1), add a `refreshCredentialIdentities` call (with cacheKey from bridge_key) at the end
  of the background sync path. If deferred, the plan MUST state "team QuickType updates only on next foreground"
  — but since the scenario explicitly promises background appearance, **wire it in background**.
- **Invariant**: personal registration unchanged when cacheKey is nil or no team keys present; team entries
  register only when a fresh (<15 min) team key exists.
- **Acceptance**: with team keys present + cacheKey passed, team entries appear in the registered identity set;
  cacheKey nil OR no team keys → only personal (no regression). `TeamEntryDecryptor` is the single decrypt path
  (grep: no duplicated team-decrypt logic remains in `CredentialResolver`).

### C9 — tests + manual-test artifact
- **Golden-vector capture (MANDATORY deliverable, T1/T2/T11/T12)**: a one-time capture script
  `scripts/generate-team-key-fixture.ts` run via the repo-root `tsx` (add an npm script
  `"generate:team-key-fixture": "tsx scripts/generate-team-key-fixture.ts"`) — **`.ts` not `.mjs`**, so it
  `import`s the **extension's actual** `extension/src/lib/crypto-team.ts` (T11: a `.mjs` cannot import the `.ts`
  source and would silently inline a drifting copy). `crypto-team.ts` uses only `globalThis.crypto.subtle`
  (Node 20+ native) — no browser globals — so it runs under tsx. The DECRYPT side exercises the real extension
  functions (`unwrapEcdhPrivateKey`, `unwrapTeamKey`, `deriveTeamEncryptionKey`); the ENCRYPT side (producing
  `encryptedEcdhPrivateKey`/`encryptedTeamKey` fixtures) uses raw Web Crypto and MUST match the server's stored
  layout — `ciphertext || authTag` with the 16-byte tag split off into a separate hex field, IV separate (T12).
  Emits `ios/PasswdSSOTests/fixtures/team-key-fixture.json` containing: `secretKey`,
  `pkcs8PrivKeyHex`, `ephemeralPublicKeyJWK`, `hkdfSalt`, `encryptedEcdhPrivateKey{ct,iv,tag}`,
  `encryptedTeamKey{ct,iv,tag}`, `teamId/toUserId/keyVersion/wrapVersion`, `rawTeamKeyHex`, `teamEncKeyHex`, and
  a sample `encryptedOverview{...}` produced under the teamEncKey. The fixture is bundled in the test target via
  the same bundle-search pattern as `VaultUnlockerTests.testUnlockDecodesWebGeneratedFixture`
  (`VaultUnlockerTests.swift:~421`). **Forbidden**: fixtures produced by running the iOS implementation itself —
  every golden vector loads the external fixture and asserts iOS-output == the EXTENSION's captured hex (a
  test that calls `TeamKeyCrypto.*` to produce both expected and actual is a vacuous self-check and must be
  rejected). Document capture provenance in the test header.
- **`TeamKeyCryptoTests`** (golden vectors against the fixture): (a) `unwrapEcdhPrivateKey` →
  `pkcs8DERRepresentation` equals `pkcs8PrivKeyHex`; (b) `unwrapTeamKey` raw == `rawTeamKeyHex`; (c)
  `deriveTeamEncryptionKey` == `teamEncKeyHex`; (d) decrypt the sample `encryptedOverview` under the derived key
  → expected overview. **Negative tests (S5)**: tampered team-key ciphertext (flip 1 byte) → throws; wrong-AAD
  (different teamId/userId) → throws; non-EC/`P-384` JWK → `unsupportedKeyType`. **T13**: these targets are
  `async throws` — use the `do { _ = try await …; XCTFail("expected throw") } catch { }` pattern, NOT
  `XCTAssertThrowsError` (its closure is synchronous and silently passes an un-awaited async call → vacuous).
- **`AADParityTests`** (C2, full-byte — T3): `buildTeamKeyWrapAAD` exact bytes == extension fixture (or
  hand-computed); `buildLocalWrapAAD(kind:"team",userId:,teamId:)` and `(kind:"ecdh",userId:)` exact bytes vs
  hand-computed known-good sequences. Header-only assertions are insufficient.
- **`WrappedKeyStoreTests`** (T4): ECDH key round-trip; `clearAll()` removes the ECDH file (mandatory gate);
  `TempDirWrappedKeyStore` gains the new methods.
- **`VaultUnlockerTests`** (T5): add `makeVaultUnlockDataWithECDH(...)` builder that generates a real
  `P256.KeyAgreement.PrivateKey`, exports PKCS#8, encrypts under the HKDF-derived ecdhWrappingKey, and populates
  the fields. Tests: passphrase unlock with ECDH fields → `loadECDHPrivateKey()` non-nil and unwraps (under
  cacheKey + ecdh AAD) to the same PKCS#8; absent fields → no blob, unlock still succeeds; biometric path → no-op.
- **`MobileAPIClientTests`** (T8): `fetchTeamMemberKey` 200 → `TeamMemberKeyResponse` decode (real JSON body,
  `seedAccessToken()`); `KEY_NOT_DISTRIBUTED` / `MEMBER_KEY_NOT_FOUND` / bare 404 →
  `MobileAPIError.teamKeyNotDistributed`.
- **`HostSyncServiceTests`** (T6/T10): with `MockURLProtocol` stubbing `/member-key` + a `MockWrappedKeyStore`
  seeded with the ECDH blob (wrapped under cacheKey), `performSync` writes a `WrappedTeamKey` whose cacheKey+AAD
  unwrap == the fixture `teamEncKeyHex`; **no ECDH key + non-empty fresh team-key set → set unchanged** (assert
  count unchanged, NOT `[]`); no ECDH key + all-stale set → cleared; per-team `teamKeyNotDistributed` → that team
  absent, others written.
- **`CredentialIdentityRegistrarTests`** (T7): seed `MockWrappedKeyStore` with a team key (wrapped under cacheKey
  via the fixture), pass `cacheKey`, assert the team entry's host appears in the replaced specs; cacheKey nil OR
  no team keys → personal-only. Move/share the `makeTeamCacheEntry` helper (currently in CredentialResolverTests)
  to a shared test helper.
- **`TeamEntryDecryptor`** is covered transitively by the resolver + registrar tests; add a focused round-trip
  test using the fixture.
- **Manual-test** (`ios-team-quicktype-manual-test.md`, R35 Tier-2): Pre-conditions (a team with a distributed
  key, a member account on device), Steps (passphrase unlock → background → AutoFill a team-site login),
  Expected (team entry appears in QuickType + fills, biometric-gated), Rollback. **Adversarial scenarios (T9 —
  pick the ones NOT already unit-covered)**: (1) revoked membership → team entries stop filling within ≤15 min;
  (2) **sign-out wipes** `vault/wrapped-ecdh-private-key.json` + team keys (verify via debugger); (3) **clock-skew**:
  set device clock back 30 min → stale team keys do NOT re-appear; (4) cross-tenant/unauthorized teamId yields no
  key. (Tampered-AEAD is already a unit test — omit from manual.)

## Testing strategy

Unit + golden vectors per C9. `xcodegen generate` → `build-for-testing` + `test-without-building` on simulator
(iOS 26.1 local OK), full suite green, no crashes. Golden vectors are the primary correctness gate; capture
fixtures by running the extension's `crypto-team.ts` functions on fixed inputs (document the capture method in
the test file header).

## Considerations & constraints

- **Out of scope**: team entry **create/edit** on iOS (read/fill only); team key **rotation** UI; changing the
  15-min staleness window; any server change; team passkeys.
- **R1 reuse**: the team-decrypt helper MUST be shared between `CredentialResolver` and the registrar.
- **R25**: ECDH key + team keys are persisted state crossing the process boundary (host writes, AutoFill ext
  reads) — both persist and hydrate paths covered; `clearAll()` wipes on sign-out (security downgrade guard).
- **Background sync**: degrades gracefully without a persisted ECDH key; never clears a possibly-valid team-key
  set when it cannot refresh.
- **Token scope**: confirm the iOS mobile token passes `PASSWORDS_READ` on `/member-key` (same scope as the
  already-working team-entries fetch).
- **PKCS#8 import risk**: `P256.KeyAgreement.PrivateKey(pkcs8DERRepresentation:)` must accept WebCrypto's pkcs8
  export — pinned by golden vector; if it rejects, parse the 32-byte scalar from the PKCS#8 and use
  `init(rawRepresentation:)`.

## User operation scenarios

1. Member of a team unlocks with passphrase → app persists the ECDH key → next sync fetches team member-keys and
   writes team keys → user backgrounds the app → on a team-site login form, the team credential appears as a
   QuickType suggestion and fills after Face ID.
2. Account with no ECDH keypair / not on any team → unlock + sync + personal fill all work unchanged; no team
   entries (no errors).
3. Membership revoked → within ≤15 min the stale team key is refused; team entries stop filling.
4. Background sync while only biometric-unlocked → uses the persisted ECDH key to refresh team keys.

### C10 — in-app team display + vault switcher (UX: "separate vault" emphasis)
Added after user UX review: AutoFill alone is a confusing half-state (team creds fill in AutoFill but are
invisible in-app). The app must SHOW team entries in-app AND clearly separate the team vault from the personal
vault via a top **vault switcher** (segmented control: 個人 / チームA / チームB…), scoping the whole view
(category grid + list) to the selected vault.
- **C10a — VaultViewModel team decrypt**: `loadFromCache` gains `cacheKey: SymmetricKey?` (+ a `WrappedKeyStore`,
  default `AppGroupWrappedKeyStore()`). For `entry.teamId != nil` entries, decrypt via
  `TeamEntryDecryptor.decryptTeamSummary` (team keys + cacheKey); personal entries unchanged (vaultKey). When
  cacheKey/team keys absent → team entries simply omitted (no regression for personal-only users).
- **C10b — team directory persistence**: team names (`TeamMembership.name`, already fetched) must survive cold
  load for the switcher labels. `HostSyncService` persists a `[TeamDirectoryEntry{id,name}]` encrypted under
  cacheKey (AAD `buildLocalWrapAAD(kind:"teamdir", userId:)`) via a new `TeamDirectoryStore` (App Group file
  `vault/team-directory.json`); cleared in `clearAll()`/sign-out. VaultViewModel loads + decrypts it for labels.
- **C10c — vault switcher UI** (`VaultListView`): a `VaultScope` state (`.personal` | `.team(teamId)`); a
  segmented `Picker` shown ONLY when ≥1 team exists (personal-only users see no change). `filteredSummaries`
  filters by scope: `.personal` → `teamId == nil`; `.team(id)` → `teamId == id`. The category grid counts +
  drill-down operate within the selected scope. The Create (+) button is hidden under a team scope (team create
  unsupported — existing `teamEditNotSupported` guard remains the backstop).
- **i18n**: new key "Personal" (個人) for the switcher's personal segment; team segments use dynamic names (not
  localized). No internal jargon (R37).
- **Acceptance**: with team keys + directory present, the switcher lists 個人 + each team; switching scopes the
  grid/list; team entries appear only under their team; personal-only users see no switcher and unchanged UI.
  Tests: VaultViewModel decrypts team entries with cacheKey (fixture-backed); scope filtering; switcher hidden
  when no teams.

## Go/No-Go Gate

| ID  | Subject                                                              | Status |
|-----|---------------------------------------------------------------------|--------|
| C1  | `VaultUnlockData` optional ECDH fields                              | locked |
| C2  | team-key-wrap AAD (`"OK"`, 4-field) on iOS                          | locked |
| C3  | `TeamKeyCrypto.swift` crypto mirror + golden vectors               | locked |
| C4  | `WrappedECDHPrivateKey` persistence (+ clearAll)                    | locked |
| C5  | persist ECDH key at passphrase unlock (biometric no-op)            | locked |
| C6  | `MobileAPIClient.fetchTeamMemberKey` + typed skip errors           | locked |
| C7  | `HostSyncService` populates `WrappedTeamKey` (resilient)           | locked |
| C8  | `CredentialIdentityRegistrar` team registration (shared helper)    | locked |
| C9  | tests (golden vectors) + Tier-2 manual-test artifact               | locked |

## Implementation deviations (recorded post-implementation)

Three issues surfaced during implementation that the locked plan (C1–C10) did not anticipate. All were fixed in
this branch; recorded here so the plan reflects shipped reality. Each is a correctness/security fix, not a scope
change.

### D1 — proxy Bearer-bypass allowlist missing `/api/teams` (server change — contradicts "no server change")

- **Symptom**: the iOS mobile (extension) token could fetch `/api/passwords` and `/api/vault/unlock/data` but
  every `/api/teams/*` request (team list, per-team passwords, `/member-key`) returned **401 at the proxy** —
  before the route handler ran. Team fill was therefore impossible end-to-end, independent of the crypto.
- **Root cause**: `EXTENSION_TOKEN_ROUTES` in `src/lib/proxy/cors-gate.ts` lacked `API_PATH.TEAMS`. The proxy
  validates a session cookie for non-allowlisted routes; a cookieless Bearer request to `/api/teams` never
  reached the handler's `checkAuth` + `requireTeamPermission`.
- **Fix**: add `API_PATH.TEAMS` to `EXTENSION_TOKEN_ROUTES` (child paths allowed via the existing
  `startsWith(route + "/")` rule, so `/api/teams/{id}/member-key` and `/api/teams/{id}/passwords` are covered).
  Authorization is unchanged and still enforced in the handlers (scope + `requireTeamPermission`); the proxy only
  stops pre-rejecting the request. Covered by `cors-gate.test.ts` + `api-route.test.ts` updates.
- **Security note**: this widens the proxy Bearer-bypass surface to the entire `/api/teams/*` tree. The handlers
  already gate every team route on token scope and team membership, so no authorization is delegated to the
  proxy — but this is a security-boundary change and is the primary focus of the Phase-3 security review.

### D2 — item-encryption HKDF missing for `itemKeyVersion >= 1` team entries

- **Symptom**: team entries with a per-entry ItemKey (`itemKeyVersion >= 1`) failed to decrypt; the raw
  unwrapped ItemKey was being used directly as the entry key.
- **Root cause**: the consumer (`CredentialResolver`) skipped the final `HKDF("passwd-sso-item-enc-v1")`
  derivation that the extension applies after unwrapping the ItemKey. (Plan §"iOS resolver consumes the DERIVED
  enc key directly" correctly handled the team-enc key but not the per-item key.)
- **Fix**: `TeamEntryDecryptor.resolveTeamEntryKey` applies `TeamKeyCrypto.deriveItemEncryptionKey` (HKDF
  `passwd-sso-item-enc-v1`, salt=zero32) to the unwrapped ItemKey for `itemKeyVersion >= 1`; `==0` still uses the
  team enc key directly. Regression-guarded by golden vectors for **both** `itemKeyVersion` 0 and 1.

### D3 — `readDirect()` returns an EMPTY bridge_key → cacheKey threading via `UnlockResult.cacheKey`

- **Symptom**: deriving cacheKey from `BridgeKeyStore.readDirect()` (as C8 originally proposed for the call
  sites) produced a key derived from an EMPTY bridge_key, so the cacheKey-AAD unwrap of team/ECDH blobs failed.
- **Root cause**: `BridgeKeyStore.readDirect()` intentionally returns `bridgeKey: Data()` (empty); the real
  bridge_key is only materialized during unlock. C8's "derive cacheKey from `readDirect()` at each call site" was
  therefore unsound.
- **Fix**: capture the REAL cacheKey at unlock and thread it explicitly. `UnlockResult` gains
  `cacheKey: SymmetricKey` (VaultUnlocker, both passphrase and biometric paths derive it from the actual
  `blob.bridgeKey`). It is threaded RootView → VaultListView → HostSyncService / CredentialIdentityRegistrar /
  VaultViewModel / EntryEditForm / EntryDetailView / background sync. **Invariant**: never derive cacheKey from a
  `readDirect()` result. This supersedes C8's `deriveCacheVaultKey(bridgeKey: readDirect())` call-site guidance.
