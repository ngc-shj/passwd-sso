# Code Review: ios-autofill-mvp-hardening

Date: 2026-05-03
Final round: R3 (verification only — no findings)

## Scope

iOS-only diff against `main`:

- `ios/Shared/Storage/EntryCacheFile.swift` (+ tests)
- `ios/Shared/Storage/BridgeKeyStore.swift` (+ tests)
- `ios/PasswdSSOApp/Auth/ServerTrustService.swift` (+ tests)
- 8 dependent test-mock updates across iOS test files

Web/server changes for the original review's item #4 (Vault Reset cache
invalidation audit) were initially included but reverted entirely from
the diff per user direction; that work is recorded in the plan as
out-of-scope and deferred to a separate web-scoped plan.

## Round 1 Findings

### Functionality (4 findings, all Minor or non-actionable)

- **F-1 Minor** — Dead code `_ = existing.counter` in
  `BridgeKeyStore.incrementCounter`. **Fixed**: simplified to extract
  only `uuid` directly, no temp tuple.
- **F-2** — Verification-only entry confirming `tryMigrateLegacyBlob`
  on persistBlob failure preserves the legacy item. No fix needed.
- **F-3 Minor** — `ServerTrust.pin()` update path drops
  `kSecAttrAccessible` (pre-existing in changed file, in scope).
  **Fixed**: re-set the attribute on the update path.
- **F-4 [Adjacent] Minor** — SCIM route narrows
  `InvalidateUserSessionsResult` type by assignment. Out of scope per
  plan §"Considerations & constraints". No fix.

### Security (1 in-scope finding, Minor)

- **S-1 Minor** — `VAULT_RESET_CACHE_INVALIDATION_FAILED` missing from
  team/tenant audit groups. **Out of scope** — applies to Web/server
  item #4 which was reverted entirely. Recorded for the web-scoped
  follow-up plan.

### Testing (5 findings, 1 Major + 4 Minor in iOS scope)

- **T-1 Major** — admin-reset failure-path test missing.
  **Out of scope** — Web/server item.
- **T-2 Major** — `tryMigrateLegacyBlob` failure path was untested;
  `MockKeychainAccessor` had no add-failure injection. **Fixed**:
  extended mock with `addFailureForServices: Set<String>`; added
  `testLegacyMigrationFailureKeepsLegacyIntact` asserting legacy
  intact + v2 items absent after a key-v2 add failure.
- **T-3 Minor** — SCIM mock structural drift. **Out of scope**.
- **T-4 Minor** — `testHeaderMissingUserIdRejectsAsHeaderInvalid`
  brittleness. **Fixed**: added a comment explaining the test passes
  because parseHeaderJSON throws before entries-decrypt; if read-order
  changes, the test must be rewritten.
- **T-5 Minor** — `userIdLen` byte-boundary not tested. **Fixed**:
  added 3 builder-level tests (256, 0xFFFF, oversized rejected).

## Round 2 Findings

### Functionality

No findings. All R1 fixes verified.

### Security

No findings. All R1 fixes verified — including that
`ServerTrust.pin()` update kSecAttrAccessible re-application is
identity-rewrite (cannot weaken accessibility) and that the
BridgeKeyStore migration-failure test correctly exercises the meta-v2
rollback path on key-v2 add failure.

### Testing (2 new Minor findings)

- **T2-1 Minor** — Boundary tests verify only the AAD BUILD path, not
  the AAD-USE round-trip. **Fixed**: added
  `testRoundTripWithUserIdAtByteBoundary` (write+read with 256-byte
  userId).
- **T2-2 Minor** — `testLegacyMigrationFailureKeepsLegacyIntact` used
  `_ = error` (lax). **Fixed**: replaced with
  `XCTAssertEqual(error as? BridgeKeyStore.Error,
  .keychainError(errSecParam))` plus a comment tracing the
  deterministic failure path.
- Informational — `MockKeychainAccessor.addFailureForServices` is
  `var Set<String>` on `@unchecked Sendable`; safe under XCTest's
  main-thread synchronous execution. No action.
- Informational — failure check before duplicate check in
  `MockKeychainAccessor.add()` is intentional; failure injection
  takes precedence over slot occupancy. No action.

## Round 3 Findings

No findings. Both R2 fixes verified syntactically and semantically
correct, no production code touched, and a sweep confirms no other
weak `_ = error` stragglers remain in the iOS test corpus.

## Adjacent Findings

- (Functionality → Security) Plan binds `userId` to entries AAD
  assuming single-userId-per-cache. Confirmed in scope: cache file is
  per-device per-user; multi-account is not in scope for
  ios-autofill-mvp.
- (Testing → Security) Cache-AAD scope decision (drop `headerHash`)
  was a security-domain decision, confirmed in R1 plan review.

## Resolution Status

### F-1 Minor: dead code `_ = existing.counter`

- **Action**: Removed; `incrementCounter` now uses `let uuid: Data`
  directly.
- **Modified file**: `ios/Shared/Storage/BridgeKeyStore.swift` (lines
  ~200-220)

### F-3 Minor: pin() update drops kSecAttrAccessible

- **Action**: Re-set `kSecAttrAccessible =
  kSecAttrAccessibleWhenUnlockedThisDeviceOnly` on the update branch.
- **Modified file**: `ios/PasswdSSOApp/Auth/ServerTrustService.swift`
  (lines ~114-136)

### T-2 Major: missing migration-failure test

- **Action**: Added `addFailureForServices: Set<String>` to
  `MockKeychainAccessor`; added
  `testLegacyMigrationFailureKeepsLegacyIntact` asserting legacy
  intact + key-v2 absent + meta-v2 rolled back.
- **Modified file**: `ios/PasswdSSOTests/BridgeKeyStoreTests.swift`

### T-4 Minor: brittleness comment

- **Action**: Added explanatory comment to
  `testHeaderMissingUserIdRejectsAsHeaderInvalid`.
- **Modified file**: `ios/PasswdSSOTests/EntryCacheFileTests.swift`

### T-5 Minor: userIdLen boundary tests

- **Action**: Added `testCacheEntriesAADFormatLongUserId`,
  `testCacheEntriesAADFormatMaxUserId`, and
  `testCacheEntriesAADFormatOversizeUserIdRejected`.
- **Modified file**: `ios/PasswdSSOTests/EntryCacheFileTests.swift`

### T2-1 Minor: round-trip at boundary

- **Action**: Added `testRoundTripWithUserIdAtByteBoundary` that
  writes + reads a cache file with a 256-byte userId, verifying the
  AAD-on-encrypt and AAD-on-decrypt paths agree at the byte boundary.
- **Modified file**: `ios/PasswdSSOTests/EntryCacheFileTests.swift`

### T2-2 Minor: tighten error assertion

- **Action**: Replaced `_ = error` with `XCTAssertEqual(error as?
  BridgeKeyStore.Error, .keychainError(errSecParam))` plus a comment
  tracing the deterministic failure path.
- **Modified file**: `ios/PasswdSSOTests/BridgeKeyStoreTests.swift`

### Out of scope (Web/server, not addressed)

- **S-1 Minor — Anti-Deferral check**: out of scope (different
  feature). The Vault Reset cache-invalidation audit warning belongs
  to a separate web-scoped plan. Recorded for follow-up.
- **T-1 Major — Anti-Deferral check**: same as S-1.
- **T-3 Minor — Anti-Deferral check**: same as S-1.

## Verification

- `xcodebuild test` — TEST SUCCEEDED (final run after R2 fixes).
- All 13 changed iOS files have corresponding test coverage.
- `git status --short` confirms no Web/server files in the diff.
