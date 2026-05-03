# Plan Review: ios-autofill-mvp-hardening

Date: 2026-05-03
Review round: 1

## Changes from Previous Round

Initial review.

## Summary

Reviewed across 3 expert perspectives (functionality / security / testing).
The plan covers 3 iOS items only — a fourth Web/server item was raised in
the original code review but is explicitly out of scope here per user
direction.

Findings affecting in-scope iOS items: 0 Critical, 6 Major, 8 Minor.
All Major findings folded into the plan revision before Phase 2.

## Functionality Findings

- **F-1 Major** — Entries-AAD aadVersion byte inconsistent with header
  AAD. Fix: drop aadVersion from entries-AAD; both AADs share the same
  shape style. → Plan §1 updated.
- **F-2 Major** — BridgeKeyStore split write-cleanup atomicity not
  specified. Fix: explicit ordering (meta first → key second → legacy
  delete last) + self-healing on partial state via `notFound`. → Plan §2
  updated.
- **F-3 Major** — Legacy migration trigger contradiction (`create()` vs
  first-read). Fix: trigger only from `readForFill`/`readDirect`/
  `incrementCounter`. → Plan §2 updated.
- **F-4 Major** — Service-name collision with legacy combined item. Fix:
  rename new services to `*-v2`; legacy `bridge-key` retained for
  migration only. → Plan §2 updated.
- **F-5 Minor** — Threat model documentation. Fix: explicit Threat Model
  Assumptions section. → Plan top updated.
- **F-8 Minor** — Pin write-back missing for users who never re-pin. Fix:
  migration-on-read in `currentPin()`; legacy alias permanent. → Plan §3
  updated.

## Security Findings

- **S-1 Major** — Counter rollback risk after split (App Group attacker
  overwrites counter). Resolution: documented as out-of-scope per Apple
  platform-security baseline. HMAC over counter+uuid noted as future
  hardening. → Plan §2 acknowledgment added.
- **S-2 Major** — Migration non-atomicity (partial-state from kill-during-
  migration). Fix: explicit ordering in `tryMigrateLegacyBlob`; on failure
  leave legacy intact; legacy delete is best-effort/non-fatal. → Plan §2
  updated.
- **S-3 Minor** — `PinSet` field doc-comment misleading. Fix: replace
  doc-comment text in addition to the function-level rename. → Plan §3
  updated.
- **S-5 Minor** — Two AAD construction conventions in same file
  (cache-header AAD vs cross-platform `buildAADBytes`). Resolution: keep
  both styles distinct since cross-platform parity is not required for
  cache files (iOS-only). Documented in Plan §1.

## Testing Findings

- **T-1 Major** — Splice test must call `buildCacheEntriesAAD`. Fix:
  function `internal` (not `private`); tests use `@testable import
  Shared`. Add negative-control test (identical context → splice
  succeeds, confirms test detects AAD specifically). → Plan step 2
  updated.
- **T-2 Major** — `MockKeychainAccessor` does not model ACL → false-green
  risk for "readDirect doesn't touch biometric item." Fix: extend mock
  with `accessedServices: [String]` recorder; assert exact services
  touched. → Plan step 4 updated.
- **T-3 Minor** — JSON-decode test for legacy `tlsSPKISHA256` key.
  Already in plan; updated step 6 to make test name explicit.
- **T-7 Minor** — `bridgeKeyBlobSize == 56` constant becomes ambiguous
  post-split. Fix: rename to `legacyBridgeKeyBlobSize` (module-private,
  migration-helper only); add `bridgeKeyV2Size = 32` and
  `bridgeMetaV2Size = 24`. → Plan step 3 updated.

## Out of scope (originally raised, deferred)

The original review pass also raised:

- F-6, F-7 (web-side audit-action consumer enumeration + helper chain)
- S-4 (vault-reset audit metadata size limits)
- T-4, T-5, T-6 (web-side mock alignment + audit-action enumeration test
  files + vault-reset metadata shape)

These all relate to the Vault Reset cache-invalidation audit warning on
the **Web/server side**, which the user explicitly placed out of scope
for this iOS-only plan. They are recorded here for traceability and
should be revisited in a separate, web-scoped plan.

## Adjacent Findings

- (Functionality → Security) Plan adds `userId` to entries AAD assuming
  single-userId-per-cache. Confirmed in scope: cache file is per-device
  per-user; multi-account is not in scope for ios-autofill-mvp.
- (Testing → Security) Cache-AAD scope decision (drop `headerHash`) is a
  security-domain decision. Security expert (S-5) confirmed `counter +
  uuid + userId` is adequate.

## Recurring Issue Check

### Functionality expert
- R3 (sequencing): no in-scope finding
- R23 (CryptoKit AAD format): F-1
- R25 (encryption migration version): F-3
- All other R1-R30: N/A or no issue.

### Security expert
- R8 (replay/freshness): S-1 (acknowledged out-of-scope by threat model)
- R15 (migration safety): S-2
- R16 (TOFU correctness): S-3
- R23 (algorithmic agility): S-5
- R25 (cross-extension state): S-1
- All other R1-R30: N/A or no issue.

### Testing expert
- RT1 (mock-reality divergence): T-2 (KeychainAccessor doesn't model ACL)
- RT2 (testability): Confirmed — `encryptAESGCM` public,
  `MockKeychainAccessor` two-service-keying works, JSONDecoder pattern
  available
- RT3 (shared constant in tests): T-7
- All other R1-R30: N/A or no issue.

## Resolution Status

All in-scope Major findings (F-1, F-2, F-3, F-4, S-2, T-1, T-2) resolved
by plan revision. Minor findings either folded into the plan or accepted
with explicit rationale recorded in Plan §"Considerations & constraints".

Web/server findings are NOT addressed here — see "Out of scope" section.

Round complete; proceed to Phase 2 (implementation).
