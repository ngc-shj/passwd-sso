# Plan: ios-autofill-mvp-hardening

## Project context

- Type: iOS native app under `ios/` (parent repo also hosts web app, but this
  plan is iOS-only)
- Test infrastructure: iOS XCTest + project CI
- Active branch: `feature/ios-autofill-mvp` (no new branch — extend the
  in-flight feature)

## Objective

Resolve three iOS review findings on top of the in-flight iOS AutoFill MVP
work:

1. (iOS — high) Bind the encrypted-entries blob in `EntryCacheFile` to its
   header context via AAD so a swap of `(new header + old entries)` is
   rejected.
2. (iOS — high) Separate the bridge_key (biometric-gated) from the
   counter/host_install_uuid (no biometric required) into two distinct
   Keychain items, eliminating the conflict between `.biometryCurrentSet`
   ACL and the documented `readDirect()` path.
3. (iOS — medium) Stop calling the field `tlsSPKISHA256` when the value is
   actually the SHA-256 of `SecKeyCopyExternalRepresentation` output (raw
   uncompressed EC point or PKCS#1 RSAPublicKey, not SPKI DER). Make name
   and implementation match.

A fourth review item (Vault Reset cache-invalidation audit, Web/server
side) was raised in the same review pass but is **out of scope** for this
plan — the user explicitly scoped this work to iOS-only.

## Threat model assumptions

The assumed adversary is "an attacker with write access to the App Group
container or shared Keychain access group, but WITHOUT the user's
biometric." Concretely: another app installed in the same App Group (rare
but possible across enterprise MDM scenarios), a compromised Share/Widget
extension, or local supply-chain tampering on the device. The adversary
cannot decrypt vault material (vaultKey is wrapped under bridge_key, which
is `.biometryCurrentSet`-gated).

OUT OF SCOPE: full device compromise (jailbreak, debugger attach with
breakpoints in the app process, decrypted memory dump). Per Apple's
platform-security baseline, App-Group-write-access alone is not considered
"device compromise" — but full-app code-injection is.

## Requirements

### Functional

- F-1: An `EntryCacheFile` written with header H₁ and entries E₁ MUST be
  rejected when read against any other header (different counter, UUID,
  or userId) — even when the attacker possesses both halves of valid
  cache files.
- F-2: `BridgeKeyStore.create()` produces TWO Keychain items: a
  biometric-gated item carrying the 32-byte bridge_key, and a
  non-biometric `WhenUnlockedThisDeviceOnly` item carrying counter (8 BE)
  + host_install_uuid (16 raw). All existing public API
  (`readForFill`/`readDirect`/`incrementCounter`/`recoverForwardCounter`/
  `delete`) MUST continue to work; behavior visible to consumers must not
  change semantically.
- F-3: `PinSet` field naming MUST match what the value actually contains
  (raw leaf-public-key bytes, not SPKI DER). Stored values MUST migrate
  silently — old keychain entries with the old field name continue to
  decode AND get re-encoded into the new shape on first write-back.

### Non-functional

- NF-1: No regression in iOS XCTest suite under `ios/PasswdSSOTests/`.
- NF-2: Wire format / on-disk format changes that affect existing
  installations MUST include a migration path. For ENTRIES-AAD: feature
  branch only — no live users; legacy cache files become unreadable
  (rejected via existing `.authtagInvalid` path), caller re-fetches
  cleanly. For BRIDGE-KEY split: explicit migrate-on-read step from
  legacy combined `com.passwd-sso.bridge-key` (56-byte) item.

## Technical approach

### 1. EntryCacheFile entries-blob AAD

Today the entries blob is encrypted with AES-GCM and *no AAD*. Header has
AAD `"CACHEHDR" || counter(BE 8) || uuid(16)`. So `(new header H₂ + old
entries E₁)` decrypts cleanly, and the only remaining check is
`entryCount` matching (defeated by an attacker who controls header JSON
and re-encrypts under the still-valid vaultKey-derived AEAD key).

