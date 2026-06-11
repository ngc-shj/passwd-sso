# Plan Review: ios-faceid-vault-unlock
Date: 2026-06-11
Review round: 1

## Changes from Previous Round
Initial review.

## Functionality Findings
- **F1 (Critical) → ADOPTED**: `readCacheFile(...)` has a `now: Date = Date()` param. VaultUnlocker must inject `now` (like CredentialResolver) and pass `now: now()`, else unit tests with a seeded cache hit `headerStale`. → C2 adds `now` injection.
- **F2 (Critical) → ADOPTED**: existing `AutoLockServiceTests.testLockDeletesBridgeKeyBlob` + `testTickLocksAtBoundary` assert the OLD "lock deletes bridge_key" invariant → break on C1. Invert (don't delete), rename, update doc. `testSignOutDeletesEverything` stays. → C1/C6 enumerate.
- **F3 (Major) → ADOPTED (wording)**: "meta present ⇒ key present" is best-effort, not guaranteed (two-item keychain). Soften the claim; note the EFFECTIVE gate is wrapped-key presence (cleared on signOut), and a rare meta-survives-key-gone case falls back to passphrase safely. No delete-order change (avoids shared-code/extension risk).
- **F4 (Major) → ADOPTED**: C2's `cacheURL` init change breaks `vaultLockedScreen` unless C5 applied together. Note the C2↔C5 atomic-coupling.
- **F5 (Major) → ADOPTED**: empty-string `userId` from the cache header would corrupt personal-entry AAD. Guard `!userId.isEmpty` → `.cacheUnreadable`.
- **F6 (Minor) → ADOPTED**: `vaultLockedScreen` cacheURL needs `(try? AppGroupContainer.cacheFileURL()) ?? URL(fileURLWithPath: "/dev/null")` fallback.
- **F7 (Minor→real) → ADOPTED**: `biometricUnlockAvailable()` on `actor VaultUnlocker` needs `await` from the sync view builder → mark it `nonisolated` (reads only injected Sendable stores).
- **F8 (Minor) → ADOPTED**: `signOut()` must call `bridgeKeyStore.delete()` as its FIRST operation (crash-safety) — merged with S2.

## Security Findings
- **S1 (Critical, escalate:true → handled directly, no Opus)**: dup of F2 — the lock-semantics pivot isn't applied to code/tests yet; tests encode old semantics. Migration strategy (update, not delete; bridge_key delete moves to signOut) is clear and agreed. The expert's own threat-model assessment CONCLUDED the trade-off is sound and correctly stated → no escalation warranted. → C1/C6.
- **S2 (Major) → ADOPTED**: `signOut()` must delete bridge_key FIRST (before token/wrapped clears) so a mid-signout crash can't leave the biometric path open. → C1.
- **S3 (Major) → ADOPTED**: R35 Tier-2 manual-test artifact required (session-lifecycle + key-custody change). Create `ios-faceid-vault-unlock-plan-manual-test.md` with adversarial scenarios (biometric-enrollment-change invalidation, coerced biometric, partial-signout crash, AutoFill-while-locked).
- **S4 (Minor) → ADOPTED**: stale `lock()` doc-comment ("delete bridge_key_blob") → update.
- **S5 (Minor) → ADOPTED (via F3 wording)**: `delete()` ordering / orphaned-meta — covered by softening the invariant + wrapped-key gate.
- **Threat-model assessment (security expert)**: keeping the `.biometryCurrentSet`/WhenUnlockedThisDeviceOnly bridge_key past lock is sound; only delta is "coerced biometric after auto-lock now suffices without passphrase" — the standard 1Password/Bitwarden trade-off, correctly documented. ACL flags verified. userId not a secret, not newly persisted. Zeroing pattern correct. AutoFill-while-locked coherent. No undisclosed regression.

## Testing Findings
- **T1 (Critical) → ADOPTED**: dup of F2 — invert the two breaking tests (don't delete), keep coverage of the new "lock KEEPS bridge_key" invariant.
- **T2 (Critical, RT1) → ADOPTED**: the `unlockWithBiometrics` happy-path test MUST use a `WrappedVaultKey` produced by the REAL wrap (`encryptAESGCM` under `HKDF(bridge_key)`) + a real seeded cache. Extract `wrapAndSaveVaultKey` + `buildCacheFile` (currently private to CredentialResolverTests) to a shared test helper.
- **T3 (Major, RT5) → ADOPTED**: the zero-biometric-reads assertion needs `MockKeychainAccessor.accessedServices` (MockKeychain lacks it) — assert availability touches only `bridge-meta-v2`.
- **T4 (Major, RT5) → ADOPTED**: happy-path test must call `unlocker.unlockWithBiometrics(reason:)` directly (not the crypto helpers), asserting on the returned UnlockResult.
- **T5 (Minor) → ADOPTED**: cache-seed helper must use a fresh timestamp (avoid headerStale).
- **T6 (Minor) → ADOPTED**: two separate false-case availability tests (bridge_key absent; wrapped key absent).

## Adjacent Findings
- R30 (Minor): bare `#537`/`#539` in the plan doc autolink. → wrap in backticks.

## Recurring Issue Check
### Functionality expert
R1-R37 checked; applicable: R3 (propagation — old-invariant tests/doc, F2/S4), R4/R7/R8/R9 surfaced as F1/F3/F5/F7. Rest N/A (iOS client).
### Security expert
R1-R37 + RS1-RS4 checked; clean except R3 (S1/S4), R35 (S3). ACL/threat-model/zeroing/PII all verified clean. RS1-RS4 clean.
### Testing expert
R1-R37 + RT1-RT5 checked; RT1 (T2), RT5 (T4), R17/R22 (helper extraction T2), R19 (MockKeychain accessedServices T3). Rest N/A.

## Disposition
All Critical + Major ADOPTED into the plan (round 2 below). No escalation (S1's trade-off analysis is complete and favorable; remaining work is test migration + plan precision). Manual-test artifact created.
