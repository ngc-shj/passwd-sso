# Code Review: ios-quota-exceeded-message

Date: 2026-06-14
Review round: 1

## Changes from Previous Round

Initial Phase 3 code review (3 expert agents) of the implemented diff
(`MobileAPIClient.swift`, `EntryEditForm.swift`, `Localizable.xcstrings`, 3 test files).

## Functionality Findings

- **F1 (Minor) — missing in-code TODO anchor**: the plan's Considerations specify a grep-able
  `TODO(ios-quota-exceeded-message)` marker for the deferred S1 follow-up (`MobileAPIError: LocalizedError`),
  but it was not present in code (the deviation log is reviewed once and does not survive as a trigger).
  → RESOLVED: added the TODO comment above `EntryForm.saveErrorMessage(for:)`.
- Verified clean: C1-C5 all implemented as locked; C2 `try?` fall-through on empty/malformed bodies; body-code
  (not status) detection; 401-retry path covered; no exhaustive `switch` over `MobileAPIError` (only a single
  `if case .networkError`); C4 both keys translated, old `"Save failed: %@"` removed.

## Security Findings

- **No findings.** S1 confirmed closed (else branch returns a static localized string, zero
  `localizedDescription` interpolation). New catalog strings jargon-free (R37). `decodeBodyResponse` body parse
  is bounded, `try?`-guarded, value used only in an exact `==` and never rendered/logged. 403→quotaExceeded does
  not mask genuine authz failures (FORBIDDEN → serverError). Test fixtures synthetic only (RS4 clean).
  escalate: false.

## Testing Findings

- **T1 (Minor) — equality assertion weaker than it looks**: in en locale a deleted catalog key makes both sides
  fall back to the key literal, so `quota == expectedQuota` could pass vacuously. → RESOLVED: added
  `generic == expectedGeneric` (T6) and rely on `quota != generic` (locale-robust branch-selection proof) plus
  `LocalizationCatalogTests` (independently guarantees both keys exist + ja translated). A locale-fragile
  `contains("item limit")` sentinel was considered and rejected (breaks when the simulator runs non-en).
- **T6 [Adjacent] (Minor) — generic message text unasserted**: → RESOLVED by the `generic == expectedGeneric`
  assertion above.
- **T2 (informational) — stub fires once**: documented with a comment on `stubCreate` (createEntry retries only
  on 401).
- Verified clean (RT1/RT2): 4 MobileAPIClientTests use real JSON bodies + seed access tokens + assert exact
  case; VM propagation test returns 403 immediately and asserts `.quotaExceeded`; helper is `nonisolated static`
  → directly callable from XCTest.

## Adjacent Findings

- T6 (testing→functionality boundary) — merged into the EntryFormTests fix above.

## Quality Warnings

None.

## Recurring Issue Check

### Functionality expert
- R3: clean (no internal error interpolation into UI). R19: clean (no exhaustive switch over MobileAPIError).
  R37: clean (catalog strings jargon-free). R1-R2,R4-R18,R20-R36: N/A (client-only Swift change).

### Security expert
- R37: clean. RS4: clean (synthetic fixtures). R3/R19/R25: clean. RS1-RS3 + all other R*: N/A.

### Testing expert
- RT1: satisfied (real wire-shape bodies; empty/malformed edge cases modeled). RT2: satisfied (nonisolated
  static, no MainActor dispatch). RT3-RT5: N/A. R*: N/A.

## Resolution Status

### F1 Minor — missing TODO anchor
- Action: added `// TODO(ios-quota-exceeded-message): consider MobileAPIError: LocalizedError ...` above the helper.
- Modified file: ios/PasswdSSOApp/Views/Vault/EntryEditForm.swift (saveErrorMessage doc block).

### T1 / T6 Minor — test assertion strength
- Action: added `XCTAssertEqual(generic, expectedGeneric)`; kept locale-robust `quota != generic`; documented
  reliance on LocalizationCatalogTests for catalog presence.
- Modified file: ios/PasswdSSOTests/EntryFormTests.swift.

### T2 Informational — stub-fires-once
- Action: clarifying comment added.
- Modified file: ios/PasswdSSOTests/MobileAPIClientTests.swift (stubCreate).

## Tightening-only skip — Round 1
Findings applied directly (no Round 2 review):
- [F1] [Minor] missing TODO anchor — EntryEditForm.swift — applied verbatim (comment only)
- [T1/T6] [Minor] test assertion strength — EntryFormTests.swift — test-only, within round-1 fix scope
- [T2] [Informational] stub comment — MobileAPIClientTests.swift — comment only

Justification: every finding is inline-minor (comment text / test-assertion), scoped within the round-1 change,
and touches no security boundary (production behavior unchanged by all three fixes). Re-verified by full suite:
468 unit + 2 UI tests green, TEST BUILD SUCCEEDED, no crashes.

All findings resolved. No open findings.
