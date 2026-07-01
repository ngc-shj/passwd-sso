# Plan Review: ios-custom-fields-detail-and-autocopy

Date: 2026-07-01
Review rounds: 2 (converged — Round 2 produced only Minor findings, all resolved)

## Round 2 Summary (verify fixes + regressions)

All Round-1 findings (F1-F5, S1-S5, T1-T7) verified RESOLVED by all three experts.
The C1 lossy-array decoder — the F1-Critical fix — was **empirically verified correct in
real Swift 6.3.1** by the functionality expert (instrumented `currentIndex` across every
element-failure shape: string/null/number/bool/nested-array/empty-object/missing-label →
bad element skipped, cursor advances by one, valid element never skipped, no infinite loop).
This refutes the T8 worry that `AnyDecodableSkip` might not advance.

Round-2 NEW findings — all Minor, all resolved:
- **S6** — stale §"Clipboard exposure" summary still said "incl. hidden / same profile as
  password" contradicting the corrected C5. FIXED: split into auto-copy (hidden excluded)
  vs explicit detail-view copy (hidden allowed, user action).
- **S7** — manual-test artifact lacked adversarial clipboard scenarios (R35 Tier-1). FIXED:
  testing strategy now mandates `ios-custom-fields-detail-and-autocopy-manual-test.md` with
  3 end-to-end clipboard rows (hidden→empty, text+TOTP→TOTP, text→clears), exercising the
  call-site wiring VC2 blocks from unit coverage.
- **F6** — C3 named `Date.FormatStyle` for *parsing*, but it's a formatter; default
  `.iso8601` rejects the stored bare `YYYY-MM-DD` so the F2 fix would silently no-op to raw
  (empirically verified). FIXED: C3 now specifies `Date.ISO8601FormatStyle().year().month().day().dateSeparator(.dash)`
  parse + `Date.FormatStyle(date:.abbreviated).locale(...)` format + UTC-fixed calendar +
  raw fallback + a ja/en parity unit test.
- **F7** — C1 `label` was `String?` in the signature but `String` in prose. FIXED: prose
  reconciled to `String?` (behaviorally safe either way, proven).
- **T8** — element-drift test double-guarded the cursor mechanics with a hang as failure
  mode. FIXED: added a dedicated element-ordering test (`["junk",{A},42,{B}]` → `["A","B"]`)
  so a cursor mis-advance fails as an assertion, not a timeout.
- **T9** — coverage scope confirmed clean (no new untested exported surface beyond T8). No action.

No Critical or Major findings remain. Plan is implementable as written. All contracts locked.

---

## Round 1 (initial review)

## Changes from Previous Round

Initial review.

## Functionality Findings

- **F1 [Critical]** — C1 tolerant-decode NOT implementable as written. A plain
  `[CustomFieldPayload]?` does NOT drop bad ARRAY ELEMENTS; `FlexibleString` only defends
  VALUE drift. A non-object element (`["junk", {…}]`, `[null, …]`) throws the whole array
  decode → whole `FullBlobPayload` decode → `try?`→nil → `detail()`==nil → entry shows
  "Couldn't decrypt this entry." Strictly worse than today (silent drop). = R40 / R10.
  **Resolved**: C1 rewritten to use an element-level lossy decoder (`LossyCustomFields`
  with custom `init(from:)` looping `unkeyedContainer` with `try?`-or-skip). Added an
  element-drift acceptance test (`["junk", null, {valid}]` → valid field survives, scalars
  intact, red if plain array used).
- **F2 [Major]** — `date` display parity gap: web renders `formatDate(value, locale)`;
  plan bucketed date as raw plain text. **Resolved**: C3 now formats `date` locale-aware
  via `Date.FormatStyle` (raw fallback on parse failure); `text`/`monthYear` stay raw.
- **F3 [Major]** — C5 `totpWillCopy` conflated "TOTP present" with "TOTP copied";
  `totpToCopy` returns nil also when generation fails, so the natural impl wrongly
  suppresses custom copy. **Resolved (merged with S2)**: C5 now mandates
  `totpWillCopy = (totpToCopy(...) != nil)` computed once at the call site, single
  arbitrated `SecureClipboard.copy`. Added "TOTP secret present but un-generatable →
  custom copies" acceptance.
- **F4 [Minor]** — date/monthYear enum cases inert vs `.text`. **Resolved** by F2 (date
  gets real formatting) + C2 `rowKind` documents date/monthYear→`.plain` for mask decision,
  date value-formatting separate in C3.
- **F5 [Minor]** — boolean must use exact `value == "true"` match (web semantics) + Yes/No
  needs catalog entries. **Resolved**: C3 pins exact-match + i18n note to add Yes/No to
  `Localizable.xcstrings` (check-first).
- Verified-correct (no finding): C2 default-arg compile safety (all call sites labeled),
  Consumer C edit round-trip (no new write path), `Section(String)` overload feasibility,
  SC3 team inheritance via `EntryBlobDecoder.detail`, F-R7 lock/disappear nil-out.
  Wording fix applied: `customFieldRows` builds rows INLINE (can't reuse `optionalFieldRow`
  which hardcodes a `LocalizedStringKey` header).

## Security Findings

- **S1 [Major]** — `hidden` custom-field auto-copy widens clipboard exposure beyond the
  TOTP norm (durable static secret vs rotating 30 s code); plan over-stated equivalence.
  No escalation. **Resolved**: C5 now EXCLUDES `hidden`-kind from auto-copy (fail-closed);
  hidden values are copied only via explicit user action on the masked detail row. Added a
  hidden-exclusion red-capable acceptance + forbidden-pattern grep key.
