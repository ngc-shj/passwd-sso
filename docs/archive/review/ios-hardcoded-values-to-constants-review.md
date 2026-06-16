# Plan Review: ios-hardcoded-values-to-constants
Date: 2026-06-16
Review rounds: Functionality ×2, Security ×1, Testing ×1

## Changes from Previous Round
Initial review (R1) for all three experts; Functionality R2 confirmed all R1 Major findings resolved with no new findings.

## Functionality Findings (Senior Software Engineer)

- **F1 [Major] — SPKIEncoder.swift uncompressed-point duplication missed.** `Shared/Crypto/SPKIEncoder.swift:31-32` validates `count == 65` / `== 0x04` — the same uncompressed EC-point values C1 centralizes (`P256Params.uncompressedPointByteCount` / `.uncompressedPointPrefix`) — but was absent from the inventory and the acceptance grep was file-scoped to `SecureEnclaveKey.swift`. **Resolved**: added to C1 adoption; the `65`/`0x04` forbidden grep broadened to `Shared/Crypto/` (`== 65\|\[0x04\]\|== 0x04`), which matches the 3 real EC-point sites and correctly excludes the WebAuthn UV-flag `= 0x04` declarations.
- **F2 [Major] — BridgeKeyStore bridge-key length spelled 3 ways.** `bridgeKeyV2Size = 32` (:22, the read-path validator at :237), allocation `count: 32` (:129), random-fill `32` (:134). **Resolved**: unify create-path (:129, :134) onto the existing `bridgeKeyV2Size`; keep storage-layout sizes (`bridgeKeyV2Size`/`bridgeMetaV2Size`/`legacyBridgeKeyBlobSize`) file-local (NOT `CryptoParams.symmetricKeyByteCount`). R2 confirmed `bridgeKeyV2Size` is the read-path validator, so create/read symmetry is preserved.
- **F3 [Major] — `htm:` DPoP-proof method literals missed by the method grep.** Each request passes the method twice: `httpMethod = "POST"` AND `htm: "POST"` to `buildDPoPProof`; the two MUST stay equal (server validates the DPoP `htm` claim). The `httpMethod =` grep cannot see `htm: "POST"`. **Resolved**: C3 adoption now covers both sites (13 in MobileAPIClient + EntryUploader:114), states the `htm == httpMethod` invariant, and adds a `htm: "(POST|GET|PUT)"` forbidden grep.
- **F4 [Minor] — fused path+query literal.** `EntryFetcher.swift:157` `"/api/passwords?include=blob"`. **Resolved**: adopt `"\(APIPath.passwords)?include=blob"`.
- **F5 [Minor] — TeamKeyCrypto x963 prefix.** `:68` `Data([0x04])` is the same uncompressed-point marker. **Resolved**: fold to `Data([P256Params.uncompressedPointPrefix])` (covered by the F1 grep).

Verified-correct (no finding): EC slice arithmetic reproduces `1..<33`/`33..<65`; C1 semantic separation of the distinct `32`s is correct; full C2 path inventory + builder interpolation byte-identical; C3 `"DPoP"` vs `"DPoP "` distinction; C4 exactly 6 subsystem sites; VE2 xcodegen folder-glob confirmed (no project.yml edit needed); no module cycles in the new Shared files.

R2 result: **No findings** — all F1–F5 closed, no residue, completeness re-sweep of `Shared/Crypto` + network files found nothing new.

## Security Findings (Security Engineer)

**No findings.** Value-identity verified byte-identical for every security-relevant constant (AES-GCM nonce 12 / tag 16, key length 32, P-256 coordinate 32, uncompressed point 65 / 0x04, key-size bits 256; `pbkdf2Iterations` left in place). Domain-separation / versioned strings (HKDF info strings, AAD scope strings `PV/OV/AT/IK/OK/LW`, `aadVersion`, AAD field cap `0xFFFF`) confirmed EXCLUDED. RS5 anti-downgrade floor `kdfIterations >= pbkdf2Iterations` (`VaultUnlocker.swift:99`) not in scope, not weakened. No secret/key/token VALUES turned into source constants. Import boundary unchanged (new files `Foundation`-only in `Shared/`). Endorsement (adopted via T5): pin the vector-uncovered crypto constants in a test.

## Testing Findings (QA Engineer)

All Minor; incorporated:
- **T1** — `SecureEnclaveKey.swift:32 keySizeBits` is in a Secure-Enclave path not runnable in the simulator / not exercised by any unit test. Plan now notes it as compile-only + value-pin guard, not "test-guarded".
- **T3 / SC-iOS-6** — per-site verdict: the iOS suite has ZERO tests asserting a production-owned numeric constant (`expiresIn`/`addingTimeInterval` are arbitrary inputs; mock `kdfIterations: 600000` is a server-response field the client reads, never compares). SC-iOS-6 reworded to "leave all test literals inline."
- **T4 / RT1** — mock response shapes stay in sync; the tests' hardcoded `"Authorization"`/`"/api/..."` literals double as an independent C2/C3 drift cross-check (reason to keep inline).
- **T5 / RT7** — value-pin test made **required** for the 3 vector-uncovered constants (`P256Params.keySizeBits`, `.uncompressedPointByteCount`, `.uncompressedPointPrefix`); optional/decorative for AES/symmetric constants (already pinned transitively by `KDFTests`/`AADParityTests`/`TeamKeyCryptoTests`).
- **T6** — C2 grep prose fixed (test target is outside the grepped dirs).
- **T2, T7** — no plan change (grep-gate routing acknowledged; spot-check `EntryFetcherTests`/`HostSyncServiceTests` during Phase 2).

## Adjacent Findings
None requiring cross-routing (F-series stayed within functionality scope; T-series within testing).

## Quality Warnings
None (all findings carried file:line evidence and concrete fixes).

## Recurring Issue Check

### Functionality expert
- R2 (constants centralization): R1 PARTIAL (F1/F2/F3/F5 missed sites) → R2 CLEAN after fixes.
- R3 (propagation / all call sites): R1 PARTIAL (file-scoped greps under-covered) → R2 CLEAN (greps broadened to `Shared/Crypto/`, htm: + fused-literal sites added).
- R10 (circular dependency, new Shared files): OK — `Foundation`-only.
- R25 (persist/hydrate symmetry): OK — no storage-key string values moved; values byte-identical.
- R1, R4–R9, R11–R24, R26–R41: N/A (Swift constant-extraction refactor; no DB/events/migrations/i18n/UI-state).

### Security expert
- R3 (propagation): PASS. R4 (no secret values): PASS. R5 (input validation guards unchanged): PASS.
- RS1 (authn/authz untouched): PASS. RS3 (crypto misuse — no algo/mode change): PASS. RS4 (no key-material logging): PASS. RS5 (server-param floor preserved): PASS.
- RS2, R1–R2, R6–R41 (excl. above): N/A.

### Testing expert
- RT1 (mock consistency): PASS. RT2 (no non-unit-testable test demands): honored. RT3/SC-iOS-6 (fixture vs constant): PASS. RT5 (test path includes primitive): PASS except SE-only site, routed to compile+pin. RT7 (value-pins can go red): PASS.
- RT4, RT6, R-rules not listed: N/A.
