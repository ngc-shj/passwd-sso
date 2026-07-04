# Coding Deviation Log: ios-biometric-stale-cache-resync

## D1 — biometricUnlockError signature refinement (Minor, non-behavioral)
- Plan C2 sketched `biometricUnlockError(from: Error?, syncFailedCacheless: Bool) -> String?`.
- Implemented as `biometricUnlockError(from:syncFailedCacheless:message:)` with a
  `message: @autoclosure () -> String` param, so the localized string is injected by
  the caller (RootView, via L10n.string) rather than hardcoded in the pure function.
- Reason: keeps the pure function free of the i18n/`L10n` dependency so it stays a
  plain unit-testable free function (tests pass a literal "msg"). No behavioral change;
  the mapping logic (nil on .biometricFailed, message otherwise / on cacheless failure)
  is exactly as specified.

## D2 — emptyCacheData / syncedKeyVersion extracted as private RootView helpers (Minor)
- Plan C5 described the keyVersion re-derivation and empty-cache synthesis inline.
- Implemented as two private helpers (`emptyCacheData(userId:)`, `syncedKeyVersion(from:)`)
  for readability. `syncedKeyVersion` reuses the same `max(1, first{teamId==nil}?.keyVersion ?? 1)`
  idiom as VaultUnlocker (3rd copy of a one-line pattern; left un-extracted per YAGNI —
  the three sites are in different modules/contexts). No behavioral change.

## D3 — Phase 3 F1: .useEmptyCache added (plan AC-C5.4 corrected)
- The Round-0 plan's AC-C5.4 specified `decidePostSync(nil, true, nil) → .failLocked`.
  Phase-3 review found this regresses the passphrase path: a valid passphrase unlock
  of a brand-new/empty vault (or first offline unlock) would bounce to the locked
  screen instead of showing the legitimately-empty vault (the old code synthesized an
  empty vault here, which INV-C5.2 requires preserving).
- Fix: added a `.useEmptyCache` outcome; `.failLocked` is now reserved for the
  `cacheRecovered==false` (biometric stale/rolled-back) case only. S2 fail-closed
  invariant unchanged. Plan AC-C5.4 updated to match.

## D4 — TokenRefreshCoordinator: process-global refresh single-flight (NEW scope, Major)

- Not in the original plan. Discovered while verifying the stale-cache heal flow: the
  heal path fires several independent token refreshes back-to-back (unlock-data fetch,
  sync, QuickType refresh, drain) and, across distinct `MobileAPIClient` instances,
  concurrently. Each presented the same stale refresh token, tripping the server's
  refresh-token replay detector (`MOBILE_REFRESH_REUSE_DETECTED`), which revokes the
  whole token family → a dead session that looked like the very stale-cache bounce this
  branch set out to fix.
- Fix: new `TokenRefreshCoordinator` actor (`ios/PasswdSSOApp/Network/`) — a process-
  global gate keyed by the token store's Keychain service identifier that (a) joins an
  in-flight refresh (concurrent collapse) and (b) replays a recent SUCCESS within a
  short TTL (3s, < the server's 5s replay grace) for sequential re-tries. Only successes
  are cached; failures stay retryable so a re-sign-in can recover at any time.
- Replaced `MobileAPIClient`'s former instance-local `refreshTask` single-flight (which
  could not coordinate across instances) with a call into the coordinator, keyed by
  `HostTokenStore.serviceIdentifier` (new public accessor).

## D5 — MobileAPIClient.refreshCoordinator injected (Minor, testability)

- `MobileAPIClient.init` gained `refreshCoordinator: TokenRefreshCoordinator = .shared`.
- Reason: the process-global singleton's success cache leaks across tests (one test's
  rotated token replays into the next, suppressing the refresh the test asserts on).
  Production defaults to `.shared` (correct cross-instance behavior); tests inject a
  fresh instance for isolation. Mirrors the existing `now:` clock-seam injection —
  a production DI seam, not a test-only hack.

## D6 — VaultUnlockError.sessionExpired + RootView UnlockedResult enum (NEW scope, Minor)

- Not in the original plan. A dead refresh token surfaced as `serverResponseInvalid`
  ("check your connection and try again"), sending the user into a passphrase retry loop
  that no passphrase can break.
- Fix: new `VaultUnlockError.sessionExpired` (mapped from `MobileAPIError`
  `.authenticationRequired` in `VaultUnlocker`) routed to a "Your session has expired.
  Please sign in again." banner. `RootView.handleVaultUnlocked` return type changed from
  `Bool` to an `UnlockedResult` enum (`reachedVault` / `failedSessionExpired` /
  `failedOffline`) so the biometric call site picks the correct fail-closed banner
  (dead session → sign in again; offline → try passphrase). Fail-closed invariant
  (never present an empty vault as success) unchanged.

## D7 — Verification-only diagnostic logging removed before commit

- During debugging, temporary OSLog diagnostics were added across MobileAPIClient,
  VaultUnlocker, VaultUnlockView, and RootView to trace the refresh/unlock failure path.
  All were removed before commit; only RootView's pre-existing `sync`-category error log
  (which carries no token material) remains. No secrets were ever logged (MobileAPIError
  cases carry no token data), but the diagnostics were scaffolding, not shipping code.

## D8 — RootView sync-failure log hardened to classified outcome (post-review, Medium)

- Post-commit review flagged that RootView's surviving `sync`-category log dumped the
  full `runSync` error via `String(describing: error)` at `privacy: .public`. Today's
  `MobileAPIError` cases carry no token material, but `runSync` throws an arbitrary
  `Error`; the day it starts throwing a richer type (e.g. `URLError`), the log would
  leak a URL / response / internal state with no code change at the log site.
- Fix: log only the already-classified `sessionExpired` Bool
  (`syncFailedSessionExpired(from:)`), never the raw error. Same fixed-code shape the
  banner selection already relies on.

## D9 — Cross-cutting: raw-error log dumps reduced to the error TYPE (post-review, Medium)

- Swept the whole iOS tree for the same weak pattern (`String(describing: error)` at
  `privacy: .public`). Seven other sites dumped an arbitrary caught `Error` — including
  API (`MobileAPIError`), OS (`ASExtension`/`LAError`), and cache-I/O errors whose
  associated values can carry a URL / OSStatus / file path / response.
- Fix: replaced the payload dump with `type(of: error)` (the error's type name only) at
  all eight sites — enough to tell WHICH kind of failure occurred for debugging,
  without emitting any associated value:
  - `AutofillTokenRefresher.swift:53`
  - `CredentialProviderViewController.swift:266,362,395,461`
  - `CredentialResolver.swift:143,488`
  - `BridgeKeyStore.swift:204`
- Untouched: `CredentialProviderViewController.swift:412` logs a `decision` enum (no
  associated secret), and the `keyStatus`/`rpId` OSStatus logs (already non-secret
  scalars). No behavior change — logging text only.
