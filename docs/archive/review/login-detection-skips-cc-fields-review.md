# Plan Review: login-detection-skips-cc-fields
Date: 2026-10-11
Review round: 1

## Changes from Previous Round
- Initial review of revision 1. The local LLM pre-screen found no issues.
- The security expert escalated one Critical. The Opus tier re-ran on revision 3, settled it as Major, and added two Major and three Minor findings.
- Revisions 2 to 4 apply every finding.

## Functionality Findings
- **F-F1 [Major, R10]** — Import cycle: `form-detector-lib` → eligibility → `cc-form-detector-lib` → `form-detector-lib`. **Resolved (C1):**
  - leaf `field-query-lib` holds the generic helpers;
  - `lib/cc-patterns` holds the patterns;
  - `cc-field-detection-lib` holds the detection;
  - `login-field-eligibility` holds the predicates.

  The graph is acyclic, and there are no re-export barrels.
- **F-F2 [Major, R34]** — The page-wide CVV regex can claim an unrelated login password. **Resolved:** LOGIN excludes only the card form (`ccFormFields`, co-location based); FR4 added.
- **F-F3 [Major]** — In a single form holding a login password and a CVV, `shouldSkipForm` flips. **Resolved:** the new behaviour (the login password is captured) is stated in C5 and tested.
- **F-F4 [Major]** — A split-OTP cell colliding with the CVV regex loses the whole group. **Resolved** by FR4/C2 and a split-OTP test.
- **F-F5 [Major]** — Card scan cost per tick and per focus. **Resolved:** a per-task memo for relocates (C3), and the trigger scan runs only after the cheap checks pass (C4, NF3).
- **F-F6 [Minor, R42]** — The grep missed the `targetHint` block. **Resolved:** listed as a read member.
- **F-F7 [Minor]** — The capture test file was unnamed. **Resolved:** `login-capture-cc.test.ts`.
- **F-F8 [Minor, R48]** — LOGIN scopes to `document`, identity to `root`. **Resolved:** stated as deliberate in C2.

## Security Findings
- **F-S1 [Critical→Major after Opus]** — `directAutofill`'s `findPasswordInScope` is an uncovered twin.
  - Reachable through orphaned tabs after an extension update (`GUARD_KEY` blocks re-injection), plain `http://` hosts, or a slow bundle start.
  - Bounded: the host pin keeps the write on the entry's own host, and the password leaves only when the user submits.
  - Deferring to `#878` was rejected under Anti-Deferral.
  - **Resolved:** C6.
- **F-S2 [Major, R42]** — `shouldTriggerForInput`'s literal `type === "password"` branch was outside the grep. **Resolved:** C4, and the member set notes it.
- **F-S3 [Major, R49]** — C5's closure was overstated: an FR2 autocomplete set by the attacker (neutral vs today, not R43), and point-in-time detection. **Resolved:** both are stated in C5 and pinned by "captured, by design" tests.
- **F-S4 [Minor]** — The three-password-field fallback target was untested. **Resolved:** pinned by a test.
- **F-S5 [Major, Opus F1, R48]** — `ccFormFields` derived from single-valued claims misses the real CVV when an earlier login field steals the claim. **Resolved:** C2 builds `ccFormFields` by a co-location scan, with a claim-stealing deny/allow pair and a red proof.
- **F-S6 [Major, Opus F2, R48/R1/RT9]** — C6 diverged from C2 in four ways: the hint set, table co-location, card-number visibility, and duplicated regexes. **Resolved:**
  - C6 mirrors C2's definition;
  - the patterns live in `lib/cc-patterns.ts` and are passed as `{source, flags}` args;
  - parity fixtures cover each difference.
- **F-S7 [Minor, Opus F3]** — C6 did not filter the username candidate. **Resolved:** C6 filters the hinted/active username, and parity asserts the username target.
- **F-S8 [Minor, Opus F4, RT10]** — Click-based capture was untested. **Resolved:** two cases added.
- **F-S9 [Minor, Opus F5, R49]** — Fill-time point-in-time gap. **Resolved:** added to C2's known gaps.

