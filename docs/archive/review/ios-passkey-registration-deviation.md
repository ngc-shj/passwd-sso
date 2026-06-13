# Coding Deviation Log: ios-passkey-registration

## C1–C3 / S-C1–S-C2 (commits `8a568876`, `c21ef211`)

- **S-C2 token TTL**: plan said "short-lived (config, default ~1h)"; the server
  pins `IOS_AUTOFILL_TOKEN_TTL_MS = 5 min` (code-layer constant, not
  tenant-configurable), reasoning that the token only needs to cover the
  seconds-long ceremony. Tighter than planned (security ↑, availability ↓);
  C6 compensates by re-minting on every unlock AND every host-app foreground,
  and the manual test covers the expired-token fall-through.

## C4–C8 (this change set)

- **C4 — no explicit `kSecAttrAccessGroup`**: plan specified creating the SE
  key with `kSecAttrAccessGroup = $(AppIdentifierPrefix)jp.jpng.passwd-sso.shared`.
  The literal team prefix cannot be supplied at runtime (Apple-assigned;
  passing a literal fails with errSecMissingEntitlement on device — see
  BridgeKeyStore.baseQuery). Implemented with the DEFAULT keychain access
  group, which — given the single `…shared` keychain-access-groups entitlement
  on BOTH host and extension — IS the shared group. Same posture, established
  repo idiom. The key keeps the planned distinct label
  `com.passwd-sso.dpop.autofill`.
- **C4 — helper/type relocation (R1 SSoT)**: `canonicalHTU` / `sha256Base64URL`
  became Shared free functions and `CreateEntryRequest` moved to
  `Shared/Network/EntryUploader.swift` (MobileAPIClient is app-only and the
  uploader could not reuse its members). MobileAPIClient call sites/tests
  updated; `performCreateHTTP` refactored over a new `performBodyHTTP` that
  `mintAutofillToken` also uses.
- **C6 — wiring shape**: plan didn't specify how the foreground re-mint reaches
  the app shell. `RootView.onVaultReady` gained an `AutofillTokenRefresher?`
  parameter; `PasswdSSOAppApp` re-mints in the `.active` scene-phase task
  (before drain/sync, so a sync failure cannot skip the mint). Lock clears the
  upload token inside `AutoLockService.lock()` (signOut inherits via lock()).
- **C7 — server URL for the extension**: not in the plan's file list. The
  extension needs the server base URL for the upload; added
  `serverConfigDefaultsKey` + `saveServerConfig`/`loadServerConfig` in
  `Shared/Models/ServerConfig.swift` (App Group UserDefaults — where the host
  already persisted it) and refactored `ServerURLSetupView` onto them.
- **C7 — local persistence design**: "persist to cache + register QuickType
  identity" implemented as (a) `CredentialResolver.encryptPasskeyEntry` /
  `appendEntryToCache` (cache write at counter N+1 with fresh meta re-read,
  same protocol as HostSyncService; bridge blob retained across the two calls
  so one biometric prompt covers the ceremony) and (b) a NEW append-style
  `CredentialIdentityRegistrar.add(passkeys:)` protocol member —
  `replace()` would have wiped the registered password/passkey set. Both are
  best-effort AFTER the confirmed upload; failures log and never cancel the
  already-durable registration.
- **Self-R-check (Step 2-5) dispositions**:
  - RS2 [Major] — `POST /api/mobile/autofill-token` lacked the rate limit the
    plan's S-C2 acceptance demanded. FIXED in Phase 2: 30 req/h per user
    (`mintLimiter`), 429 path + vitest.
  - R25 [Major] — the upload token crosses a true process boundary
    (host writes, extension reads via the shared Keychain group), which unit
    tests cannot cross (both targets mock the Keychain in-process). Accepted
    with quantification: worst case = registration cancels cleanly (no-lockout
    fall-through to iCloud Keychain, never data loss); likelihood = low (same
    shared-default-group mechanism as the shipped BridgeKeyStore /
    bridge-key items the AutoFill fill path already exercises on device);
    cost to fix = a device-level E2E harness this repo does not have. The R35
    manual test's happy path is the explicit verification artifact (note added
    to ios-passkey-registration-manual-test.md).
  - R3 [Minor] — dispatch comments in `extension-token.ts` /
    `validate-token-dpop.ts` didn't mention IOS_AUTOFILL. FIXED.
- **Phase-3 Round-1 fixes**:
  - S1 [Minor] — the mint endpoint gated on `auth.type === "token"`, which also
    admits BROWSER_EXTENSION / IOS_AUTOFILL tokens (they share passwords:write).
    Threaded `clientKind` onto `ValidatedExtensionToken` → `AuthResult["token"]`
    (additive; existing consumers unaffected) and gated the route on `IOS_APP`.
  - S2 [Minor] — added migration `20260613000001_ios_autofill_cnf_jkt_required`
    (partial CHECK), DB-layer parity with the BROWSER_EXTENSION constraint.
  - T1/T2 [Major] — added the S-C1 IOS_AUTOFILL DPoP-required tests and the
    issueAutofillToken unit tests (the route test had mocked it away).
  - T3 [Minor] — C1 golden vectors: the plan asked for byte vectors captured
    from the browser-extension TS encoder. No such fixture exists in
    `extension/test/fixtures/` (only TOTP/url-match/vault-unlock fixtures).
    Resolution: added EXACT-BYTE golden-vector tests built from the canonical
    framing + the pinned key (`testCOSEKeyExactGoldenBytes`,
    `testNoneAttestationObjectExactGoldenBytes`) — these pin the wire
    framing/length-encoding so any encoder change fails CI. The residual gap
    (the bytes are self-derived, not captured from the *other* implementation)
    is mitigated end-to-end: the server accepts the produced blob and the
    shipped assertion decoders read it back, which is a cross-implementation
    check in substance. Accepted as a deliberate deviation from the literal
    "captured from the TS encoder" wording.
  - F1 / T4 [Minor] — accepted with quantification (see code-review Resolution
    Status); no code change.
- **Process**: implemented directly by the orchestrator (no Sonnet sub-agent
  batches) — the per-contract test-gated loop on a single Xcode project
  serializes anyway, and the security-critical wiring benefits from the
  already-loaded context. All other Step 2-2 obligations (reuse inventory,
  per-batch verification) were applied inline.
