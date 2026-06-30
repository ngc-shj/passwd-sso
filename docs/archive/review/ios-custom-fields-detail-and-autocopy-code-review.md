# Code Review: ios-custom-fields-detail-and-autocopy

Date: 2026-07-01
Review rounds: 2 (converged — Round 2 returned No findings from both functionality
and security experts)

## Round 2 Summary (verify fixes)

Functionality + security experts re-reviewed the Round-1 fix commit (b452a5f4).
**Both returned "No findings."**
- **F1 RESOLVED** — toggle → `store.autoCopyCustomField` → App-Group UserDefaults →
  extension reads it → `customFieldToCopy`; reachable end-to-end. Footer messaging
  accurate. Mirrors `autoCopyTotpSelection` (incl. `recordActivity()`).
- **F2 RESOLVED** — `Date.FormatStyle(date:locale:timeZone:UTC)` is the correct
  initializer (compiles; the fluent `.timeZone()` Symbol form was the first-attempt
  compile error, fixed); day-shift gone; test now red-capable for the exact day.
- **F3 RESOLVED** — `.boolean` excluded from auto-copy alongside `.hidden`.
- Regressions: none. Arbitration intact (TOTP still wins), opt-in still default-off
  (fail-closed), no new retained secret holder, no new exposure beyond plan-review S1's
  approved surface, catalog strings carry no PII/secret (RS4).
- T1/T2 (test cleanups) verified green by the orchestrator's R21 re-run (659 tests).

659 tests pass (orchestrator re-run, twice — once caught a first-attempt UTC compile
error in the F2 fix, which was then corrected). All findings resolved.

Note: the `Localizable.xcstrings` Round-1 fix produced a large line-diff due to an
alphabetical key re-sort; content integrity was verified (exactly 2 keys added, 0 removed,
0 existing values changed).

---

## Round 1

## Changes from Previous Round

Initial code review (Phase 3) of the committed implementation diff
(`git diff origin/main...HEAD`).

## Functionality Findings

- **F1 [Major] — C5 auto-copy was unreachable (no Settings toggle)**: `autoCopyCustomField`
  defaults fail-closed to `false`; the AutoFill extension reads it but no UI ever set it,
  so `customFieldToCopy(autoCopy: false, …)` always returned nil — the headline "copy a
  single non-hidden field after AutoFill" was dead code in a shipped build. The plan's C4
  specified only the storage flag and never itemized a Settings toggle (a consumer-flow
  gap the Phase-1 walkthrough missed). **FIXED**: added `autoCopyCustomFieldSelection`
  binding + `Toggle("Auto-copy custom field after fill")` to the Clipboard section of
  `SettingsView.swift`, mirroring `autoCopyTotpSelection`; footer explains hidden fields
  are never auto-copied and TOTP takes clipboard priority. New strings added to
  `Localizable.xcstrings` (en + ja).
- **F2 [Minor] — date formatted in device TZ, not UTC (one-day shift in negative-UTC
  zones)**: `formatCustomFieldDate` parsed "YYYY-MM-DD" as UTC midnight but
  `Date.FormatStyle` defaults to `TimeZone.autoupdatingCurrent`, so US-Pacific would render
  July 1 → "Jun 30". The comment + test claimed UTC-pinning falsely (test only checked
  `contains("2026")`). **FIXED**: pinned the FormatStyle to UTC
  (`.timeZone(TimeZone(identifier:"UTC") ?? .gmt)`) so the rendered day matches the stored
  day everywhere; strengthened the test to assert "Jul"/"1" and NOT "Jun"/"30".
- **F3 [Minor] — lone boolean field auto-copied literal "true"/"false"**: the C5 helper
  excluded only `.hidden`, so a single `boolean` custom field would auto-copy "true" — but
  the detail view treats booleans as non-copyable (no copy button), so the two disagreed.
  **FIXED**: added `field.kind != .boolean` to the helper's guard + a red-capable
  `testBooleanField_returnsNil`.