**Decision (resolves F-1)**: keep header AAD as-is (no version byte) and
adopt a parallel-style entries AAD. Both AADs use the same shape: 8-byte
ASCII tag + counter(BE 8) + uuid(16) + optional fields. The entries AAD
prepends `userId` length-prefixed.

Entries AAD format:

```text
"CACHEENT" (8 ASCII)
counter (BE 8)
hostInstallUUID (16 raw)
userIdLen (BE 2)
userId (UTF-8 bytes)
```

NO `aadVersion` byte — matches the existing `buildCacheHeaderAAD`
omission. If we later need versioned AADs, both can be migrated together
in a deliberate wire-format break.

We do NOT bind `headerHash` per the original review:
- `counter + uuid + userId` already forces the three identity fields that
  distinguish one valid header from another.
- `cacheIssuedAt` and `lastSuccessfulRefreshAt` are time-only fields, not
  identity; binding them would require re-decrypting the header before
  the entries AAD can be computed (chicken-and-egg).
- `entryCount` is verified post-decryption against the JSON array length;
  an attacker who forges a header (which requires the AEAD key, i.e.,
  possession of vaultKey) is already past every defense.

Threat-model rationale: the attacker has App Group write access but NO
vaultKey. Without entries AAD, swapping in old entries is undetectable
because both ciphertexts decrypt under the legitimate AEAD key with no
context binding. With entries AAD bound to (counter, uuid, userId), the
swap is detected. `entryCount` post-decryption check still functions as
a sanity gate; AAD is the authoritative integrity boundary.

Helper addition: `buildCacheEntriesAAD(counter:hostInstallUUID:userId:)`
becomes `internal` (not `private`) so the test target can call it under
`@testable import Shared`.

Migration: cache file is single-device, ephemeral, and auto-rebuilds on
counter advance. An old (no-AAD-on-entries) cache file written by the
previous version produces `.authtagInvalid` on read → existing caller
path forces a fresh fetch. No migration code needed; documented as
"feature branch unshipped, dev-only impact."

### 2. BridgeKeyStore split

Today: ONE Keychain item with `.biometryCurrentSet` ACL holds
`[bridge_key:32][counter:8 BE][host_install_uuid:16]` = 56 bytes.

Problem: `readDirect()` / `incrementCounter()` / `recoverForwardCounter()`
are documented as "no biometric" but the underlying item has
`.biometryCurrentSet`. On real devices this either prompts (bad UX in
host-app foreground sync) or returns `errSecAuthFailed`.

**Service names**: use NEW service strings to avoid collision with the
legacy combined item.

```text
service = "com.passwd-sso.bridge-key-v2"
  kSecValueData = bridge_key (32 bytes)
  kSecAttrAccessControl = .biometryCurrentSet
  kSecAttrAccessible = WhenUnlockedThisDeviceOnly

service = "com.passwd-sso.bridge-meta-v2"
  kSecValueData = counter (BE 8) || hostInstallUUID (16) = 24 bytes
  kSecAttrAccessible = WhenUnlockedThisDeviceOnly
  (no .biometryCurrentSet ACL)
```

Legacy combined service `com.passwd-sso.bridge-key` (56-byte payload)
remains readable for migration purposes only.

**Public API**:

- `create()` writes BOTH new items in this strict order:
  1. Add `bridge-meta-v2` (no-ACL — least likely to fail).
  2. Add `bridge-key-v2` (biometric-gated).
  3. (Migration path only) Delete legacy `bridge-key` if it existed.

  Failure rollback: if step 2 fails, delete `bridge-meta-v2` then bubble
  up. If step 3 fails, log via OSLog (best-effort) but do not treat as
  fatal — the new items are valid, legacy item becomes a benign orphan
  that the migration helper will re-attempt to remove on next read.

- `readForFill(reason:)` MUST return the same `Blob` shape as today.
  Implementation: read `bridge-key-v2` (with biometric LAContext), then
  read `bridge-meta-v2` (no-ACL). If either is `errSecItemNotFound`,
  attempt one-shot legacy migration (see below) and retry; if still
  missing → `Error.notFound`.

