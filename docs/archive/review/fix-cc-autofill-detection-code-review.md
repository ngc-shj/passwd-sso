# Code Review: fix-cc-autofill-detection

Date: 2026-07-12
Review rounds: 2

## Round 1 — Initial review

### Changes from Previous Round
Initial code review on top of the Phase 2 self-R-check baseline (which returned No findings across all three perspectives).

### Functionality Findings
No findings. Verified: C4 exclusion includes expiryCombined + null-guard; both detectors pure + same-root snapshot (no staleness); mixed-page + fieldCount fixtures pass; normalizeYearValue edge cases ("-5","0","05","100","999") pass-through safe; all checklist + 5 test trees in diff; no import cycle; build + 884 tests pass; C6 pins full .toString() + negative + guard line.
- Seed disposition: **Rejected** — the [Major] "2030 won't match option 30" seed was a false alarm; `normalizeYearValue` normalizes BOTH sides ("2030"→"2030", "30"→"2030"); autofill-cc.test.ts 12/12 pass. Seed misread which side is normalized and did not run the test.

### Security Findings
No findings. Verified against committed diff: no allFrames; S2 subframe guard untouched; CVV wipe intact both copies; card-number gate intact; message-origin guard untouched; year canonicalization deterministic. ReDoS re-tested (200k-char adversarial, <50ms, flat alternations).
- Investigated the `card.?no\b` false-positive surface (`loyalty_card_no`/`insurance_card_no`/... all matched). Concluded security-benign: only affects which field is *offered*; actual write requires explicit user dropdown selection into a same-page field — same accepted SC4/S2 trust class, no new privileged action reachable. **Flagged to orchestrator as a UX (functionality) concern**, addressed in Round 1→2 fix.
- Seed disposition: seed returned No findings; independent verification performed, nothing to adopt.

### Testing Findings
No findings. C6/C7 satisfied (full .toString() pins RT9, exported symbols RT6, .toBe identity decoys, genuine it.each matrix). T7-extension + fieldCount tests provably red under C4 revert. identity-form-detector.test.ts zero diff (T6). 90/90 changed-file tests pass.
- Seed disposition: all 4 Minor seeds **Rejected** — setupForm is file-local (not shared), per-test ?raw import matches autofill-js-sync precedent, verbose title matches block style, async callback has a real `await import`.

### Orchestrator disposition of the Round-1 UX observation
The `\bcard.?no\b` false-positive class (member-card-number fields surfacing spurious CC suggestions) is security-benign but a real UX false-positive. Presented to the user; user approved tightening. Applied as the Round-1→2 fix (commit 594456ec).

## Round 2 — tightening fix verification

### Changes from Previous Round
Single fix (commit 594456ec): CC number regex `card.?no\b|ccno\b` → `\bcard.?no\b|\bccno\b` in both copies (byte-identical), + decoy counter-fixture (d) + 3 matrix rows. 888 tests pass (+4).

### Functionality Findings (Round 2)
No findings. All 6 target sites still detect their card-number field (4 via `card.?num`, ドスパラ `ccno`/ふるさとチョイス `card_no` via boundary-preceded token); all member-card decoys now correctly rejected. R43 does not fire (narrowing, not widening).

### Security Findings (Round 2)
No findings. Strict narrowing (new pattern ⊂ old); no invariant regresses; byte-identical parity + C6 green; ReDoS re-checked (1ms). Escalate: false.

### Testing Findings (Round 2)
No findings. Fixture (d) + matrix rows are red-provable (removing the leading `\b` flips them to fail); `.js` pinned by cc-regex-parity via `.toString()` (RT9); not vacuous (positive matrix rows prove the regex still fires). 5 target positives still match.

## Adjacent Findings
- [Round 1, functionality→testing, not filed] no fixture isolates expiryCombined alone in C4 exclusion — structurally uniform `Set.has`, no per-field branch; coverage-breadth note only.

## Quality Warnings
None.

## Environment Verification Report
- **VE1 (Phase 1, blocked-deferred)**: end-to-end verification against the 6 non-Stripe production sites (JustMyshop/ドスパラ/さくら/IIJmio/BBexcite/ふるさとチョイス) — `blocked-deferred`. Links to Phase 1 constraint VE1 (third-party production payment forms behind login+purchase; not automatable). Mitigation executed: jsdom fixture matrix reproducing each site's field name/id/label structure — `verified-local` (`npx vitest run` in extension/, 888 passed). Final on-site confirmation delegated to the user post-merge, as the Phase 1 cost-justification records.
- **VE2 (Phase 1, out of scope)**: シラス / Stripe Elements cross-origin iframe — SC2, out of scope, no verification attempted by design.

## Resolution Status
| ID | Severity | Resolution |
|----|----------|-----------|
| Round 1 seed (func) | — | Rejected (false alarm; test passes) |
| Round 1 seeds (test ×4) | — | Rejected (false alarms; file-local helper / precedent / style / real await) |
| Round 1 UX observation (card.?no over-broad) | Minor (UX) | Fixed in Round 2 (commit 594456ec) — `\bcard.?no\b`, user-approved; decoy fixtures added |
| Round 2 (all 3 perspectives) | — | No findings — loop converged |

## Recurring Issue Check
### Functionality expert
Self-check R1-R43 confirmed complete (Phase 2); no new R-rule findings in either round. R42: C4 six-field ccClaimed set complete; no .js twin per SC3 (intentional). R43: both rounds — Round 1 widening bounded by card-number gate; Round 2 is a narrowing, does not fire.

