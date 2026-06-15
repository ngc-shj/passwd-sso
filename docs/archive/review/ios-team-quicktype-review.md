# Plan Review: ios-team-quicktype

Date: 2026-06-14
Review round: 1

## Changes from Previous Round

Initial 3-expert plan review of the iOS team-key pipeline. No Critical findings; no security escalation.
25 findings (8 functionality, 10 security, 10 testing) — all resolved in the plan.

## Functionality Findings (resolved)

- **F2 (Major)** cacheKey provisioning at `PasswdSSOAppApp` call site (BackgroundSyncContext lacks BridgeKeyStore)
  → C8: BackgroundSyncContext gains a BridgeKeyStore ref (or stores derived cacheKey at unlock).
- **F4 (Major)** `VaultViewModel` has no BridgeKeyStore → C8: inject `cacheKey: SymmetricKey?` into the VM
  methods from the view layer; nil → personal-only fallback.
- **F6 (Major)** C1 must add the 4 ECDH fields to the explicit `CodingKeys` enum (else silent nil) → C1 fixed.
- **F13 (Minor)** `BackgroundSyncTask` doesn't call `refreshCredentialIdentities` → C8: wire it in background
  (scenario 1 promises background QuickType appearance).
- **F3 (Minor)** leftover team key when ECDH absent + revoked → C7: clear file if ALL blobs already stale.
- **F14 (Minor)** existing WrappedKeyStore mocks need new methods → C4 mock-update obligation + C9.
- **F10 (Minor)** PKCS#8 fallback condition unclear → C3: pkcs8 is primary (WebCrypto exports pkcs8);
  raw-scalar fallback only if the golden vector proves it; don't ship unused fallback.
- **R1** shared team-decrypt helper unspecified → C8: new `TeamEntryDecryptor.swift`, reused by resolver+registrar.

## Security Findings (resolved; no Critical, escalate:false)

- **S1 (Medium)** no userId-binding AAD on the cacheKey re-wrap of the ECDH key + team enc keys → C2 adds
  `buildLocalWrapAAD` ("LW"); C5/C7 wrap with `kind+userId(+teamId)` AAD. (Pre-existing WrappedVaultKey left
  AAD-less; out of scope, same threat model.)
- **S2 (Medium)** WrappedTeamKey teamId not AEAD-bound (blob-swap) → C7 wraps team key with teamId in AAD; C8
  updates `CredentialResolver.decryptTeamKey` to verify the same AAD (consumer side).
- **S4 (Medium)** clearAll must wipe the ECDH key → C4: explicit `ecdhPrivateKeyURL()` + clearAll delete +
  mandatory test gate.
- **S5 (Low)** no negative AEAD tests → C9: tampered ciphertext, wrong-AAD, bad-curve tests.
- **S6 (Low)** importEphemeralPublicKey lacks kty/crv validation → C3: validate, throw `unsupportedKeyType`.
- **S9 (Low)** PKCS#8 intermediate not zeroized → C3: `unwrapEcdhPrivateKey` returns the imported key directly,
  zeroizing the intermediate bytes.
- **S10 (Low)** clearAll omission risk → C4: named path + gate test.
- **S3 (Low)** "leave untouched" revocation delay → reviewed sound; refined by F3 (clear-if-all-stale).
- **S7/S8 (Info)** at-rest protection == existing WrappedVaultKey; token scope pre-existing → no action.

## Testing Findings (resolved)

- **T1/T2 (High)** golden-vector capture must come from the EXTENSION, not iOS self → C9: mandatory
  `scripts/generate-team-key-fixture.mjs` deliverable + external fixture + forbid self-checks.
- **T8 (High)** no fetchTeamMemberKey test + unnamed skip error → C6 names `MobileAPIError.teamKeyNotDistributed`;
  C9 adds the tests.
- **T3 (Medium)** AAD test must be full-byte → C9/C2 (AADParityTests pattern).
- **T4 (Medium)** MockWrappedKeyStore/TempDirWrappedKeyStore need new methods (compile break) → C4/C9.
- **T5 (Medium)** VaultUnlockerTests need `makeVaultUnlockDataWithECDH` builder (real P256/PKCS8) → C9.
- **T6 (Medium)** HostSyncServiceTests stub is personal-only → C9: MockURLProtocol member-key + seeded ECDH key.
- **T7 (Medium)** registrar test needs cacheKey + shared `makeTeamCacheEntry` helper → C9.
- **T9 (Low)** manual-test adversarial scenarios refined (clock-skew, sign-out wipe) → C9.
- **T10 (Low)** test "no ECDH key → existing set untouched (not [])" → C9.

## Adjacent Findings
- F3 flagged [Adjacent]→security; merged with S3.

## Quality Warnings
None.

