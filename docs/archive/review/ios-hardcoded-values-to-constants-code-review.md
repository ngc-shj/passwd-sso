# Code Review: ios-hardcoded-values-to-constants
Date: 2026-06-16
Review round: 1 (converged — all three experts "No findings")

## Changes from Previous Round
Initial code review of the Phase 2 implementation (commit 8c669cd7). Diff: 25 files (21 modified + 4 new), 210 insertions / 119 deletions under `ios/`.

## Functionality Findings (Senior Software Engineer)
**No findings.** Behavior-preserving refactor verified end-to-end by value-identity reasoning + the plan's forbidden-pattern greps (all return 0 in production code).
- C1: every replaced crypto literal byte/numerically identical; `CryptoParams`/`P256Params` correct; `uncompressedPointByteCount = 1 + coordinateByteCount + coordinateByteCount` = 65 (static-let-references-static-let is valid Swift, `+` binds tighter than `..<`); SecureEnclaveKey slices reduce to `1..<33` / `33..<65`; `data[0] == uncompressedPointPrefix` types match (`UInt8`); BridgeKeyStore unified on `bridgeKeyV2Size` (Int, fits C API at alloc + `SecRandomCopyBytes`).
- C2: all `/api/` literals removed from production; builders reproduce exact interpolation; F4 fused literal handled (`"\(APIPath.passwords)?include=blob"`).
- C3: `htm:` and `httpMethod` use the SAME `HTTPMethod` constant at every site (htm==method now structural); `"DPoP"` header vs `"DPoP "` scheme preserved; residual `"DPoP"` at RootView.swift:449 is an error-message string, correctly inline.
- C4: 6 sites adopt `AppGroupContainer.loggerSubsystem`; literal gone.
- R10: 3 new Shared files import Foundation only — no cycle. No cross-batch duplicate symbols. VE2 confirmed (folder globs auto-discover new files).

## Security Findings (Security Engineer)
**No findings.** No Critical; no escalation.
- Crypto value-identity byte-identical for all touched constants (12/16/32/65/0x04/256).
- Domain-separation / versioned strings confirmed NOT in the diff: HKDF info strings (`passwd-sso-*-v1`, `rollback-flag-mac`, ecdh/team/item wrap infos), AAD scopes (PV/OV/AT/IK/OK/LW), `aadVersion`, AAD cap `0xFFFF`, `pbkdf2Iterations = 600_000`.
- Semantic separation holds: `credentialIdByteCount`, `ecdsaComponentByteCount`, `pkceRandomByteCount`, `bridgeKeyV2Size` kept distinct/file-local; every `symmetricKeyByteCount` mapping is genuine 256-bit key material.
- RS5: `VaultUnlocker.swift` KDF-iteration floor (`>= pbkdf2Iterations`) not in diff, not weakened.
- F3 (security angle): DPoP `htm` == request method preserved (same constant); `htu` still derived from the byte-identical APIPath. No secrets turned into source constants (only public protocol strings + diagnostic logger subsystem).

## Testing Findings (QA Engineer)
**No blocking findings** (T1–T5 are Info-level confirmations).
- T1: `CryptoParamsTests.swift` pins `keySizeBits==256`, `uncompressedPointByteCount==65`, `uncompressedPointPrefix==0x04` (+ the AES/symmetric counts) against independent literals — non-tautological (RT7), `@testable import Shared` matches existing tests. `keySizeBits` is the only changed constant with no prior catch (SE-only `generateDPoPKey` path, not unit-testable) — pinning it is the correct substitute (RT2).
- T2: every other changed constant is caught transitively by existing golden-vector suites (KDFTests PBKDF2 hex, TeamKeyCryptoTests ECDH/HKDF/AES-GCM round-trips, AESGCMTests).
- T3/T4 (RT1): no test modified except the additive new file; inline path/header/method fixture literals correctly stayed inline (SC-iOS-6) and now double as a drift cross-check; no mock desync, nothing made vacuous.
- T5: file-local distinct-meaning constants correctly NOT promoted; RT6 satisfied (the only new *exported* enums `CryptoParams`/`P256Params` are covered).

## Adjacent Findings
None requiring cross-routing.

## Quality Warnings
None — all observations carried file:line evidence.

## Recurring Issue Check
### Functionality expert
- R2 (constants): PASS — semantic separation honored. R3 (propagation): PASS — all planned sites in diff, all forbidden greps 0. R10 (circular import): PASS — Foundation-only. R1, R4–R9, R11–R41: N/A (pure literal→constant refactor).

### Security expert
- RS1 (auth comparison unchanged): PASS. RS5 (KDF floor preserved): PASS. R3 (crypto propagation, no divergent literal): PASS. R1–R41 / RS2–RS4: N/A.

### Testing expert
- RT1 (mock desync): PASS. RT2 (no non-unit-testable demands): PASS. RT3 (fixture inline correct): PASS. RT5 (no CI demands): PASS. RT6 (new exports covered): PASS. RT7 (tests can go red on drift): PASS. RT4 + R-series (impl/sec): N/A.

## Environment Verification Report
Phase 1 declared VE1 (Xcode/macOS build not runnable in the authoring environment) and VE2 (xcodegen folder-glob auto-discovery).
- All contract acceptance **grep gates**: `verified-local` — run by the orchestrator, all return 0 in production code (see Functionality findings).
- `xcodebuild test` (full XCTest suite incl. crypto vectors + new `CryptoParamsTests`): `blocked-deferred` — predicted by Phase 1 VE1 (no macOS toolchain). Cost-to-fix: user/CI runs one `xcodebuild test` command; worst case a missed adoption is a compile error caught immediately by that build; likelihood low (edits are mechanical literal→constant swaps, grep-verified, byte-identity confirmed by review). No code path requires runtime verification beyond what the existing suite + value-pins cover.
- VE2: confirmed — `Shared/` and `PasswdSSOTests/` use folder globs in `project.yml`; the 4 new files are auto-included, no manifest edit.

## Resolution Status
No findings to resolve. Plan review (2 functionality rounds + 1 security + 1 testing) and Phase 2 verification (contract greps + crypto byte-identity spot-check) front-loaded the issues; the code-review round confirmed clean. Awaiting `xcodebuild test` by the user/CI (VE1) as the final gate before PR.