- `readDirect()` reads `bridge-meta-v2` only and returns a Blob with
  `bridgeKey = Data()` (empty 0-byte). Existing callers
  (`HostSyncService.fetchAndStore` line 39, `RootView` line 189,
  `StaleBlobRecoveryService` line 30, `DebugVaultLoader`) all confirmed
  via grep to read only `cacheVersionCounter` and `hostInstallUUID`
  after `readDirect()` — none consume `bridgeKey`. Document this in
  the Blob struct doc-comment.

- `incrementCounter(newCounter:)` operates on `bridge-meta-v2` only (no
  biometric prompt during background sync). Internally tries to migrate
  from legacy on `errSecItemNotFound`.

- `recoverForwardCounter(observed:)` unchanged in semantics; calls
  `readDirect` + `incrementCounter` internally.

- `delete()` deletes `bridge-key-v2`, `bridge-meta-v2`, AND legacy
  `bridge-key` (best-effort, errSecItemNotFound is OK on each). Returns
  first non-OK status not equal to `errSecItemNotFound`.

**Self-healing semantics**: `readForFill` and `readDirect` treat any
single-item missing as `Error.notFound`. The caller path on `notFound`
is to re-unlock the vault, which calls `create()` again — `create()` is
idempotent on duplicate (existing fall-back to `update`). Partial-write
states heal on next vault unlock.

**Legacy migration trigger**: ONE migration helper `tryMigrateLegacyBlob()
-> Blob?` is invoked from `readForFill`, `readDirect`, and
`incrementCounter` whenever the v2 items return `errSecItemNotFound`.
Algorithm:

```swift
private func tryMigrateLegacyBlob(usingContext: LAContext?) throws -> Blob? {
  // Read legacy combined item via biometric (if context provided) or
  // direct (if not). errSecItemNotFound → return nil (no migration
  // needed).
  let legacyData = try readLegacy(...)
  guard let blob = try? deserializeLegacy(legacyData) else { return nil }
  // Write v2 items. If any step fails, leave legacy intact.
  try persistBlob(blob)  // writes both v2 items
  // Best-effort delete of legacy. Failure here is non-fatal; next
  // call will detect v2 present and skip migration entirely.
  _ = try? keychain.delete(query: legacyQuery())
  return blob
}
```

**Counter-rollback risk acknowledgment**: removing `.biometryCurrentSet`
from the meta item allows an attacker with App Group write access to
overwrite counter to a previous value. Combined with a stolen old cache
file, this enables a stale-snapshot replay. This trade-off is documented
as the cost of fixing the `readDirect`-prompts-biometric bug. The threat
model treats App Group write access as out-of-scope per the threat-model
assumptions section. A future tightening could add an HMAC over (counter
|| uuid) keyed by HKDF(bridgeKey, ...), verified on `readForFill`;
deferred to a follow-up because it would re-introduce a per-fill
bridgeKey dependency on every counter advance.

### 3. ServerTrustService SPKI hash naming

`extractLeafSPKIHash` hashes `SecKeyCopyExternalRepresentation(publicKey)`
output. For ECDSA P-256 leaves, this is the 65-byte uncompressed point
(`0x04 || X || Y`); for RSA leaves, PKCS#1 RSAPublicKey DER. Neither is
SubjectPublicKeyInfo DER, so `tlsSPKISHA256` is misnamed.

**Decision**: rename + clarify; do NOT change the hashing semantics.

- TOFU pin is computed and compared on-device only; server-side never
  needs to compute the matching value.
- Real SPKI DER would require either DER parsing or `encodeP256SPKI`
  (P-256 only — would silently break RSA leaf certs in private
  deployments).

Concrete change:

- Rename `PinSet.tlsSPKISHA256` → `PinSet.tlsLeafKeySHA256`. Field
  doc-comment replaced with: "SHA-256 of the leaf certificate's public
  key in `SecKeyCopyExternalRepresentation` form (uncompressed EC point
  or PKCS#1 RSAPublicKey, NOT SPKI DER). Stable per server identity but
  not interchangeable with `openssl dgst -sha256` over `-pubkey -outform
  DER`."
- Custom `Codable` initializer accepts both `tlsSPKISHA256` AND
  `tlsLeafKeySHA256` JSON keys; `encode(to:)` writes ONLY the new key.
- **Migration-on-read** in `currentPin()`: when decode succeeds via the
  legacy alias, the function re-encodes via `pin()` to upgrade the
  on-disk JSON. Result: next read no longer needs the alias. The legacy
  alias remains in the decoder permanently with a `// kept for
  forward-compat with old Keychain blobs` comment — no removal timeline.
- Rename `SPKIPinningDelegate.capturedSPKIHash` → `capturedLeafKeyHash`.
- Rename `extractLeafSPKIHash` → `extractLeafKeyHash`; doc-comment
  matches the field doc.

## Implementation steps

1. **(iOS-1)** `ios/Shared/Storage/EntryCacheFile.swift`:
   - Add `func buildCacheEntriesAAD(counter:hostInstallUUID:userId:) throws -> Data`
     as `internal` (file-level, not `private`).
   - Pass the new AAD to `encryptAESGCM` on entries write.
   - Pass the same AAD to `decryptAESGCM` on entries read.
   - Since entries-AAD requires `userId`, and `userId` is parsed from the
     decrypted header, the read-order remains: decrypt header → read
     header.userId → build entries-AAD → decrypt entries.

2. **(iOS-1 tests)** `ios/PasswdSSOTests/EntryCacheFileTests.swift`:
   - `testEntriesBlobBindToCounterRejectsCrossFileSwap`: write file A
     (counter=10, userId=u1, entries=[A1]); write file B (counter=11,
     userId=u1, entries=[B1]). Build Frankenstein file C with B's
     encrypted-header bytes + A's encrypted-entries bytes (parsing the
     original file format and re-assembling). `readCacheFile(C,
     expectedCounter=11)` must throw `.rejection(.authtagInvalid)`.
   - `testEntriesBlobBindToUserIdRejectsCrossUserSwap`: write A
     (userId=u1) and B (userId=u2) with same counter+uuid; splice
     B-header + A-entries; reject.
   - `testEntriesBlobNegativeControl`: write A and B with IDENTICAL
     (counter, uuid, userId) but different IV (i.e., write twice).
     Splice B-header + A-entries — expect SUCCESSFUL decryption,
     because AAD components are identical. (Confirms test detects AAD
     mismatch specifically, not other corruption.)
   - Use `@testable import Shared` to access `buildCacheEntriesAAD` when
     computing expected AAD bytes for direct splice construction.

3. **(iOS-2)** `ios/Shared/Storage/BridgeKeyStore.swift`:
   - Introduce two service constants:
     - `bridgeKeyServiceV2 = "com.passwd-sso.bridge-key-v2"`
     - `bridgeMetaServiceV2 = "com.passwd-sso.bridge-meta-v2"`
     - `bridgeKeyServiceLegacy = "com.passwd-sso.bridge-key"`
   - Refactor `create()`, `readForFill()`, `readDirect()`,
     `incrementCounter()`, `recoverForwardCounter()`, `delete()` per §2.
   - Add `tryMigrateLegacyBlob()` private helper.
   - Add new error case: `Error.partiallyCreated` reserved for future use
     (NOT thrown in MVP — caller treats partial state as `notFound` and
     re-unlocks).
   - Keep `bridgeKeyBlobSize = 56` as `legacyBridgeKeyBlobSize = 56`
     module-private constant, used only inside the migration helper. Add
     new `bridgeKeyV2Size = 32` and `bridgeMetaV2Size = 24`.

4. **(iOS-2 tests)** `ios/PasswdSSOTests/BridgeKeyStoreTests.swift`:
   - Extend `MockKeychainAccessor` to record every `copyMatching` call's
     `kSecAttrService` value into an observable `accessedServices: [String]`
     array.
   - `testReadDirectOnlyTouchesMetaService`: assert `accessedServices ==
     ["com.passwd-sso.bridge-meta-v2"]` after a single `readDirect()`
     call.
   - `testReadForFillTouchesBothV2Services`: assert services include
     both `bridge-key-v2` and `bridge-meta-v2`.
   - `testLegacyBlobMigrationOnReadDirect`: pre-seed mock with a 56-byte
     legacy item under `com.passwd-sso.bridge-key`; call `readDirect()`;
     assert (a) returned blob counter+uuid match legacy bytes 32..56;
     (b) post-call mock state has `bridge-key-v2` AND `bridge-meta-v2`
     entries; (c) legacy `bridge-key` entry is deleted.
   - `testLegacyMigrationFailureKeepsLegacyIntact`: inject Add failure
     for v2 services; assert legacy item still readable after.
   - Replace `testBlobSizeIs56Bytes` with `testBridgeKeyV2Is32Bytes` and
     `testBridgeMetaV2Is24Bytes`.

