# Plan Review: fill-visibility-focus-scope
Date: 2026-10-13
Review round: 3

## Changes from Previous Round
Initial review. The local LLM pre-screen (optional) was skipped.

## Round 1 findings and resolution

| ID | Expert | Severity | Finding | Resolution in plan |
|----|--------|----------|---------|--------------------|
| F1 / A1 / T7 | Func, Sec (adj), Test | Critical | Lowest matching ancestor + `resolveFillRoot` fills only the focused field (wrapper per field). | C3 climbs from the lowest match `S` to the highest ancestor where no role switches element, capped at the form. Wrapper-per-field acceptance added. |
| F2 / S6 / T10 | all | Major / Minor | Member set misses `autofill-identity-lib` local `isFieldVisible`. | Added to the member table and the deleted list. |
| F3 | Func | Major | T0 finders pick a hidden field; `accepts` then rejects it and nothing is filled. | The finders (username, focused, hinted, both OTP, twin fallback / active / hinted) filter on `isFieldVisible`. Hidden-duplicate acceptance added. |
| F4 | Func | Major | Select2 hidden native selects and opacity-0 OTP overlays would be denied. | `<select>` exemption (R1–R3, R7 only) and `transparentOk` for OTP targets, with manual scenarios 6 and 7. |
| F5 | Func | Major | Ancestor-aware admission goes stale on CSS-only reveals. | C2: one rescan on focus of a usable, visible non-member. |
| F6 | Func | Major | Layout-forcing rules on per-mutation rescans. | Per-scan `WeakMap` cache. Debouncing the cadence is SC4. |
| F7 / S4 | Func, Sec | Minor | Computed `transform` is a matrix, so the string test is dead in Chrome; the clip strings miss variants. | Transform / zoom are decided by the rect (R4). `clip` is any non-`auto` value on absolute/fixed; `clip-path` adds `inset(50%`, other shapes are listed as a bypass. |
| F8 / S2 | Func, Sec | Minor | Rule 6/7 false positives (`display:contents`, fixed escape, RTL) and misses (tiny overflow box, fixed off-viewport). | Replaced by an engine-derived clip-intersection rule (R4) plus an origin rule (R5) with a viewport bound for fixed elements. |
| F9 / T1 / T2 / T5 | Func, Test | Major | The layout stub is required (335/1723 tests fail without it); a per-element stub dies on `innerHTML` rebuilds; closed `<details>` are vacuous in jsdom. | Global prototype stub resolving `data-rect` at call time, with zero rect + `checkVisibility` false for closed `<details>`. |
| F10 / S3 | Func, Sec | Minor | A direction-blind predicate makes a hidden card number un-exclude its CVV (fill and save capture) and lets the root climb past hidden controls. | Callers split by direction. Exclusion and boundary keep the own-style `isNotSelfHidden`. Acceptances added. |
| S1 | Sec | Major | The predicate must have no layout-less early accept. | Pure AND; zero rect denies; forbidden pattern added. |
| S5 | Sec | Minor | The bypass list understates the class. | Rewritten as classes (i)–(vi), with the cut-line. |
| T3 | Test | Major | Parity by equality is vacuous. | Absolute assertions on every twin case. |
| T4 | Test | Major | Per-rule allow cases are not distinguishable. | Axis-only allow pairs listed per rule. |
| T6 | Test | Major | `isElementVisuallySafe` mocks go dead. | Removed; tests moved to the predicate. |
| T8 / T9 / T11 | Test | Minor | Fallback needs two forms; zero-rect dropdown test; red-proof scope. | Added. |

## Recurring Issue Check

### Functionality expert
- R1 OK
- R3 F3
- R10 F9
- R17 F4
- R22 F5
- R29 F1
- R42 F2
- R47 F10
- R48 F6
- R49 F8
- Others n/a

### Security expert
- R3 S6
- R10 OK
- R16 S1
- R22 S3
- R29 S4
- R34 OK
- R35 OK
- R38 OK
- R39 OK
- R40 OK
- R42 S6 (write-time re-check OK)
- R43 S3
- R47 S4 / S2
- R48 OK
- R49 S5
- R50 S1
- R51 S5
- R52 S3
- R53 OK
- RS3 OK
- RS4 OK
- Others n/a

