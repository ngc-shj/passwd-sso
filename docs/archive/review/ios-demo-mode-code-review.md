# Code Review: ios-demo-mode
Date: 2026-06-26
Review rounds: 2 (all findings resolved)

## Round 2 (incremental verification)
Reviewed the Round-1 fix commit (4eec0a42). **No findings.** Verified: all three
source-reading gate tests switched to `#filePath` + non-swallowing `try` (no
remaining `#file`/`try?`-swallow in the test dir); no sibling bug-class
recurrence (the only other source-reading gate, `LocalizationCatalogTests`, was
already correct); the manual-test artifact is present and complete with the NFR1
residue check; prove-red capability confirmed (path resolves to real files, the
`source.contains` assertion can now fail). Review loop terminates.

## Changes from Previous Round
Initial code review of the Phase 2 implementation (commit c7ddf9ba).

## Functionality Findings
- **[F1] Minor** — Grep-gate tests pass vacuously if the source file is unreadable (`guard let source = try? ... else { return }`). Same root as T1 below; resolved by T1's fix.
- **[F2] Minor** — `testDemoPresentationFlags_allFalse` asserts the value type but not that `DemoVaultView` consumes the flags. Wiring verified correct in source (`DemoVaultView` reads `presentation.showsFavicons`/`exitLabel`, no parallel hardcoded copy). No snapshot harness exists to assert rendered output (RT2). Accepted: the now-non-vacuous grep gate (T1 fixed) proves `DemoVaultView` constructs no `FaviconLoader`, which structurally backs `showsFavicons=false`. Documented, not separately fixed.
- All 6 functionality focus areas verified PASS: read-only seam preserves live behavior (live call sites pass all 3 deps explicitly), `.onChange(of: autoLockService?.state)` correct for nil/non-nil, edit sheet appears in live only, DemoVaultView renders 9 entries via shared `categoryCounts`/`VaultCategory`, `try? makeDemoVault()` acceptable (throws only on deterministic fixture errors), checklist fully covered.

## Security Findings
- **No findings.** NFR1 (isolation) and NFR2 (no network) hold structurally: `DemoVaultFactory` writes nothing; `DemoVaultView` holds no apiClient/hostSyncService/autoLockService/FaviconLoader. Favicon path dead (showFavicons=false → EntryIconView builds no FaviconImageView). No QuickType seeding (CredentialIdentityRegistrar only on live `.vaultUnlocked`). NFR3 sample data all fake (RFC 2606 domains, published TOTP seed, placeholder SSH key, fake passkey credentialId). `docs/assets/passwd-sso.json` not in any Copy-Resources phase. `AppSettingsStore().clipboardClearSeconds` read in the reused detail copy path is a fail-closed READ, not a write — no contamination (accepted, plan §C3 F8/S8). No PII in diff/plan (RS4). Demo exit never calls `DebugVaultLoader.reset()` (R31).

## Testing Findings
- **[T1] Critical (RESOLVED)** — The three source-reading gate tests (`testForbiddenPatternsAbsent_inDemoVaultFactory`, `…_inDemoVaultView`, `testSampleDataUsesReservedDomainsOnly`) passed VACUOUSLY under Swift 6. Empirically verified: `swiftc -swift-version 6` makes `#file` the concise `<module>/<basename>` form (not absolute), so `URL(fileURLWithPath: #file)` + two `deletingLastPathComponent()` resolved to a non-existent path; `try? ... else { return }` swallowed the failed read and the test passed with ZERO assertions. The isolation grep gates — the plan's central falsifiable NFR1 proof — were decorative. Fix: switch to `#filePath` (always absolute) + non-swallowing `try String(contentsOf:)`, mirroring the codebase's own `LocalizationCatalogTests` idiom; added a `matches.count > 0` guard to the domain test. **Prove-red executed**: injecting `FaviconLoader` into `DemoVaultFactory.swift` now makes the gate FAIL (`** TEST FAILED **`), reverted clean. The gate is now genuinely falsifiable.
- **[T2] Minor (accepted)** — Second LOGIN fixture (GitHub, non-TOTP) has no dedicated detail assertion; covered transitively by `count==9`. Per-type matrix otherwise complete. Not worth a dedicated test.
- **[T7] Major (RESOLVED)** — The promised manual-test artifact `ios-demo-mode-manual-test.md` (R35 Tier-1 UI surface) was missing — the only runtime verification of the NFR1 residue invariant against a REAL shared container. Created `docs/archive/review/ios-demo-mode-manual-test.md` with Pre-conditions / Steps (discoverability + iPad-compat render + all-8-type browse + TOTP + the cache-mtime/favicon-dir/QuickType-count residue check) / Expected / Rollback.
- RT1 confirmed: C1 tests drive the REAL decrypt path (`loadFromCache`/`loadDetail`), not the bare plaintext decoder — AAD/key/userId drift would be caught.

## Adjacent Findings
- F1 (functionality) ↔ T1 (testing): same root cause (#file + swallowed read). Routed to testing, fixed once.

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
R3 (gate propagation): PASS — showFavicons:false reaches EntryIconView in detail + search-row + category-row. R25/R39 (residue/ephemeral key): PASS — ARC-freed, no disk/Keychain write. R41 (capability backing): PARTIAL → F2 (flags drive the view in source; test gap accepted, grep gate backs it). Others N/A.

### Security expert
R31 (destructive on exit): PASS — no DebugVaultLoader.reset(). R39 (zeroization): PASS. RS4 (PII): PASS. RS1-RS3/RS5: N/A (no credential compare, no routes, no external crypto params). Others N/A.

### Testing expert
RT1: PASS (real decrypt path). RT2: PASS (DemoVaultView left to predicate + grep, no untestable snapshot demanded). RT6: PARTIAL → resolved via T1 (grep gate now real) + accepted F2. RT7: was FAIL (T1) → now PASS, prove-red executed. RT4: N/A.

## Environment Verification Report
Per the plan's Phase-1 `Verification environment constraints`:
- **VEC1 (iPad-compat render)**: `verified-local` pending — the manual-test artifact (now present) step A covers it; to be executed by operator on an iPad simulator. Recorded in `ios-demo-mode-manual-test.md`.
- **VEC2 (real App Store review outcome)**: `blocked-deferred` — predicted in Phase 1; only re-submission confirms. Anti-Deferral justification recorded in the plan.
- **VEC3 (QuickType positive path)**: `blocked-deferred` — simulator cannot select a third-party AutoFill provider. The NEGATIVE invariant (demo registers no identities) is `verified-local` via the now-non-vacuous grep gate + manual residue step 8.

## Resolution Status
### T1 Critical — vacuous grep gates under Swift 6
- Action: `#file` → `#filePath`; `try? … else { return }` → `try String(contentsOf:)`; added `matches.count > 0` guard. Prove-red executed (gate fails on injected `FaviconLoader`, reverted).
- Modified: ios/PasswdSSOTests/DemoModeStateTests.swift:57-99, ios/PasswdSSOTests/DemoVaultFactoryTests.swift:182-203

### T7 Major — missing manual-test artifact
- Action: created the R35 Tier-1 manual test plan.
- Modified: docs/archive/review/ios-demo-mode-manual-test.md (new)

### F1 Minor — folded into T1.
### F2 Minor — accepted (grep gate backs the favicon-severance; no snapshot harness for view-consumes-flag).
### T2 Minor — accepted (non-TOTP login covered transitively).

All Critical/Major resolved. Full suite: 631 tests pass.