- Verified clean: `enumerated()` runs after `.filter` (contiguous ids); arbitration computes
  `totpCode` once and passes `totpWillCopy: totpCode != nil` (no clobber, generation-failure
  doesn't suppress custom copy); both AutoFill entry points route through `autoCopyAfterFill`;
  `.url` mirrors the existing `urlRow`; all three decode paths (VaultViewModel,
  TeamEntryDecryptor, CredentialResolver) funnel through `EntryBlobDecoder.detail` (no
  bypass; team entries inherit). `LossyCustomFields` skip logic confirmed sound.

## Security Findings

**No findings.** All seven verification points confirmed in the actual code: hidden never
auto-copied (guard fires even at count==1 and on empty value); hidden always masked (only
path to `.masked`, exhaustive switch); R39 zeroization intact (no new retained holder; the
AutoFill extension uses a local `let`, never caches `detail`); clipboard uses
`SecureClipboard.copy(.localOnly, clearAfter:)` identical to password/TOTP; user `label`
binds the `String` Section overload (no format-string/i18n-key injection); no secret
logging; the `openURL` private→internal deviation is display-only and `SafeURL.launchable`
restricts to http/https. RS3/RS4: committed docs use synthetic placeholders only.

## Testing Findings

- **T1 [Minor] — no-op `XCTAssertNotNil(d)` on a non-Optional**: in
  `EntryBlobGoldenPayloadTests` the `decode` helper already `XCTUnwrap`s, so the assertion
  was decorative (the real survival guard is `password == "s3cr3t"`). **FIXED**: removed the
  no-op, added a comment naming the load-bearing assertion.
- **T2 [Minor] — duplicate arbitration test**: `testArbitration_totpWillCopyFalse_returnsValue`
  was byte-identical to `testSingleTextField_totpWillCopyFalse_returnsValue`. **FIXED**:
  dropped the duplicate; the arbitration pair is now `testSingleTextField…` (false→value) +
  `testArbitration_totpWillCopyTrue_returnsNil` (true→nil).
- Verified red-capable (traced through the decode/throw path): C1 value-drift + element-drift
  + ordering; C5 truth table incl. arbitration pair + hidden exclusion; C2 `hidden→.masked`;
  C3 date no-op-catch; C4 four facets incl. literal-key pin; F-R6 byte-equal pin. Every new
  exported symbol has a test path. No vacuous patterns, no async/mock-shape issues.

## Adjacent Findings

- (Testing→Func) `.url`/`.plain` rows have near-identical inline copy-button HStacks (DRY
  observation, VC2-untestable, no action). Accepted as-is — each row's structure differs
  enough (url has the tappable link branch) that extracting a shared helper would add
  indirection without clear benefit; consistent with the existing per-type-section style.

## Quality Warnings

None — all findings carried file:line evidence and concrete fixes.

## Environment Verification Report

Per the Phase-1 `Verification environment constraints`:
- **VC1 (form-fill into third-party apps)**: `blocked-permanently` — OS limit, out of scope
  (SC1). Not applicable to verification (the design works around it).
- **VC2 (AutoFill UI + clipboard write under test)**: the pure decision helper
  (`customFieldToCopy`), decode, rowKind, settings flag, and date format are
  `verified-local` (re-run by the orchestrator, 660 tests pass). The actual clipboard write
  + `completeRequest` handshake remain `blocked-deferred` to the device manual-test
  artifact (`ios-custom-fields-detail-and-autocopy-manual-test.md`, present in the diff,
  with the three adversarial clipboard scenarios per S7). Linked to the VC2 Phase-1 entry;
  no un-justified skip.

## Recurring Issue Check

### Functionality expert
- R1: FAIL→F1 (fixed — consumer wiring now complete). R10: PARTIAL→F2/F3 (web parity:
  date TZ fixed to UTC; boolean auto-copy aligned to no-copy). R14: FAIL→F2 (fixed). R19:
  FAIL→F1 (unreachable C5 path; fixed). R12/R16 OK (exhaustive enums, fail-open .text).
  R40 OK (hidden excluded, no double-copy, clearAfter). R41 OK (single decode SSoT). R42
  OK (helper in Shared). Remaining R-rules N/A.

### Security expert
- R1-R42 + RS1-RS5 all OK/N/A. R39 (zeroization) PASS, R40 (clipboard exposure) PASS
  (hidden excluded), RS3/RS4 (committed-artifact PII/secrets) PASS (synthetic placeholders).
  No Critical, nothing to escalate.

### Testing expert
- RT1 (golden=producer) PASS, RT3 (regression red on revert) PASS, RT4 ⚠→T1 (no-op
  assertion, fixed; invariant still guarded), RT7 (red-capable) PASS, RT8 (cursor as
  assertion not hang) PASS. R40/R41/R42 OK.

## Resolution Status

### F1 [Major] C5 unreachable — no Settings toggle
- Action: added `autoCopyCustomFieldSelection` binding + Toggle in the Clipboard section;
  footer copy; en+ja catalog strings.
- Modified: `ios/PasswdSSOApp/Views/SettingsView.swift`, `ios/PasswdSSOApp/Localizable.xcstrings`

### F2 [Minor] date day-shift in non-UTC zones
- Action: pinned `Date.FormatStyle` to UTC; strengthened the test to assert the exact day.
- Modified: `ios/PasswdSSOApp/Views/Vault/EntryDetailTypeSections.swift`,
  `ios/PasswdSSOTests/CustomFieldDateFormatTests.swift`

### F3 [Minor] boolean auto-copied
- Action: excluded `.boolean` from `customFieldToCopy`; added `testBooleanField_returnsNil`.
- Modified: `ios/Shared/AutoFill/CustomFieldAutoCopy.swift`,
  `ios/PasswdSSOTests/CustomFieldTests.swift`

### T1 [Minor] no-op assertion
- Action: removed the decorative `XCTAssertNotNil(d)`.
- Modified: `ios/PasswdSSOTests/EntryBlobGoldenPayloadTests.swift`

### T2 [Minor] duplicate test
- Action: dropped `testArbitration_totpWillCopyFalse_returnsValue`.
- Modified: `ios/PasswdSSOTests/CustomFieldTests.swift`
