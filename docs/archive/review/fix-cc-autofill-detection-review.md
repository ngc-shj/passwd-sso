# Plan Review: fix-cc-autofill-detection

Date: 2026-07-11
Review round: 1

## Changes from Previous Round

Initial review.

## Functionality Findings

- **[F1] Major**: expiryMonth regex false-positive on non-CC fields (e.g. `export_month`). `exp\w*[^a-z0-9]{0,2}month` matches `export_month`/`expected_month`/`experience_month`. Fix: bounded form `exp(?:ir(?:y|e|ation))?[^a-z0-9]{0,2}month`; add negative fixture.
- **[F2] Major**: CVV regex does not match ふるさとチョイス `js-card_verification_code`; silent reliance on unstated JA-label assumption. Fix: add scoped `card.?verif` alternative + state JA-label reliance + fixture drives detection through `label[for]`.
- **[F3] Major**: pre-existing combined-vs-split expiry ordering could starve BBexcite split detection IF `card_expire[m]` were an `<input>`. Resolution: captured page HTML confirms both are `<select>` elements — combined branch (HTMLInputElement-only) cannot claim them. Evidence recorded in plan.
- **[F4] Minor**: C3 acceptance text draft artifact (stale `value="26"` + "correction:" in one sentence). Fix: cleaned.
- **[F5] Minor**: C3 "deterministic bijection" wording imprecise for out-of-domain values. Fix: reworded (pass-through unchanged outside [0,99]).

## Security Findings

**No Critical or Major findings.** All security invariants (frame-scoping, no-fuzzy-match, S2 subframe guard, CVV wipe, card-number gate, message-origin guard) independently verified against code. ReDoS tested (100k-char adversarial inputs, flat alternations, no catastrophic backtracking).

- **[S1] Minor [Adjacent→func/perf]**: C4 doubles per-rescan DOM-scan cost on the pre-existing un-throttled MutationObserver. Not a new vulnerability class.
- **[S2] Minor**: SC4 `conf.?num` genericism — **verdict: ACCEPTED**. Card-number-required gate is correct and sufficient; residual risk bounded to same-page field misplacement within the user-accepted trust boundary.
- **[S3] Minor**: C5 番号 removal is narrowing-only; no security-relevant misdirection.
- **[S4] Minor**: `\bpan\b` anchoring is net security-positive (strictly narrower).

## Testing Findings

- **[T1] Major**: C6 must use the repo's established `?raw` + `.toContain(RE.source)` twin-sync pattern (c11-constants-sync / token-bridge-js-sync / autofill-js-sync precedent), not extract-then-compare.
- **[T2] Major**: C6 needs per-regex assertions (one `it()` each: 5 CC + ADDRESS_JA); autofill-cc.js regex table has ZERO coverage today (RT9 twin drift is real).
- **[T3] Major**: C7 lacked negative/counter-fixtures (japan/company/expand for `\bpan\b`; lone `confirmation_number`; `export_month` decoy). Added.
- **[T4] Minor**: decoy assertions must pin element identity (`.toBe(legitimate)`), per identity-form-detector kana-test pattern.
- **[T5] Major**: T7-extension fixture must be a genuinely overlapping single field (label カード番号) + ≥2 non-CC identity fields, so it is red pre-fix and post-fix suppression is attributable to exclusion (not fieldCount). Verified assertable with existing sentMessages harness.
- **[T6] Major**: verified affirmatively — C5 breaks NO existing test (番号 occurrences: unrelated login-id test + 郵便番号 claimed by POSTAL_JA_RE first); C3 is purely additive.
- **[T7] Minor**: added fieldCount-drops-below-2-after-exclusion boundary fixture.
- **[T8] [Adjacent→security]**: SC4 decision — resolved by S2 (ACCEPTED).

## Adjacent Findings

- S1 → functionality/perf: accepted with quantification (see Resolution Status).
- F5 → security: pass-through year values — security confirmed no unexpected-match risk (normalizeYearValue compares public option strings; silent no-op branch preserved).
- T8 → security: resolved by S2.

## Quality Warnings

None (merge-findings quality gate: no VAGUE / NO-EVIDENCE / UNTESTED-CLAIM flags).

## Resolution Status (Round 1)