5. **(iOS-3)** `ios/PasswdSSOApp/Auth/ServerTrustService.swift`:
   - Rename the field, the function, the delegate property.
   - Add custom Codable conformance for `PinSet` with legacy-key decoder
     alias.
   - Implement `currentPin()` migration-on-read.
   - Update doc-comments per §3.

6. **(iOS-3 tests)** `ios/PasswdSSOTests/ServerTrustServiceTests.swift`:
   - `testPinSetDecodesLegacyTLSSPKIKey`: decode hardcoded JSON literal
     with `tlsSPKISHA256` key → assert decoded.tlsLeafKeySHA256 matches.
   - `testPinSetEncodesNewTLSLeafKeyKey`: encode → JSON string contains
     `tlsLeafKeySHA256`, NOT `tlsSPKISHA256`.
   - `testCurrentPinUpgradesLegacyOnRead`: pre-seed keychain with old
     JSON; call `currentPin()`; assert subsequent `currentPin()` reads
     the new shape (verify by checking what the keychain mock now holds).
   - Update existing tests for renamed fields.

7. **Verification**
   - iOS: `xcodebuild test` — run on iPhone simulator with iOS 26.x SDK.

## Considerations & constraints

- **Out of scope**: building real SPKI DER for the TOFU pin. Trade-off
  documented in §3.
- **Out of scope**: HMAC-protected counter/uuid in the meta item.
  Documented in §2 with explicit Apple-platform-security-baseline
  rationale.
- **Out of scope**: Vault Reset cache-invalidation audit warning (web
  side). Was originally raised in the same review as the iOS findings
  but explicitly scoped out of this iOS-only plan per user direction.
- **Migration risk** for BridgeKeyStore: any failure in the migration
  helper leaves the legacy item readable, so the worst case is "no
  migration today, retry on next call." Documented in step 3.

## User operation scenarios

- Scenario A — fresh install on iOS, AutoFill invoked: `readForFill()`
  reads both v2 items; cache file decrypts including entries AAD;
  credential surfaces. Verifies F-2 + F-1 happy path.
- Scenario B — attacker swaps entries portion: replaces `entries` bytes
  in the cache file with an older counter's entries → reader rejects
  with `.authtagInvalid` (entries AAD mismatch on counter field) →
  caller falls back to "vault locked". Verifies F-1.
- Scenario C — attacker rewrites userId in the header JSON before
  re-encrypting: requires vaultKey, out of threat model. If the attacker
  somehow has vaultKey (game over anyway), the entries AAD binding to
  userId still forces them to also re-encrypt entries with the new
  userId — adds work but not a defense-in-depth break.
- Scenario D — host app launch, vault locked, sync needs counter:
  `readDirect()` reads only `bridge-meta-v2` (no biometric prompt) →
  succeeds silently. Verifies F-2.
- Scenario E — upgrade from build with legacy 56-byte combined item:
  first `readDirect()` triggers `tryMigrateLegacyBlob()` → reads legacy
  → writes v2 items → deletes legacy → returns Blob. Subsequent calls
  find v2 items directly. Verifies F-2 migration.
- Scenario F — TOFU pin first sign-in: hash captured; stored under
  `tlsLeafKeySHA256`; subsequent sign-ins compare equal. Verifies F-3.
- Scenario G — upgrade from build with legacy `tlsSPKISHA256`: PinSet
  decodes via legacy alias; `currentPin()` triggers migration-on-read →
  re-encodes JSON with new key. Pin not re-prompted. Verifies F-3.
