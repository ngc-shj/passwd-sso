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