| ID | Severity | Resolution |
|----|----------|-----------|
| F1 | Major | Fixed in plan — C1 month/year regexes tightened to `exp(?:ir(?:y|e|ation))?` bounded form; verified by 37-case node matrix (all pass) |
| F2 | Major | Fixed in plan — `card.?verif` added; JA-label reliance stated; fixture via label[for] |
| F3 | Major | Resolved with evidence — BBexcite `card_expire[m]`/`[Y]` are `<select>` per captured HTML; noted in C7 |
| F4 | Minor | Fixed — draft artifact removed |
| F5 | Minor | Fixed — wording corrected |
| S1 | Minor | **Accepted** — Anti-Deferral check: acceptable risk. Worst case: doubled per-rescan DOM scan on hostile rapid-mutation page (perf jank, no data exposure). Likelihood: low (requires adversarial DOM churn; both detectors already scan today). Cost to fix: restructuring both detectors around a shared scan (>30 min, regression risk in security-sensitive detector wiring). TODO(fix-cc-autofill-detection): consider shared single-pass scan if perf complaints arrive. Orchestrator sign-off: acceptable-risk exception satisfied with quantification. |
| S2 | Minor | Recorded — SC4 ACCEPTED by security review; counter-fixture added per T3 |
| S3 | Minor | Recorded — no action |
| S4 | Minor | Recorded — no action |
| T1 | Major | Fixed in plan — C6 redesigned to `?raw` + per-item `.toContain(RE.source)` |
| T2 | Major | Fixed in plan — per-regex `it()` assertions + year-normalizer line pin |
| T3 | Major | Fixed in plan — negative fixture row added to C7 |
| T4 | Minor | Fixed in plan — element-identity assertion mandated |
| T5 | Major | Fixed in plan — overlap fixture spec added (single overlapping field + 2 non-CC identity fields) |
| T6 | Major | Fixed in plan — affirmative verified statements replace "if any" |
| T7 | Minor | Fixed in plan — boundary fixture added |
| T8 | Adjacent | Resolved via S2 |

## Recurring Issue Check

### Functionality expert
- R1: N/A. R2: Checked — intentional duplication pinned by C6, not a violation. R3: Checked — both copies covered per contract; R42 grep confirms no third copy. R4: N/A. R5: N/A. R6: N/A. R7: N/A. R8: N/A. R9: N/A.
- R10: Checked — no cycle; C4 import is one-directional (identity → cc).
- R11: N/A. R12: N/A. R13: N/A. R14: N/A. R15: N/A. R16: N/A. R17: N/A. R18: N/A.
- R19: Checked — CC_DETECT_RE export unaffected by existing mocks. R20: N/A (plan stage). R21: N/A. R22: N/A. R23: N/A. R24: N/A. R25: N/A. R26: N/A. R27: N/A. R28: N/A. R29: N/A. R30: Checked — clean. R31: N/A. R32: N/A. R33: N/A.
- R34: Checked — F3 raised as finding, not silently accepted. R35: N/A — VE1/VE2 serve the manual-test-plan role. R36: N/A. R37: N/A. R38: Checked — no new async state machine. R39: N/A — CVV zeroization untouched. R40: N/A. R41: Checked — pure logic with direct callers.
- R42: Checked — member-set independently reproduced; exactly the plan's claimed set.
- R43: Checked — widening is the deliberate objective; F1 was the concrete unintended-surface instance, flagged and fixed.