## Testing Findings
- **F-T1 [Critical, RT5]** — `login-detector.test.ts` mocks `form-detector-lib` wholesale, so a capture test there would be vacuous. **Resolved:** a new real-module `login-capture-cc.test.ts`.
- **F-T2 [Major, R42]** — The same finding as F-S2. **Resolved.**
- **F-T3 [Major, R10]** — The same finding as F-F1. **Resolved.**
- **F-T4 [Minor]** — The eligibility test file was unnamed. **Resolved:** `login-field-eligibility.test.ts`.

## Adjacent Findings
None beyond the merged items.

## Quality Warnings
None. The orchestrator checked each finding against the code: the `direct-autofill.ts` heuristic, the `form-detector-lib` imports in `cc-form-detector-lib`, the single-valued `cvv` claim, and the wholesale mock in `login-detector.test.ts`.

## Recurring Issue Check
### Functionality expert
R1 not triggered · R3 covered · R10 Finding F-F1 · R17 F-F6 · R29 Checked · R34 Finding F-F2 · R42 F-F6 · R48 F-F8 · others N/A
### Security expert (Sonnet tier)
R42 F-S1/F-S2 · R43 Checked — FR2 neutral · R49 F-S1/F-S3 · others N/A or checked (R1, R10, R17)
### Security expert (Opus tier)
R1/R2 F-S6 · R3 F-S5/F-S7 · R10 OK · R19 OK · R34 OK · R42 OK · R43 OK · R48 F-S5/F-S6 · R49 F-S9 · RT7 OK · RT9 F-S6 · RT10 F-S8 · RS1-RS6 N/A
### Testing expert
R10 F-T3 · R19 Checked · R42 F-T2 · RT1 related to F-T1 · RT2 Checked — jsdom visibility works · RT5 F-T1 · RT6 F-T4 · RT7 Checked · RT10 Checked · others N/A

---

# Plan Review: login-detection-skips-cc-fields
Date: 2026-10-11
Review round: 2

## Changes from Previous Round
Revision 4 applied round 1. Revision 5 applies the findings below.

## Functionality Findings
- **R2-F1 [Major, R42]** — Making `findPasswordInputs` card-aware reopened NF3. The unconditional `findAssociatedPasswordInput` in `shouldTriggerForInput` and `scanInputs` on every mutation would each scan for cards. **Resolved (C4):**
  - the trigger is short-circuited, with the per-field checks first;
  - `findPasswordInputs` scans for cards only when raw password fields exist;
  - `scanInputs` uses the raw scan.
- **R2-F2..F8 [Minor]** — **Resolved:**
  - `autofill-cc-lib.ts` added to the callers;
  - `resolveOpacity` is now exported;
  - the test importers are named;
  - the import-graph check lists every edge;
  - the patterns have a single owner (`cc-patterns`), imported by `cc-field-detection-lib`;
  - the fillable-type set is stated (`isUsableField`);
  - C3 separates gated single candidates from filtered lists.

## Security Findings
- Verified: F-S1..F-S9. The C6 pattern args are static extension constants, built with `new RegExp` (not eval), use bounded quantifiers only (no ReDoS), and run in the ISOLATED world.
- **F-S10 [Critical, escalate]** — `isCoLocatedWith`'s form-or-table rule left `<div>`-only checkout CVVs LOGIN-eligible. **Revision 5:** the card block is the card number's form, else the lowest ancestor below `<body>` that holds another CC-hinted field. Deny/allow fixtures and red proofs added, in C2 and C6. Opus adjudication is requested in round 3.
- **F-S11 [Minor]** — A same-block hint collision (`account_security_code`) is excluded. **Resolved:** listed as a known gap that fails safe, pinned by a test.

## Testing Findings
- **QT1 [Major]** — The trigger test file was wrong. **Resolved:** `form-detector-inline.test.ts`.
- **QT2 [Major, R42/RT9]** — The `directAutofill` signature was unspecified. **Resolved:** the signature is stated; absent pattern args mean no exclusion; existing calls are updated.
- **QT3 [Major, RT1/RT5]** — The capture test needs a chrome stub, or its deny cases are vacuous. **Resolved:** stated in the plan.
- **QT4..QT6 [Minor]** — **Resolved:** the test import split is listed; the three-field case is in both suites; a `label[for]` parity fixture uses the `CSS.escape` polyfill.

