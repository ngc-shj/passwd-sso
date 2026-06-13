# Coding Deviation Log: ios-passkey-registration

## C1–C3 / S-C1–S-C2 (commits 8a568876, c21ef211)

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
- **Process**: implemented directly by the orchestrator (no Sonnet sub-agent
  batches) — the per-contract test-gated loop on a single Xcode project
  serializes anyway, and the security-critical wiring benefits from the
  already-loaded context. All other Step 2-2 obligations (reuse inventory,
  per-batch verification) were applied inline.
