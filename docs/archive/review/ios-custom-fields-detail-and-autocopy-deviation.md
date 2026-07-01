# Coding Deviation Log: ios-custom-fields-detail-and-autocopy

All five contracts (C1-C5) implemented as specified. Minor implementation
deviations below, none changing the locked contract behavior.

## D1 — `openURL` visibility (side-fix)
`@Environment(\.openURL)` in `EntryDetailView.swift` was `private`; the new
`customFieldSection` lives in the same-file `extension EntryDetailView`
(EntryDetailTypeSections.swift) and cannot access a `private` member. Removed the
`private` modifier (now internal). No behavioral change — same property, same file
scope. Required for the C3 `.url` row to open links.

## D2 — `autoCopyTotpIfEnabled` → `autoCopyAfterFill` rename + second call site
The TOTP auto-copy helper was renamed to `autoCopyAfterFill` (it now arbitrates
TOTP + custom-field copy from a single `totpToCopy(...)` computation, per C5/F3/S2).
It is called from BOTH `completePasswordFill` (picker path) AND
`completePasswordProvide` (foreground-biometric path). Updating the second call site
was not separately itemized in the plan but is required so the biometric fill path
also gets the (correctly arbitrated) custom-field copy — otherwise the two AutoFill
entry points would diverge. Verified both call sites pass through the single helper.

## D3 — `CustomFieldMaskedSection` as a standalone `private struct`
Implemented outside the `extension EntryDetailView` block, consistent with the
existing `SecretRow` standalone struct in the same file. The plan said "mirror
`SecretRow`" — `SecretRow` itself is a standalone struct, so this matches the
established pattern. Documents why it can't reuse `SecretRow` (LocalizedStringKey
header vs dynamic String label).

## D4 — date format API spelling
Plan prose used `Date.FormatStyle(date: .abbreviated).locale(...)`, implemented
exactly that. (An earlier shorthand `.date.abbreviated.locale(...)` does not exist
on `Date.formatted(_:)`.) The parse strategy is the explicit date-only
`Date.ISO8601FormatStyle().year().month().day().dateSeparator(.dash)` per F6.

## D5 — `CustomFieldDateFormatTests` annotated `@MainActor`
`formatCustomFieldDate` is a static method on the `@MainActor struct EntryDetailView`,
so the test class is `@MainActor` to satisfy Swift 6 concurrency checking.
Functionally equivalent to the plan's spec.

## Verification
- 659 tests pass (independently re-run by the orchestrator per R21, not just the
  implementing agent's report).
- Contract-conformance forbidden-pattern grep: clean in all Swift files (the only
  grep hits are the pattern *definitions* inside the plan/review markdown).