### Security expert
- R1: N/A — duplication is documented parallel-implementation constraint. R2: applies by design — mitigated by C6 pin test. R3: checked — member-set (3 duplicated pairs) independently re-verified; no additional copies. R4: N/A. R5: N/A. R6: N/A. R7: N/A. R8: N/A. R9: N/A.
- R10: checked — identity imports cc lib, no cycle. R11: N/A. R12: N/A. R13: N/A. R14: N/A. R15: N/A. R16: N/A. R17: N/A. R18: N/A.
- R19: applies to C6/C7 — CC_DETECT_RE export covered by parity test; satisfied by plan design. R20: N/A at plan stage. R21: N/A. R22: N/A. R23: N/A. R24: N/A. R25: N/A. R26: N/A. R27: N/A. R28: N/A. R29: N/A — no spec citations. R30: checked — no bare #N/@name/SHA in plan doc. R31: N/A. R32: N/A. R33: N/A.
- R34: checked — SC3 deferral has proper cost-justification; security carve-out does not apply (hostless user-picked same-page autofill). R35: applies — VE1/VE2 documented with acceptable substitute. R36: N/A. R37: N/A. R38: N/A.
- R39: checked — CVV wipe confirmed in both copies; no new secret-holding state. R40: N/A. R41: N/A.
- R42: applied — member-set independently re-verified (CC regex: 2 files; year normalizer: 2 files; ADDRESS_JA: 2 files).
- R43: checked carefully — widening is detection-surface precision tuning on an already-hostless, already-gated surface, NOT a re-opened release boundary. Does not fire.
- RS1: N/A — setSelectValue compares public DOM option strings, not secrets. RS2: N/A — no new route. RS3: N/A — no new HTTP boundary. RS4: checked — no personal data in plan doc. RS5: N/A — year input is trusted vault data. RS6: N/A — regex matching only, no escaping chains.

### Testing expert
- R1: N/A. R2: subject of plan, mitigated by C6 — addressed via T1/T2. R3: checked via member-set; no gap beyond T6. R4: N/A. R5: N/A. R6: N/A. R7: N/A — unit/jsdom, not E2E selectors. R8: N/A. R9: N/A. R10: checked — one-directional import, no cycle. R11: N/A. R12: N/A. R13: N/A. R14: N/A. R15: N/A. R16: N/A. R17: N/A. R18: N/A. R19: checked — CC_DETECT_RE read directly by parity test, not mocked. R20: N/A (plan stage). R21: N/A. R22: N/A. R23: N/A. R24: N/A. R25: N/A. R26: N/A. R27: N/A. R28: N/A. R29: N/A. R30: checked — clean. R31: N/A. R32: N/A. R33: checked — existing extension CI job covers new tests. R34: checked — SC1/SC2 properly deferred with owner/reason. R35: N/A. R36: N/A. R37: N/A. R38: N/A. R39: N/A. R40: N/A. R41: N/A.
- R42: verified independently; T7 boundary case added as member of the C4-exclusion class.
- R43: checked — no security boundary widened; card-number gate + \bpan\b tightening bound the widening.
- RT1: checked — mock shapes match real response shapes. RT2: all recommendations verified jsdom-writable. RT3: N/A. RT4: N/A. RT5: checked — T7-extension path is the production primitive path. RT6: satisfied structurally. RT7: driver for T1/T3/T5 — each fixed with red-provable design. RT8: N/A. RT9: real today (zero .js coverage); C6 closes it.

---

# Round 2 (incremental)

Date: 2026-07-11
Review round: 2

## Changes from Previous Round

All 16 Round-1 findings applied to the plan. Round 2 re-verified the fixes and surfaced 8 new findings (F6, S5, S6, T9-T13), of which three (F6/S6/T9) converged on the same root cause.