- **S2 [Minor]** — `totpWillCopy` must derive from the same `totpToCopy(...)` result.
  **Resolved (merged with F3)** in C5.
- **S3 [Minor]** — `customFieldRows` must route `hidden` unconditionally to the masked row,
  never fall through to plain on empty/object-typed value. **Resolved**: C3 invariant +
  forbidden-pattern.
- **S4 [Minor, confirm-and-hold]** — user `label` bound as `String` (non-localizing) avoids
  i18n-key/format-string injection; copy toast stays literal; no a11y label embeds the
  secret. **Reflected** in C3 invariants.
- **S5 [Minor, confirm-and-hold]** — `type`/`kind` selects only a renderer, never a
  crypto/authz primitive; `.unknown→.text` fail-open is display-only; `count==1` guard
  prevents index abuse. **Held** (no plan change needed; RS5 clean).
- **R39 verdict: CLEAN** — new `customFields` lives in `VaultEntryDetail`, inherits the
  existing nil-out on lock / sign-out / disappear; AutoFill holds `detail` only as a local
  `let`; vault key zeroed; no new retained secret holder. Only the clipboard outlives
  teardown (bounded by `clearAfter`) → addressed by S1.
- **R28 [Minor, accepted]** — no cap on rendered customFields count. Worst case: UI jank on
  a hostile own-vault blob; Likelihood: low (own authenticated data, web caps field count
  at form time); Cost to fix: low but not worth a guard for self-owned data. Accepted as
  an informational note.

## Testing Findings

- **T1 [Critical]** — C5 helper placed in the extension target, but `PasswdSSOTests` links
  only `Shared`+`PasswdSSOApp` (project.yml:205-236); the helper is unreachable from XCTest.
  = R42 cross-target visibility. **Resolved**: C5 moves `customFieldToCopy` to
  `ios/Shared/AutoFill/CustomFieldAutoCopy.swift` (public free function, mirroring
  `totpToCopy`); tests use `@testable import Shared`.
- **T2 [Major]** — C5 truth table not red-capable for arbitration: need a paired
  fixed-detail/varying-`totpWillCopy` assertion. **Resolved**: C5 acceptance adds the
  arbitration pair + (per S1) the hidden-exclusion row, both red-capable.
- **T3 [Major]** — C1 golden fidelity: must author against the real producer
  (`EntryBlobGoldenPayloadTests`, raw JSON), not `CredentialResolverTests.TestFullBlob`
  (synthetic; can't emit numeric/junk value). = RT1. **Resolved**: testing strategy + C1
  acceptance retargeted; absent-key case omits the key (not `[]`).
- **T4 [Major]** — C1 drift test vacuous unless it asserts surviving LOGIN scalars on a
  drifted blob. = RT7. **Resolved**: C1 value-drift acceptance asserts `detail` non-nil AND
  `password == "s3cr3t"` AND drifted `.value == ""`.
- **T5 [Minor]** — F-R6 edit-preservation duplicates `PersonalEntryBlobBuilderTests` Case 3;
  not independently red-capable. **Resolved**: reframed as a thin pin reusing Case 3.
- **T6 [Minor, security-adjacent]** — require extracting `CustomFieldKind.rowKind` and
  unit-testing it; `hidden→masked` is the one security-relevant primitive otherwise
  untested. **Resolved**: C2 adds `CustomFieldRowKind` + `rowKind`; C2/testing add the
  red-capable mapping test.
- **T7 [Minor]** — C4 needs the literal-key pin + cross-store-same-suite test. **Resolved**:
  C4 acceptance extended.
- **RT2** avoided well — VC1/VC2 untestable surfaces correctly left to manual; no over-reach.

## Adjacent Findings

- F5 (Yes/No catalog) routed to i18n/test scope — reflected in C3 i18n note.
- T6 flagged the `hidden→masked` mapping as security-adjacent — routed into the model
  contract (C2) so the security primitive is unit-tested.

## Quality Warnings

None — all findings carried file:line evidence and concrete fixes.

## Recurring Issue Check

### Functionality expert
- R1 OK (reuses FlexibleString/SafeURL/SecureClipboard/totpToCopy/SecretRow idioms; wording
  fix: rows built inline). R3 OK (single decode SSoT feeds host/AutoFill/team). R10 violated
  by F1 → fixed. R12 OK (CustomFieldKind covers all 6 + unknown→.text). R19/R25 OK
  (read-only model; edits stay on raw-JSON preserve path). R39 OK. R40 = crux of F1 → fixed.
  R41 OK (every kind has a render path). R2/R4-R9/R11/R13-R18/R20-R38/R42 N/A.

### Security expert
- R1-R38 per S-report: R10 (fixed via F1), R12 PASS, R14 confirm-no-log, R16 a11y (S4),
  R25 PASS (flag persist/hydrate symmetric), R28 Minor accepted, R39 PASS, R40 PARTIAL→S1
  fixed. RS1 PASS (decrypt gated by unlock). RS2 PASS (display-only, no new serialize).
  RS3 PASS (tolerant decode drops label-less, FlexibleString neutralizes drift). RS4 PASS
  (plan uses placeholder field names, no PII/secrets). RS5 PASS (type/kind never feeds
  crypto/authz). RS1 no Critical, nothing to escalate.

### Testing expert
- R42 VIOLATED (T1) → fixed. RT1 at-risk (T3) → fixed. RT2 avoided. RT3/RT4 OK. RT5 → T4.
  RT6 (new exports) → covered once T1/T6 adopted → fixed. RT7 at-risk (T2,T4) → fixed.
  RT8 (F-R6 dup) → T5 reframed as pin. R1-R41 per T-report mostly OK; R12 type-drift →
  T3/T4; R40/R42 → T1.