## Recurring Issue Check
### Functionality expert
R1/R2 R2-F6 · R10 R2-F5 · R19 R2-F2/F3/F4 · R42 R2-F1 · R48 Checked · others N/A
### Security expert
R42 F-S10 · R43 Checked — FR2 neutral (re-traced through capture) · R48 contributing to F-S10 · RS5 Checked — args are internal constants · others N/A
### Testing expert
R19 QT4 · R42 QT2/QT4 · RT1 QT3 · RT2 Checked — `CSS.escape` is absent in jsdom (QT6) · RT5 QT3 · RT9 QT2 · RT10 Checked · others N/A

---

# Plan Review: login-detection-skips-cc-fields
Date: 2026-10-11
Review round: 3

## Changes from Previous Round
Revision 5 applied round 2 and replaced the form-or-table co-location with the card-block rule, which answers F-S10. Revision 6 applies the findings below.

## Security Findings (Opus tier)
- **F-S10 adjudicated: Critical → Minor, settled by revision 5.** Today nothing is excluded, so an uncovered layout is missing coverage, not a widening. The fill is user-initiated and host-pinned, and capture needs the user's consent.
- **S12 [Minor]** — A lone card-number match anchored a block on a login `security_code`, or excluded a `利用者カード番号` login ID. **Resolved:**
  - without a CC-hinted neighbour there is no block, and only `cc-*` fields are excluded;
  - the ancestor rule skips candidates inside another form.
- **S13 [Minor]** — The form branch did not fall through and ignored `form=`. **Resolved:** the form counts only when it holds a neighbour, and membership includes `el.form === form`.
- **S14 [Minor]** — The cross-frame gap was stated for capture only. **Resolved:** a known-gap bullet now covers all LOGIN paths.
- **S15 [Minor]** — C6 still stated the old rule, and its parity inputs (visibility, selects, card-number order, username walk) were unpinned. **Resolved:** C6 references C2's definitions and pins those inputs, with parity fixtures added.
- **S16 [Minor]** — Nothing pinned the call site to pass the pattern args. **Resolved:** a `background.test.ts` assertion, red-proven.
- **S17 [Minor]** — The `PSSO_TRIGGER_INLINE_SUGGESTIONS` loop ran one card scan per candidate. **Resolved:** `ccForm` is computed once per handler call.

## Functionality Findings
- **R3-F1 [Major]** — C6's rule was stale. **Resolved:** the same fix as S15.
- **R3-F2 [Major]** — Two import edges were missing: `cc-field-detection-lib ← {form-detector-lib, autofill-lib}`. **Resolved.**
- **R3-F3 [Major]** — `scanInputs`' raw scan was unnamed. **Resolved:** `rawPasswordInputs`, plus a call-count test.

## Testing Findings
- **QT7 [Major]** — The same finding as R3-F3. **Resolved.**
- **QT8 [Minor]** — The per-tick memo had no test. **Resolved:** a spy-count test.
- **QT9 [Minor]** — The same-block collision case had no control. **Resolved:** an in-fixture eligible `username` is the control.

## Saturation call (round 3)
- Rounds completed: 3. Open Critical/Major findings: none; all were applied in revision 6.
- The design has settled. The Opus tier adjudicated the one design-level escalation (F-S10) as Minor and settled. Every round-3 Major is plan-text consistency rather than a design choice: a stale C6 bullet, two missing graph edges, and an unnamed helper.
- Strict condition 3 is not met, because the experts labelled those round-3 findings "design". The orchestrator exits by judgment, as on prior branches (memory `feedback_plan_granularity_becomes_defect_surface`). Further rounds review the plan's own wording. The remaining surface — whether each fixture behaves as specified — is reachable only by executing the suite with red proofs in Phase 2.
- The user asked for an autonomous run through Phase 3, and this call is reported to them in the final summary.

## Recurring Issue Check
### Security expert (Opus)
R1 S15 · R2 Checked · R10 Checked · R34 S12 · R42 S13/S15/S16 · R43 Checked — FR2 neutral; same host · R48 S12/S15 · R49 S14 · RS2/RS3/RS5 Checked · others N/A
### Functionality expert
R1/R2 R3-F1 · R10 R3-F2 · R19 Checked · R34 Checked · R42 R3-F2/F3 · R48 Checked · others N/A
### Testing expert
R10 Checked · R19 Checked — exactly 2 test importers · R42 QT7/QT8 · RT1 Checked · RT2 Checked · RT5 Checked · RT6 Checked · RT9 Checked · RT10 Checked · others N/A
