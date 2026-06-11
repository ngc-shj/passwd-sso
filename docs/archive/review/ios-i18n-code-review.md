# Code Review: ios-i18n

Date: 2026-06-12
Review round: 1 (converged)

## Changes from Previous Round

Initial code review. Scope: `git diff HEAD` (working tree vs the plan-draft commit
a3c9fa60) — the i18n implementation only; `main` is behind #540/#542 so `main...HEAD`
was not used. Three experts reviewed the 6 Swift conversions, both `.xcstrings`
catalogs, `LocalizationCatalogTests.swift`, pbxproj region derivation, and the
manual-test doc. **No Critical/Major findings; no security findings.** 1 functionality
Minor (fixed) + 3 testing Minor (accepted).

## Functionality Findings

**F1 — Minor — `VaultUnlockView.swift:38` default param `biometryLabel: String = "biometrics"` was a bare literal** — FIXED.
The sibling `"biometrics"` at RootView:165 was localized but the init default was not.
Latent only (the sole production caller, RootView:190, always passes an explicit
already-localized value, and the "Unlock with …" Label renders only when
`biometricUnlock != nil`). Fixed → `String(localized: "biometrics")` (reuses the existing
catalog key; no new key). Verified: 302 tests still pass.

All other functionality checks PASS: overload bindings correct (String(localized:) at
assignment/enum sites; navigationTitle & fieldRow → LocalizedStringKey; footer merged to
one literal), every catalog key exact-matches its source literal and vice-versa, all
interpolations (`%@`, positional `%1$@/%2$@` for the ext markdown key) correct, plurals
(en one+other / ja other) correct, shouldTranslate:false carve-outs correct, ja
terminology natural with Vault→保管庫 applied uniformly.

## Security Findings

No findings. Pure string relocation; no logic/auth/crypto/data-flow change. Interpolation
args unchanged from pre-change (error.localizedDescription passthrough; URL with
query/fragment stripped at parse; username/bundleID already shown). Biometric/unlock flow
byte-equivalent. No PII in catalogs/docs (placeholder URLs only). New test is keychain-free
and read-only (no #540 precondition-abort trap).

## Testing Findings

**T1 — Minor — plural-`other` guard conflates two diagnostic messages** (`LocalizationCatalogTests.swift:109-111`) — ACCEPTED (cosmetic).
**T2 — Minor — `sourceProblem` stringUnit branch double-codes "empty value"** (`:90`) — ACCEPTED (cosmetic).
**T3 — Minor — extension-bundle ja compilation not runtime-guarded** (host-only `Bundle.main` guard) — ACCEPTED (documented).

All testing point-checks PASS: the coverage test is non-vacuous (every failure path —
missing/empty/non-translated ja, missing plural shape — reaches `problems` and fails),
`#filePath` path math resolves, host-bundle ja guard is meaningful, plural shape correct,
no mocks/concurrency/keychain. Zero `Text(…+…)` concatenations remain (F8 footer merged).

## Recurring Issue Check

### Functionality expert
- R3 (host↔ext propagation): PASS — `Cancel`/`No matches` present in both catalogs; `passwd-sso` brand-literal (correctly out of ext catalog).
- R12 (every key has ja): PASS — enforced by LocalizationCatalogTests (302 green).
- R37 (natural ja, no jargon): PASS — Vault→保管庫 uniform.
- R1/R2/R4–R11/R13–R36: N/A (static-string i18n; no DB/event/migration/API change).

### Security expert
- RS1/RS2/RS3: N/A (no comparison/endpoint/input-path change).
- RS4 (PII): PASS — placeholder URLs only.
- R37: PASS.
- DB/injection/SSRF/crypto/access-control: N/A.

### Testing expert
- RT1 (mock): N/A. RT2 (testability): PASS. RT3 (vacuous): PASS — failure paths traced & reachable.
- RT4/RT5 (race/primitive): N/A. R12: N/A (no codegen).

## Resolution Status

### F1 Minor — biometryLabel default literal — FIXED
- Action: `biometryLabel: String = String(localized: "biometrics")`
- Modified: `ios/PasswdSSOApp/Views/Vault/VaultUnlockView.swift:38`
- Verified: 302 tests pass.

### T1 Minor — plural-other diagnostic conflation — Accepted
- **Anti-Deferral check**: acceptable risk (cosmetic).
- **Justification**: Worst case — a broken ja plural still FAILS the test; only the failure
  message is slightly imprecise (cannot mislead a passing run). Likelihood — low (only on an
  already-failing key). Cost to fix — ~3 LOC in test diagnostics, no behavioral gain;
  editing test logic for a message string risks regression for zero correctness benefit.
- **Orchestrator sign-off**: confirmed cosmetic; test correctness unaffected.

### T2 Minor — en value-presence double-codes "empty value" — Accepted
- **Anti-Deferral check**: acceptable risk (cosmetic).
- **Justification**: Worst case — identical failure message for "missing value key" vs
  "empty value"; both real defects are still caught. Likelihood — low. Cost to fix — minor
  readability refactor in test; no behavioral change. Left as-is to avoid churn in verified test logic.
- **Orchestrator sign-off**: confirmed cosmetic; coverage unaffected.

### T3 Minor — extension-bundle ja not runtime-guarded — Accepted
- **Anti-Deferral check**: acceptable risk, documented.
- **Justification**: Worst case — a knownRegions regression dropping `ja` from the extension
  target *only* (host unaffected) ships green. Likelihood — low: xcodegen derives regions
  per-catalog-content identically for both targets, and the extension catalog has authored
  ja; the plausible regression (host-only) IS guarded. Cost to fix — a separate
  extension-hosted test target (disproportionate). Documented in the test comment + plan C6/T6
  + manual-test step 13-16 (manual ja verification of the AutoFill UI backstops it).
- **Orchestrator sign-off**: documented scope limit; manual test covers the residual.