## Recurring Issue Check
- Functionality: R1 (shared helper — C8), R3 (call-site propagation — C8 enumerates all 5 + provisioning),
  R19 (CodingKeys/exact-shape — C1), R25 (persist/hydrate — C4 clearAll), R37 (clock — C7 injected). Addressed.
- Security: R25 (clearAll wipe — C4 gate), RS1 (no hardcoded secrets — HKDF infos are domain separators),
  RS4 (no key material in logs/artifacts), AAD binding (S1/S2 — C2/C7/C8). Addressed.
- Testing: RT1 (mock-reality — fixtures from extension, C9), RT2 (vacuous-pass — external fixture, forbid
  self-check). Addressed.

## Resolution Status
All 25 round-1 findings resolved in the plan (no deferrals). Proceeded to round 2.

---

# Review round 2 (incremental)

Verified all round-1 resolutions; the local-wrap AAD design was confirmed cryptographically sound (security).
8 new findings, all plan-text precision fixes — resolved:

- **F15 (Critical — plan-text API name)**: `pkcs8DERRepresentation` is not a CryptoKit API; verified the correct
  one is `derRepresentation` (emits/accepts PKCS#8 PrivateKeyInfo, WebCrypto-pkcs8 compatible) → C3/C5 fixed.
- **F16 (Major)**: AAD `userId` provenance must be `cacheData.header.userId` on both writer + reader → C8 made
  explicit.
- **F17 (Minor)**: enforce AAD writer/reader symmetry via a single shared wrap/unwrap pair (TeamEntryDecryptor /
  LocalKeyWrap) → C8.
- **S11 (Low)**: stale-branch clear via a `clearTeamKeys()` protocol method (not direct file delete) + mocks
  reset in-memory state → C4/C7.
- **S12 (Low)**: defensive `assert(wrapped.teamId == lookupTeamId)` in the unwrap helper → C8.
- **T11/T12 (Medium)**: capture script `.ts` via repo-root `tsx` importing the real `crypto-team.ts` (not `.mjs`
  inline-drift); encrypt-side fixture layout (`ct||tag` split) specified → C9.
- **T13 (Medium)**: async-throw negative tests must use `do/try await/XCTFail/catch`, not `XCTAssertThrowsError`
  → C9.
- **T14 (Low)**: "forbid self-check" is review-time only — acceptable (committed external fixture is the anchor).

Security: no Critical, escalate:false (both rounds). Core design (key lifecycle, AAD binding, golden-vector
strategy) verified sound. **Plan converged — all contracts C1-C9 locked.**

---

# Implementation notes (post-implementation) — deviations from the locked plan

Date: 2026-06-15

Three issues surfaced during implementation that the locked plan did not anticipate. All fixed in-branch; full
detail (symptom / root cause / fix / invariant) is in the plan's **Implementation deviations** section (D1–D3).
Summarized here so the review record reflects shipped reality, with the Phase-3 review focus called out.

- **D1 — proxy Bearer-bypass allowlist missing `/api/teams` (SERVER CHANGE)**: invalidates the plan's "iOS-only /
  no server change" framing. `EXTENSION_TOKEN_ROUTES` (`src/lib/proxy/cors-gate.ts`) lacked `API_PATH.TEAMS`, so
  the mobile Bearer token was 401'd at the proxy before any handler ran — team fill was impossible end-to-end.
  Fix adds `API_PATH.TEAMS`; handlers still enforce scope + `requireTeamPermission` (no authz moved to the
  proxy). **Phase-3 review focus (security)**: this widens the proxy Bearer-bypass surface across the entire
  `/api/teams/*` tree — confirm no team route relies on the proxy session check for authorization, and that
  preflight/CORS behavior for the new tree is correct.
- **D2 — item-enc HKDF missing for `itemKeyVersion >= 1`**: consumer used the raw unwrapped ItemKey directly;
  fix applies `TeamKeyCrypto.deriveItemEncryptionKey` (HKDF `passwd-sso-item-enc-v1`) in
  `TeamEntryDecryptor.resolveTeamEntryKey`. Golden-vector regression for itemKeyVersion 0 **and** 1.
- **D3 — `readDirect()` empty bridge_key → cacheKey threading**: C8's "derive cacheKey from `readDirect()` at
  each call site" was unsound (`readDirect()` returns an empty bridge_key by design). Superseded by capturing the
  real cacheKey at unlock (`UnlockResult.cacheKey`) and threading it RootView → VaultListView → sync / registrar
  / VM / forms / background. **Invariant**: never derive cacheKey from a `readDirect()` result.

Phase-3 review (functionality / security / testing) is scheduled against the implemented branch; its findings
will be appended below. Key review targets: the D1 proxy allowlist change (security boundary), cacheKey
threading correctness (D3), AAD binding symmetry, key zeroization, and `clearAll()` wiping every key blob.