### Security expert
RS1: N/A. RS2: N/A. RS3: N/A. RS4: checked — no personal data in docs. RS5: checked — year canonicalization deterministic. RS6: N/A. allFrames/cross-origin class: checked — untouched. message-origin class: checked — untouched. R43: does not fire (Round 2 narrowing). ReDoS: re-tested both rounds, clean.

### Testing expert
RT1-RT3: N/A. RT4: paired positive GET_CC assertion, not vacuous. RT5: N/A. RT6: satisfied (CC_DETECT_RE/ADDRESS_JA_RE exported+imported). RT7: red-provable (T7-ext, fieldCount, decoy (d), matrix). RT8: N/A. RT9: satisfied (full .toString() parity pin). R19: all 5 test trees accounted.

---

# Round 3 — user security finding: conf.?num CVV misfill

Date: 2026-07-12

## Finding (user-reported, [Medium] → accepted as Major security)
`conf.?num` in the page-wide `CC_DETECT_RE.cvv` alternation matches generic confirmation-number fields. Because CVV regex fallback is first-match-wins over the whole document, and JP-site CVV fields often lack `autocomplete="cc-csc"`, an unrelated `conf_number` field appearing before the real CVV would receive the CVV write — the secret could be submitted to a different form or logged. The Phase-3 security expert had assessed this as accepted SC4 same-page misfill; the user's re-framing (misfill *target* is an unrelated form's field, not merely a positional slip) is the sharper and correct view. Re-classified Major.

## Fix
- Removed `conf.?num` from `CC_DETECT_RE.cvv` (both lib + .js, byte-identical).
- Added `CC_CONF_NUM_RE = /conf.?num/i` as a **co-located-only** CVV fallback: matches a `conf_number` field ONLY when co-located with the detected card-number field — same `<form>`, or (form-less table pages like ドスパラ) a common ancestor tighter than `<body>` (`isCoLocatedWith` / `findConfNumCvvInForm`, mirrored in both copies).
- Runs only after the strong page-wide CVV signals miss, so cvv/cvc/csc/security_code/`\bcard.?verif` still take precedence.

## Design note (form-less pages)
Real ドスパラ markup is a `<table>` with no `<form>`, so `input.form` is null. A pure same-`<form>` scope would break ドスパラ CVV detection. `isCoLocatedWith` therefore requires same-`<form>` when either field has one, else a shared sub-`<body>` container. User-approved.

## Tests
- Detection: unrelated-section conf_number → cvv null; conf_number-before-security_code → security_code wins; same-`<form>` conf_number → claimed; ドスパラ form-less table → claimed. Matrix row `conf_number → cvv` flipped to `false` (no longer page-wide).
- Fill (autofill-cc-lib): unrelated-section conf_number stays empty; co-located table conf_number filled.
- Production `autofill-cc.js` runtime-verified (temporary jsdom harness, discarded) — separate-section not filled, co-located filled.
- Parity: `CC_CONF_NUM_RE` pinned; `conf` asserted absent from `CC_DETECT_RE.cvv`.
- **Mutation-verified**: neutralizing `isCoLocatedWith` (force `return true`) reddens both the detection and the fill security tests.
- Full suite: 895 passed. Build + lint clean.

## Verification vs the three-perspective review
Functionality/Security/Testing Round-1/2 had returned No findings; this finding came from the user post-review. It is a genuine miss of the Phase-3 security pass (the expert accepted the risk rather than eliminating it). Recorded as an essence-consistent tightening, fully fixed in-branch rather than deferred.

---

# Round 5 — user follow-up: form-less co-location was too loose

Date: 2026-07-12

## Finding (user-reported, [Medium])
The Round-3 form-less co-location check ("shared ancestor tighter than `<body>`") degrades to "same page" on SPAs: `#app`/`main`/page-wrapper ancestors are always present, so a payment section and an order-summary section both under `#app` share that ancestor → an unrelated `conf_number` is re-admitted as CVV. The Round-3 negative test missed it because it placed the two sections as direct `<body>` siblings, not under a shared wrapper.

## Fix
- Form-less co-location now requires the SAME `<table>` (not any common ancestor). `#app`/`main` wrappers no longer count. `isCoLocatedWith`.
- Added a CVV-specific signal requirement to the `conf.?num` candidate: `type="password"` OR `maxLength` 3–4 (`looksLikeCvvField`). A generic plain-text confirmation-number field is rejected even inside the same form/table.
- Both copies (lib + .js) mirror `looksLikeCvvField` + the table-scoped `isCoLocatedWith`.

## Tests (all new/updated)
- `#app`/`main` wrapper with a separate `conf_number` section → cvv null (the exact user reproduction).
- Different-`<table>` conf_number → null. Same-`<table>` + CVV signal → claimed.
- Same-`<form>` + CVV signal → claimed; same-`<form>` plain-text (no signal) → null.
- Strong-signal-wins ordering unchanged.
- **Mutation-verified**: (A) reverting `<table>` scope to loose common-ancestor reddens the `#app` wrapper test; (B) dropping the CVV-signal requirement reddens the same-form-no-signal test.
- Full suite: 899 passed. Build + lint clean.

## Residual (accepted)
A same-container 3–4-char confirmation field that is NOT a CVV could still match. Accepted as reasonable defense-in-depth: the combined `conf.?num` name + same-form/table placement + CVV-specific attribute is a narrow surface; user concurred.

## Three-perspective status
Rounds 1–4 returned No findings; this and the Round-3 finding both came from the user post-review — genuine misses of the Phase-3 security pass's threat-model depth on form-less DOM scoping. Both fixed in-branch, mutation-verified, user-confirmed resolved.