## Functionality Findings (Round 2)
- [F6] Problem [Adjacent→testing]: C6 substring-`.source` pin is append-blind; cannot catch `.js`-only `|番号` reintroduction (the plan's own Forbidden-pattern 4) nor the year `[0,99]` guard drift. → RESOLVED (see convergence below).
- F1-F5 all re-verified RESOLVED (independent 27-case node matrix; card.?verif matches js-card_verification_code, rejects bare verification_code; BBexcite element-type resolution accepted with captured-page evidence + fixture mandate).

## Security Findings (Round 2)
- [S5] Minor: `card.?verif` matches mid-word `card` (`discard verification`) — parity with pre-existing `card.?num` looseness, not a new class. → APPLIED: `\bcard.?verif` (verified: matches js-card_verification_code and cardverified_flag; rejects discard verification). No attacker leverage; same-page misfill bound identical to accepted S2/SC4.
- [S6] Minor [Adjacent→testing]: C6 `.source` drops `/i` flag → I1 byte-identity not fully enforced; fail-safe direction (i-less .js under-detects → no write). → RESOLVED via convergence.
- All six Round-1 invariants re-verified HOLD. Month/year tightening is security-positive; card.?verif widening is coverage-driven, gated, R43 does not fire. ReDoS re-checked on new nested-optional prefix (0ms, no backtracking).

## Testing Findings (Round 2)
- [T9] Major (convergent with F6/S6): C6 naked `.source` containment structurally blind (RT7 shape-c) to the C5-regression direction + `.js`-only append-drift (RT9). → APPLIED: pin full delimited literal via `RE.toString()` (flags + closing `/` included) for all CC + ADDRESS_JA pins; add explicit negative `.not.toMatch(/addrJa\s*=[^;]*番号/)`; pin the year `[0,99]` guard line too.
- [T10] Major (self-corrects Round-1 T7): fieldCount-boundary fixture with "0 other identity fields" is vacuous (null pre-exclusion too, green on C4 revert). → APPLIED: 1 card-number + 1 holder overlap (identity claim survives C5) + exactly 1 non-CC identity field (郵便番号) → count 2→1 across C4.
- [T11] Major: T7-extension race test used card_no overlap, which C5 alone de-claims → green on C4-alone revert; I2 acceptance not genuinely pinned to C4. → APPLIED: overlap field changed to holder_name+カード名義人 (identity-claimed via 名, survives C5, removed only by C4); assert focus-holder → GET_CC once + GET_IDENTITY zero, red under C4 revert.
- [T12] Minor: 37-case verification matrix was unversioned (RT7-b). → APPLIED: committed as table-driven it.each against exported CC_DETECT_RE (C7 "regex matrix" row).
- [T13] Minor: ADDRESS_JA_RE not exported but C6 must import it. → APPLIED: C5 now mandates `export ADDRESS_JA_RE`.

## Perspective Convergence
F6 (functionality) + S6 (security) + T9 (testing) independently identified the C6 `.source`-containment weakness (append-blindness / flag-blindness) at the same location. Per Perspective-Convergence rule the merged finding floors at Major and was fixed first: C6 redesigned to pin the full `RE.toString()` literal + explicit forbidden-pattern negative + year-guard-line pin.

## Resolution Status (Round 2)
| ID | Severity | Resolution |
|----|----------|-----------|
| F6 | Major (convergent) | Fixed — full-literal pin + negative + guard-line pin |
| S5 | Minor | Applied — `\bcard.?verif` |
| S6 | Minor (convergent) | Fixed — `.toString()` pins flags |
| T9 | Major (convergent) | Fixed — see F6 |
| T10 | Major | Fixed — corrected boundary fixture (2→1) |
| T11 | Major | Fixed — holder overlap field pins C4 |
| T12 | Minor | Fixed — committed it.each matrix |
| T13 | Minor | Fixed — export ADDRESS_JA_RE in C5 |

## Recurring Issue Check (changed from Round 1)
- Functionality R34, R43: → Checked-no-issue (F3 resolved; month/year narrowed, no boundary widened between rounds).
- Security R43: re-evaluated for round-2 delta (cvv widened, month/year narrowed) — coverage-driven, not a security-narrowing revert; does not fire.
- Testing RT7: three new violations found and fixed (T9/T10/T11 shape-c + T12 shape-b). RT9: C6 append-drift closed by full-literal pin. R3: Round-1 T7 seed spec was flawed and propagated; corrected at seed (T10).
- All other statuses unchanged from Round 1.

---

# Round 3 (incremental) — convergence

Date: 2026-07-11
Review round: 3

## Result
- Functionality: **No findings** (F6 fully resolved by the full-literal `toString()` pin — "a better fix than what I proposed"; S5/T10/T11/T12/T13 all re-verified sound).
- Security: **No findings** (S5 `\bcard.?verif` and S6 `.toString()` flag-inclusive pin confirmed; no invariant regression; R43 does not fire — `\b` prepend is a narrowing).
- Testing: one Minor — **[T14]**: expository guard-rail so an implementer does not add a focus-`card_no` GET_IDENTITY-zero assertion (green on C4 revert — the T11 trap); `card_no` exists only to satisfy the card-number gate. → APPLIED (one clause added to the T7-extension row).

## Termination
Loop converged at Round 3: two experts clean, the sole remaining finding (T14) is a self-contained expository note with no design change, applied immediately. No open Critical/Major/Minor findings remain. All contracts C1-C7 stay `locked`. Phase 1 complete.
