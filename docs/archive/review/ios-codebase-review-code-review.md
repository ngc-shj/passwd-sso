# Code Review: ios-codebase-review
Date: 2026-06-13
Review round: 4 (final — all experts: No findings)
Scope: entire `ios/` tree (~15K LOC Swift, app + AutoFill extension + Shared + tests), standalone Phase 3 review (no plan/deviation log). Branch `fix/ios-passkey-autofill` (2 commits beyond main) given extra scrutiny.
Ollama pre-screening/seeds: unavailable (Ollama down) — all experts performed full review; manual dedup by orchestrator.

## Changes from Previous Round
Initial review.

## Functionality Findings

### F1 [Critical]: Background sync is dead — `BackgroundSyncTask.register` never called + `BGTaskSchedulerPermittedIdentifiers` missing
- File: ios/PasswdSSOApp/PasswdSSOAppApp.swift (no register call), ios/project.yml (no permitted-identifiers key)
- Evidence: `grep -rn "BackgroundSyncTask.register\|BGTaskSchedulerPermittedIdentifiers" ios` → zero call sites, zero plist declarations. `BackgroundSyncTask.swift:12` comment: "Must be called before the app finishes launching."
- Problem: (1) the BGTask launch handler is never registered, so `scheduleNext()` submits requests with no handler; (2) the identifier `com.passwd-sso.cache-sync` is not declared in `BGTaskSchedulerPermittedIdentifiers`, so registration would be rejected anyway.
- Impact: The BGTaskScheduler cache top-up path has never worked. Extension reads stale data when the host app hasn't been foregrounded recently — directly relevant to passkey AutoFill (user may go Safari → passkey sheet without opening the app).
- Fix: register the handler in `PasswdSSOAppApp.init()` via a mutable context holder populated by `onVaultReady`; add `BGTaskSchedulerPermittedIdentifiers` to project.yml app Info properties; submit the initial schedule on vault-ready and on `.background`.
- Orchestrator verification: confirmed (grep).

### F2 [Major]: `writeRollbackFlag` records `observedCounter` = expected value (and `headerIssuedAt` always nil)
- File: ios/Shared/AutoFill/CredentialResolver.swift:565–578
- Evidence: `observedCounter: blob.cacheVersionCounter` (the Keychain expected value) at line 573; `headerIssuedAt: nil` always.
- Problem: `EntryCacheError.rejection` carries only the kind, so the resolver has no access to the on-disk header values; it fabricates the observed counter.
- Impact: Rollback reports carry no real diagnostic data; server-side audit metadata is wrong for counter_mismatch / header_stale / clock-skew kinds.
- Fix: add a `CacheRejectionContext` (observedCounter/headerIssuedAt/lastSuccessfulRefreshAt) to `EntryCacheError.rejection`, populate it where the header is available, thread it into `RollbackFlagPayload`.
- Orchestrator verification: confirmed. Note: in a true rollback (old file), header decryption fails AAD (`authtagInvalid`) and the observed counter is cryptographically unknowable — context fields must be optional.

### F3 [Major]: App Group identifier hardcoded in 3 files instead of `AppGroupContainer.identifier`
- File: ios/PasswdSSOApp/Views/ServerURLSetupView.swift:21, ios/PasswdSSOApp/Vault/AppSettingsStore.swift:23, ios/PasswdSSOApp/Vault/DeviceIdentifier.swift:12
- Evidence: `grep -rn "group.jp.jpng.passwd-sso.shared" ios --include="*.swift"` → 3 production literals + SSoT at AppGroupContainer.swift:11.
- Impact: an App Group rename silently severs host↔extension data sharing for server config / device id / settings.
- Fix: replace literals with `AppGroupContainer.identifier`.
- Orchestrator verification: confirmed (grep).

### F4 [Major]: `deriveMacKey(from:)` duplicated byte-for-byte in RollbackFlagWriter.swift
- File: ios/Shared/AutoFill/RollbackFlagWriter.swift:80, :139
- Problem: writer and verifier each carry a private copy of the HKDF derivation; divergence silently breaks MAC verification (all rollback flags discarded as forged).
- Fix: extract a single fileprivate function used by both.
- Orchestrator verification: confirmed.