### Testing expert
- R29 OK
- R42 T10
- RT1 T6
- RT2 OK
- RT3 OK
- RT5 T1 / T2
- RT6 OK
- RT7 T5 / T11
- RT8 OK
- RT9 T2 / T3
- RT10 T4
- Others n/a

## Round 2 findings and resolution

| ID | Expert | Severity | Finding | Resolution in plan |
|----|--------|----------|---------|--------------------|
| func N1 | Func | Critical | R4 treated `scroll` / `auto` ancestors as hard clips, so fields below the fold of a scroll container were denied. | R4 clips per axis: strict on `hidden` / `clip` / paint containment; the scrollable extent on `scroll` / `auto`. Paired acceptance and an app-shell manual scenario added. |
| func N2 | Func | Major | The role-switch climb depended on document order; focusing the earlier block climbed past the later one. | The climb also stops when a child of `P` off the anchor's path detects a role the anchor's branch holds. Mirror acceptance added. |
| func N3 | Func | Major | The own-style exclusion anchored on a hidden first card form, so the visible CVV became LOGIN-eligible. | `ccCardBlockFields` unions the blocks of both admissions, in the twin too. Acceptance added. |
| func N4 | Func | Minor | The signature had no cache. | `cache` in `opts`, scoped to one scan. |
| sec N1 | Sec | Major | The `<select>` exemption covered every identity role; a hidden DOB / postal-code select leaks through option enumeration. | `geometryExempt` is passed by role (expiry, country / state) only. DOB deny acceptance added. |
| sec N2 | Sec | Minor | `transparentOk` would reach custom fields through the shared `isTextLikeTarget`. | Dedicated `isOtpTarget`; custom-field deny acceptance added. |
| sec N3 | Sec | Minor | R4 missed paint containment; R6 checked the element only. | Both added to the ancestor walk. |
| test N1–N6 | Test | Major / Minor | jsdom fixture constraints: overflow longhands, `:checked` caching, a `checkVisibility` opacity model, select pairs, shadow stylesheets, red-proof fixtures. | "jsdom fixture rules" added to Testing; the red-proof list is extended. |

Round-2 Recurring Issue Checks: Security R29 / R47 / R49 / R52 findings above, others as round 1. Functionality R17 / R29 / R47 / R48 / R49 above. Testing RT5 / RT7 / RT9 / RT10 above.

## Round 3 findings and resolution

| ID | Expert | Severity | Finding | Resolution in plan |
|----|--------|----------|---------|--------------------|
| sec M1 | Sec | Major | Scroll-extent rule let `overflow:auto;height:0` pass, and over-denied an inner scroll pane under an outer clip. | A client size under 4px is a strict clip; otherwise the carried span is the field scrolled into the window. Bypass (iv) reworded. |
| func M1 | Func | Major | The off-path stop fired on a single duplicate-role sibling (confirm-email, split phone). | Stop only on a competing block (CC: number + 1 role; identity: ≥ 2 shared roles). Acceptance added. |
| func M2 | Func | Major | Role-based `geometryExempt` cannot apply at admission (pre-role filter). | Admission exempts every select; role restriction via step `accepts`. |
| func M3 | Func | Minor | Cache must not store option-dependent verdicts. | Raw ancestor data only. |
| test | — | — | Not re-run: round 3 changed no test-level design beyond adding stubbed `clientWidth` / `clientHeight`. | — |

## Saturation call (round 3)

- Round 3 found no design-level Critical. Its three Majors were refinements to mechanisms inside contracts that were already settled: the scroll-axis arithmetic, the threshold for the climb's stop condition, and where `geometryExempt` applies. All three are resolved in the plan.
- The remaining risk can only be found by building: whether the clip arithmetic and the climb behave correctly on real markup. Phase 2 tests and the manual scenarios settle that.
- Rounds 2 and 3 found mostly defects in the previous round's own additions, so we stop specifying and proceed to Phase 2.
- No findings are carried forward.