### F5 [Minor]: QuickType/passkey identities not refreshed after `createEntry`/`saveEntry`
- File: ios/PasswdSSOApp/Views/Vault/VaultViewModel.swift (createEntry/saveEntry tails)
- Problem: both methods refresh the cache but never update `ASCredentialIdentityStore`; new/edited entries don't appear in AutoFill until the next `.active` sync.
- Fix: extract the summaries+passkeys+replace sequence (currently duplicated in PasswdSSOAppApp `.active` path and RootView.refreshCredentialIdentities — R1 overlap) into a shared helper and call it after cache refresh in both methods.

### F6 [Critical] (new — orchestrator, found verifying F2): cache-rollback report wire format mismatch — every POST is rejected with 400
- File: ios/PasswdSSOApp/Vault/RollbackFlagDrain.swift:111–118 vs src/app/api/mobile/cache-rollback-report/route.ts:74–83
- Evidence: server Zod schema is `.strict()` with `headerIssuedAt: z.number().int().nonnegative()` and `lastSuccessfulRefreshAt: z.number().int().nonnegative()` — both REQUIRED numbers. iOS `CacheRollbackReportBody` declares both as `String?` (ISO8601 / always-nil), and `JSONEncoder` omits nil keys → request always fails validation.
- Problem: write-read consistency violation across the client/server boundary (the mandated check all three experts ran missed this).
- Impact: the entire rollback-reporting path is non-functional end-to-end: the server never receives any rollback/forged-flag audit event, and the drain never gets a 200 so the flag file is retried forever (rate-limiter burns 5 req/24h per device on permanently-failing requests).
- Fix: change `CacheRollbackReportBody.headerIssuedAt`/`lastSuccessfulRefreshAt` to epoch-second `Int` (0 when unknown), sourced from the (now context-carrying) rollback payload; keep `rejectionKind` strings (verified: all 8 iOS kinds + `flag_forged` exist in the server enum).

## Security Findings

### S1 [Major]: Server-controlled `kdfIterations` passed to PBKDF2 without floor validation
- File: ios/PasswdSSOApp/Vault/VaultUnlocker.swift:104
- Evidence: `iterations: unlockData.kdfIterations` — `kdfType` is validated (==0), iterations are not.
- Problem: MITM in the TOFU window or a rogue/compromised server can serve `kdfIterations: 1`, silently reducing the wrapping key to ~1 hash. Offline brute-force of the passphrase against captured wrapped-key material becomes trivial.
- Fix: reject `kdfIterations < 600_000` (named constant, matching the web client's pinned value) with `serverResponseInvalid`.
- Orchestrator verification: confirmed; web client pins 600k (CLAUDE.md E2E spec). Regression test added.

### S2 [Minor]: Non-constant-time HMAC comparison in RollbackFlagVerifier
- File: ios/Shared/AutoFill/RollbackFlagWriter.swift:129
- Evidence: `guard actualMAC == expectedMACData` — `constantTimeEquals` exists at CryptoUtils.swift:52 but is unused here.
- Fix: use `constantTimeEquals`.

### S3 [Minor]: Credential identities persist across backgrounding (branch change — reduced defense-in-depth)
- File: ios/PasswdSSOApp/PasswdSSOAppApp.swift:77–87
- Problem/context: intentional change required for cross-app passkey ceremonies; identities are non-secret metadata, fills stay biometric-gated; cleared on lock/sign-out/launch.
- Disposition: Accepted (see Resolution Status — Anti-Deferral quantification).

### S4 [Minor]: Force-cast on `SecKey` from `SecItemCopyMatching` (suppressed lint warning)
- File: ios/Shared/Crypto/SecureEnclaveKey.swift:62–63
- Fix: replace `as!` + `swiftlint:disable` with `guard let ... as? SecKey else { throw .keyNotFound }`.

## Testing Findings

### T1 [Critical]: `passkeySignCount` decode never asserted in EntryBlobDecoderTests
- File: ios/PasswdSSOTests/EntryBlobDecoderTests.swift:169–185
- Problem: `material.signCount` (new field this branch) has no round-trip assertion; a regression dropping the field reverts the floor to 0 silently → RP counter-monotonicity failures ship undetected.
- Fix: assert signCount for present (42), absent (→0), and negative (→0 clamp) blob JSON.

### T2 [Critical]: HKDF known-vector test asserts only length/determinism — vector value never asserted
- File: ios/PasswdSSOTests/KDFTests.swift:52–71
- Problem: expected hex exists only in a comment; wrong info string / hash / IKM encoding would still pass. Cross-platform parity (web client must decrypt iOS output) unprotected at unit level.
- Fix: assert the hex vector after independently re-deriving it (Node `crypto.hkdfSync` cross-check by orchestrator before committing).

### T3 [Major]: `testAutoLockFiresAtBoundaryWithTestClock` tests a no-op event under a misleading name
- File: ios/PasswdSSOTests/LockStateReducerTests.swift:9–30
- Problem: `.autoLockTick` is a documented no-op in `LockStateReducer`; real boundary logic lives in `AutoLockService` (tested there). Name creates false coverage confidence.
- Fix: rename to state the no-op contract and assert state passes through unchanged.

### T4 [Major]: blob → `material.signCount` → floor integration path untested
- File: ios/PasswdSSOAutofillExtension/CredentialProviderViewController.swift:228–231 (call site)
- Fix: extend CredentialResolverTests' passkey fixture with `"passkeySignCount": 50` and assert `material.signCount == 50` through `decryptPasskeyMaterial`.

### T5 [Major]: `PasskeySignCountStore.next` wraps to 0 at `UInt32.max` (untested, unhandled)
- File: ios/Shared/Storage/PasskeySignCountStore.swift:26
- Problem: `&+ 1` wraps; a poisoned/extreme server floor permanently bricks the credential (0 ≤ any previous count). 
- Fix: saturate at `UInt32.max` instead of wrapping; add tests for the boundary.

### T6 [Minor]: Dead `baseState` fixture in LockStateReducerTests
- Fix: remove.

## Adjacent Findings
- F-adj (Functionality A1 / informational): BE/BS flags always set in assertion authenticatorData — acceptable for iCloud-Keychain-synced platform credentials; no server rejection evidence. No action this round.
- T1-A → routed to Functionality: HKDF vector comment claims verification "at implementation time" but nothing enforces it — resolved by T2 fix (assertion + independent cross-check).
- Functionality A3 / informational: `PasskeySignCountStore` falls back to `.standard` defaults if App Group unavailable — accepted defensive behavior.

## Quality Warnings
None — all findings carried file:line evidence; no VAGUE / NO-EVIDENCE / UNTESTED-CLAIM flags. T5's fix suggestion verified feasible (UserDefaults round-trip lossless on 64-bit).

## Recurring Issue Check

### Functionality expert
(Expert reported a renumbered project-specific checklist; orchestrator mapping to canonical IDs.)
- R1 (shared utility reimplementation): Finding F4 (deriveMacKey duplicated); also identity-refresh sequence duplicated (folded into F5 fix)
- R2 (constants hardcoded): Finding F3 (App Group ID ×3)
- R3 (pattern propagation): Checked — no issue (AAD construction consistent across 4 sites)
- R4 (event dispatch gaps): Finding F5 (identity refresh missing at 2 of 3 mutation sites)
- R5 (TOCTOU): Checked — write-then-increment ordering in HostSyncService is deliberate and recoverable
- R6 (delete cleanup): Checked — signOut/lock/launch clear keychain, files, identities
- R7 (UI-test selectors): Checked — no issue
- R8 (UI consistency): Checked — no issue
- R9 (fire-and-forget): Checked — documented intentional Tasks
- R10 (circular deps): Checked — no issue
- R12 (enum coverage): Checked — no issue
- R23 (mid-stroke input mutation): Checked — no issue
- R25 (persist/hydrate symmetry): Checked — sign-count store persists before return; cache write ordering correct
- R26/R27/R28 (UI cues/limits/labels): Checked — no issue (auto-lock 60 vs 1440 two-tier design is intentional)
- R29 (spec citations): Checked — WebAuthn structures verified
- R34 (adjacent same-class bugs): Finding F2 family
- R35: branch touches project.yml/xcscheme — see orchestrator note below
- R36 (suppressions): [Adjacent → Security] S4
- R37 (user-facing jargon): Checked — no issue ("Authenticating…" properly localized)
- R11/R13–R16/R17–R22/R24/R30–R33: N/A for this codebase (no DB roles, migrations, CI-config changes, markdown citations, destructive ops, new long-running artifacts in diff)

### Security expert
- R1: Checked — no duplicate crypto/keychain primitives (zeroData private copies noted, non-divergent)
- R2: Finding S1 (PBKDF2 floor documented in comments only, not enforced)
- R3: Checked — AAD parity consistent; no propagation gap
- R5: Checked — recoverable write ordering
- R6: Checked — comprehensive cleanup on signOut/lock/launch
- R25: Checked — sign-count persist/hydrate symmetric
- R29: Checked — RFC 9449 / WebAuthn L2 citations verified against implementation
- R31: Checked — ios/scripts contains only icon generation
- R34: Finding S1 (pre-existing in adjacent file VaultUnlocker — security carve-out, fixed this round)
- R35: branch artifacts = xcscheme (no security impact), identity-lifecycle change (S3), sign-count store (App Group UserDefaults appropriate for non-secret counter)
- R36: Finding S4 (force_cast suppression)
- R37: Checked — no issue
- RS1: Finding S2 (HMAC `==`); AES-GCM tag comparison is CryptoKit-internal; no other credential comparisons found
- RS2: Checked — passphrase attempts are server-throttled (network round-trip per attempt); biometric path OS-throttled
- RS3: Finding S1 (kdfIterations unvalidated); other server fields decoded via typed Codable; rpId filtering exact-match in extension
- RS4: Checked — only RFC 2606 domains in DEBUG fixtures

### Testing expert
- R7: Checked — a11y identifiers exist in production code; `staticTexts["passwd-sso"]` matches a hardcoded literal (locale-independent)
- R16: Checked — locale/keychain/SE parity handled; documented caveats in test files
- R19: Checked — mock shapes match protocol boundaries (SyncEncryptedEntry vs EncryptedEntry bridged correctly)
- R21: N/A (orchestrator obligation — discharged below)
- R29: Checked — flag-byte comments (0x1D) verified correct
- R33: Checked — xcodebuild test exists only in ci.yml ios-ci job
- R34: Checked — no remaining locale-dependent tests after the branch fix
- RT1: Minor residual gap (BackgroundSyncCoordinator mock bypasses JSON decode; EntryFetcherTests covers decode path) — no finding
- RT2: Checked — all recommendations feasible (UserDefaults injectable, pure functions, `evaluatesBiometricExplicitly: false`)
- RT3: Checked — BridgeKeyStore test literals match production defaults; consistent with codebase patterns
- RT4: N/A — no concurrency-cardinality tests present
- RT5: Checked — tests call through production call paths (VaultUnlocker→BridgeKeyStore→mock keychain)

## Orchestrator notes
- R21 discharge: all expert outputs independently spot-verified by orchestrator before fixes (greps + file reads recorded above); full test suite + build run before commit.
- R35: the F1 fix touches Info.plist-equivalent config (project.yml). BGTask firing cannot be exercised by XCTest (Apple provides no simulation API to tests; see BackgroundSyncTask.swift doc comment). Manual test plan: docs/archive/review/ios-autofill-mvp-manual-test.md §"BGTaskScheduler" already covers the procedure; re-run on device after this round's fix (register + permitted-identifiers + initial submit).
- Escalation check: no Security Critical findings reported; orchestrator concurs (S1 requires network-position or server compromise → Major). No Opus re-run.

## Resolution Status

### F1 [Critical] Background sync dead — Fixed
- Action: `BackgroundSyncTask.register` now takes lazy closures and is called from `PasswdSSOAppApp.init()` via a new `BackgroundSyncContext` holder populated in `onVaultReady`; initial `scheduleNext()` submitted at vault-ready and refreshed on `.background`; `BGTaskSchedulerPermittedIdentifiers` + `UIBackgroundModes: processing` added to project.yml (Info.plist regenerated via xcodegen). Note: `UIBackgroundModes: processing` was required in addition to the expert's finding — BGProcessingTaskRequest is rejected without it.
- Modified files: ios/PasswdSSOApp/Background/BackgroundSyncTask.swift, ios/PasswdSSOApp/PasswdSSOAppApp.swift, ios/project.yml, ios/PasswdSSOApp/Info.plist (generated), ios/PasswdSSO.xcodeproj (generated)
- Residual: BGTask firing is not unit-testable (Apple API limitation) — on-device manual test per docs/archive/review/ios-autofill-mvp-manual-test.md §"BGTaskScheduler" required before release. UI tests confirm the app launches with registration in place.

### F6 [Critical] Rollback report wire-format mismatch — Fixed
- Action: `CacheRollbackReportBody.headerIssuedAt`/`lastSuccessfulRefreshAt` changed from `String?`/always-nil to required epoch-second `Int` (0 = unknown), matching the server's strict Zod schema; values now sourced from the rejection context. Regression test asserts the required keys are present as 0 even when context is unknown.
- Modified files: ios/PasswdSSOApp/Vault/RollbackFlagDrain.swift, ios/PasswdSSOTests/RollbackFlagDrainTests.swift, ios/PasswdSSOTests/MobileAPIClientTests.swift

### T1 [Critical] passkeySignCount decode unasserted — Fixed
- Action: added present(42)/absent(0)/negative(→0 clamp) round-trip tests.
- Modified file: ios/PasswdSSOTests/EntryBlobDecoderTests.swift

### T2 [Critical] HKDF vector never asserted — Fixed
- Action: orchestrator re-derived the vectors via Node `crypto.hkdfSync` — the comment's old value (`5e57823d…`) was WRONG (63 hex chars, not even a valid 32-byte value), confirming the test was decorative. Tests now assert enc = `ee19d55b…a437` and auth = `232f65f5…aba1`.
- Modified file: ios/PasswdSSOTests/KDFTests.swift

### F2 [Major] observedCounter fabricated — Fixed
- Action: `EntryCacheError.rejection` now carries `CacheRejectionContext` (observedCounter/headerIssuedAt/lastSuccessfulRefreshAt, all optional — nil when the header is cryptographically unreadable); populated at the four header-readable rejection sites; threaded through `CredentialResolver.writeRollbackFlag` into `RollbackFlagPayload` (observedCounter now optional; lastSuccessfulRefreshAt added).
- Modified files: ios/Shared/Storage/EntryCacheFile.swift, ios/Shared/AutoFill/CredentialResolver.swift, ios/Shared/AutoFill/RollbackFlagWriter.swift, ios/PasswdSSOApp/Vault/StaleBlobRecoveryService.swift, ios/PasswdSSOTests/EntryCacheFileTests.swift, ios/PasswdSSOTests/RollbackFlagWriterTests.swift

### F3 [Major] App Group ID hardcoded ×3 — Fixed
- Action: replaced literals with `AppGroupContainer.identifier` (+ `import Shared` in DeviceIdentifier.swift).
- Modified files: ios/PasswdSSOApp/Views/ServerURLSetupView.swift:21, ios/PasswdSSOApp/Vault/AppSettingsStore.swift:23, ios/PasswdSSOApp/Vault/DeviceIdentifier.swift:13

### F4 [Major] deriveMacKey duplicated — Fixed
- Action: single fileprivate `deriveRollbackFlagMacKey` shared by writer and verifier.
- Modified file: ios/Shared/AutoFill/RollbackFlagWriter.swift

### S1 [Major] kdfIterations floor missing — Fixed
- Action: new shared constant `pbkdf2Iterations = 600_000` (KDF.swift, also the parameter default); `VaultUnlocker.unlock` rejects `kdfIterations < pbkdf2Iterations` with `serverResponseInvalid`. Regression test added. Test fixtures updated from 1 → `pbkdf2Iterations` iterations (production floor was NOT weakened for test convenience, per expert-agent obligations).
- Modified files: ios/Shared/Crypto/KDF.swift, ios/PasswdSSOApp/Vault/VaultUnlocker.swift, ios/PasswdSSOTests/VaultUnlockerTests.swift

### T4 [Major] blob→floor integration untested — Fixed
- Action: passkey fixture gained `passkeySignCount` param; new test asserts blob JSON 50 → `decryptPasskeyMaterial().signCount == 50`; existing test asserts absent → 0.
- Modified file: ios/PasswdSSOTests/CredentialResolverTests.swift

### T5 [Major] sign count wraps at UInt32.max — Fixed
- Action: `&+ 1` replaced with explicit saturation at `UInt32.max`; boundary tests added (floor=max stays max across uses; floor=max-1 emits max).
- Modified files: ios/Shared/Storage/PasskeySignCountStore.swift, ios/PasswdSSOTests/PasskeySignCountStoreTests.swift

### F5 [Minor] identities stale after create/save — Fixed
- Action: new shared `refreshCredentialIdentities(from:vaultKey:userId:)` in CredentialIdentityRegistrar.swift; adopted at all three sites (App `.active` path, RootView unlock/debug, VaultViewModel create/save) — also resolves the R1 duplication of the summaries+passkeys+replace sequence. (RootView's private wrapper was removed; a type named `Shared` shadows the module name, so the free function is called unqualified.)
- Modified files: ios/Shared/AutoFill/CredentialIdentityRegistrar.swift, ios/PasswdSSOApp/PasswdSSOAppApp.swift, ios/PasswdSSOApp/Views/RootView.swift, ios/PasswdSSOApp/Views/Vault/VaultViewModel.swift

### S2 [Minor] non-constant-time HMAC compare — Fixed
- Action: `constantTimeEquals` (CryptoUtils) used in `RollbackFlagVerifier.verify`.
- Modified file: ios/Shared/AutoFill/RollbackFlagWriter.swift

### S4 [Minor] force-cast SecKey — Fixed
- Action: `CFGetTypeID(key) == SecKeyGetTypeID()` guard added before the cast (CF types do not support plain conditional downcast reliably; the guard makes the retained `as!` provably safe and the suppression now carries a documented justification per R36(d)).
- Modified file: ios/Shared/Crypto/SecureEnclaveKey.swift

### T3 [Major] misleading reducer test — Fixed
- Action: renamed to `testAutoLockTickIsNoOpInReducer_lockingDrivenByAutoLockService`, now asserts pass-through equality far past the boundary; doc comment points to AutoLockServiceTests for the real boundary coverage.
- Modified file: ios/PasswdSSOTests/LockStateReducerTests.swift

### T6 [Minor] dead baseState fixture — Fixed
- Action: removed together with the T3 rewrite.
- Modified file: ios/PasswdSSOTests/LockStateReducerTests.swift

### S3 [Minor] identities persist across backgrounding — Accepted
- **Anti-Deferral check**: acceptable risk (quantified below)
- **Justification**:
  - Worst case: entry titles/usernames/RP IDs remain visible in the QuickType bar while the app is backgrounded but the vault is not yet locked — exposure to shoulder-surfing/screen-recording of suggestion metadata only; no secrets, fills remain biometric-gated.
  - Likelihood: low — requires an observer with screen access during the window between backgrounding and auto-lock/sign-out/launch-clear, on a device whose vault is unlocked.
  - Cost to fix: a time-delayed clear must NOT fire during a cross-app passkey ceremony; getting that timing wrong re-introduces the exact "Vault is Locked" passkey regression this branch just fixed (errSecInteractionNotAllowed fallback). High regression risk for a marginal privacy gain; the auto-lock timer already bounds the window.
- **Orchestrator sign-off**: accepted — risk quantified, fix cost exceeds benefit, behavior is documented in code (PasswdSSOAppApp `.background` comment) and was deliberately introduced and verified by this branch.

### F7 [Major] (new — orchestrator, found by mandatory checks): bash-version-dependent SQL quote-doubling bug in 3 password scripts — Fixed
- File: scripts/set-outbox-worker-password.sh:74, scripts/set-dcr-cleanup-worker-password.sh:74, scripts/set-audit-anchor-publisher-password.sh:74 (pre-existing, outside iOS scope, surfaced by the mandatory `npx vitest run` gate)
- Evidence: `"${new_password//\'/\'\'}"` emits `\'\'` (backslashes preserved) on bash 3.2 (macOS /bin/bash) but `''` on bash ≥ 4.3 (CI ubuntu) — quote-removal semantics of the replacement string changed in bash 4.3. Reproduced: password `it's'a'test` → `PASSWORD 'it\'\'s\'\'a\'\'test'` (wrong password set; no injection).
- Action: hold the quote in a variable (`q="'"; escaped="${new_password//${q}/${q}${q}}"`) — version-independent. All 3 sibling scripts fixed (R3 propagation). scripts/__tests__: 147 passed / 0 failed.
- Note: per CLAUDE.md "Fix ALL errors", fixed despite being outside the iOS review scope; tests only failed locally (macOS bash 3.2), CI bash 5 masked the bug while production operators running the documented `scripts/...sh` invocation on macOS would hit it.

## Round 2 (incremental review of commit 2ee00b20)

All three experts verified every Round-1 fix as correct/secure (full per-item verification tables in the experts' outputs; orchestrator retained the verdicts). Baseline note: the user asked whether the review baseline is `ios-main` — verified that merge-base(main, HEAD) == merge-base(ios-main, HEAD) == fc4d5686, so the diff baseline is identical either way, and the review scope was the whole `ios/` tree regardless.

New findings:

### F8 [Minor]: entries-blob rejection discards the already-decrypted header context — Fixed
- File: ios/Shared/Storage/EntryCacheFile.swift (post-header helpers throw `.unavailable`)
- Action: readCacheFile wraps buildCacheEntriesAAD / decryptEntriesBlob / countJSONArrayElements in do/catch and rethrows with `headerContext`, so an entries-blob corruption report carries the observed header values.

### T7 [Major]: second saturation test vacuous (passes under old wrapping impl) — Fixed
- Action: renamed to `testFloorJustBelowMaxEmitsMaxByNormalIncrement` with a doc comment stating it is boundary arithmetic; the discriminating regression coverage is `testFloorAtUInt32MaxSaturatesInsteadOfWrapping` (its second assertion fails under wrapping).

### T8 [Major]: refreshCredentialIdentities not injectable / untested — Fixed
- Action: added `registrar: CredentialIdentityRegistrar = CredentialIdentityRegistrar()` parameter; new end-to-end test `testRefreshCredentialIdentities_replacesPasswordsAndPasskeysFromCache` (encrypted cache fixture → FakeIdentityStore observes replace with correct password/passkey specs).
- Modified files: ios/Shared/AutoFill/CredentialIdentityRegistrar.swift, ios/PasswdSSOTests/CredentialIdentityRegistrarTests.swift

### T9 [Minor]: BackgroundSyncContext uncovered — Fixed
- Action: new ios/PasswdSSOTests/BackgroundSyncContextTests.swift (nil-before-update / values-after-update / overwrite). Note: first run crashed on BridgeKeyStore's service-name precondition (`…bridge-key` suffix required) — stub service renamed; documents the precondition for future fixture writers.

### S5 [Minor]: BackgroundSyncContext retains vault key after lock/sign-out — Accepted
- **Anti-Deferral check**: acceptable risk (quantified)
- **Justification**:
  - Worst case: one spurious BG sync attempt after sign-out using a revoked token; fails with authenticationRequired and does not reschedule. No data written, nothing exfiltrated. The key also remains in the pre-existing `@State currentVaultKey` (equal exposure — the new code is not worse than the established pattern).
  - Likelihood: low (requires sign-out with a pending BGTask inside its ~15-min window).
  - Cost to fix: requires a new onVaultLocked/onSignOut callback chain from RootView to the App plus clearing BOTH holders; touches the passkey-ceremony lifecycle this branch just stabilized — regression risk exceeds the marginal gain.
- **Orchestrator sign-off**: accepted. Tracked: TODO(ios-codebase-review): clear BackgroundSyncContext + App vault-key @State on lock/sign-out when an onVaultLocked callback is introduced.
- Security expert: escalate: false (equal to pre-existing pattern).

### A1/A2 (informational): 600k fixture cost documented in VaultUnlockerTests comment; epochSeconds pre-1970 clamp untested (unreachable in practice — no action).

## Round 3 (incremental review of commit be17a22c)

Functionality and Security experts: No findings (full verification of the F8 rethrow, the registrar DI default, and the new tests — kind preserved verbatim, no integrity-check weakening, context carries counters/timestamps only, no PII in fixtures).

### T10 [Major]: F8 rethrow path untested — Fixed
- The existing tamper test flips a midpoint byte that lands in the HEADER blob, so the entries-blob rejection path (valid header → entries auth-tag failure → context rethrow) had zero coverage.
- Action: added `testEntriesBlobCorruption_carriesHeaderContext` (EntryCacheFileTests) — corrupts the file's last byte (always inside the entries auth tag), asserts `kind == .authtagInvalid` AND `context.observedCounter == counter` + non-nil dates. Fails without the F8 fix (helpers throw `.unavailable`). Committed as 7ad2067e.

## Round 4 (final confirmation of commit 7ad2067e)

Diff is test-only (verified via diff stat — no production code). Testing expert confirmed all four properties of the new test (deterministic entries-auth-tag corruption, genuine F8-path exercise, assertions fail without the fix, no flakiness): **No findings.** Functionality/Security scope untouched by a test-only diff; their Round-3 "No findings" verdicts stand.

**Loop terminated: all experts report No findings.**

## Round 1 verification
- xcodebuild build-for-testing: TEST BUILD SUCCEEDED
- PasswdSSOTests (unit): all passed
- PasswdSSOUITests: all passed (verifies app launch with BGTask registration in init)
- Web checks (npx vitest run / npx next build): run for completeness; no web files touched by this round

