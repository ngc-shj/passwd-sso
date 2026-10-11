# Code Review: login-detection-skips-cc-fields
Date: 2026-10-11
Review round: 1

## Changes from Previous Round
Initial review of the Phase 2 diff (`main...HEAD`). The Phase 2 self-R-check produced one R2 finding, now fixed (`95f027725`), and a twin parity nit, also fixed (`c53497178`). Deviation log D6-D7 was added before review. The local LLM seed step was skipped (optional), so all three experts reviewed the full diff.

## Functionality Findings
- **F-F1 [Major, R3/R17/R42]** — `shouldSkipForm`'s registration heuristic (`extraFields >= 3`) counted the card form's own fields. A combined form could therefore be skipped although C5 says its login password is captured.
- **F-F2 [Major, R48/R49]** — The CC detector's single-valued CVV claim takes an earlier login `security_code` field (FR4 fixture). The CC dropdown then competes on a LOGIN field, and a CC fill writes the CVV there. This predates the change, inside the PR's own scenario.

## Security Findings
- **F-S1 [Minor]** — `ccFormFields` contains `cc-*` fields even without a card number, but plan C2 said "empty". This fails safe and was untested.
- **F-S2 [Minor, informational]** — `directAutofill`'s `scopeForm` fell back to an unvetted `hintedInput`. The result was bounded-safe, because the password is re-filtered, but it was not aligned with the content side.

No Critical or Major findings. No R43 widening.

## Testing Findings
No findings. Every Testing-strategy bullet is implemented. The `vi.mock` spy reaches internal callers, there are no vacuous fixtures, and D6's divergences are pinned.

## Adjacent Findings
None.

## Quality Warnings
None. The orchestrator verified each finding against the code.

## Recurring Issue Check
### Functionality expert
R1 Checked · R3 F-F1 · R10 Checked — acyclic · R17 F-F1 · R19 Checked · R34 F-F1/F-F2 · R42 F-F1 · R43 Checked · R48 F-F2 · R49 F-F2 · others N/A
### Security expert
R1/R3/R10/R19/R42/R43/R48/R49 Checked · R34 F-S1 · RS5 Checked — internal constants · RT1/RT5/RT9/RT10 Checked · others N/A
### Testing expert
RT1 Checked — the spy reaches internal callers · RT2/RT3/RT5/RT6/RT7/RT9/RT10/RT11 Checked · RT4/RT8 N/A · R1-R57 N/A

## Environment Verification Report
- **VE1** (a real page with a login form plus a card form): `blocked-deferred`. This is the Phase 1 constraint VE1, a manual check on the tailscale-served scratch pages before merge.
- Unit coverage: `cd extension && npx vitest run`, all passing.

## Resolution Status

### F-F1 [Major] Registration heuristic counted card fields
- **Action:** `shouldSkipForm` drops `ccForm` members before computing `extraFields`.
- **Test:** a combined form with a cardholder `name` plus phone and country captures the login password.
- **Red proof:** dropping the filter fails the test.
- **Unchanged:** a form that is heavy with billing-address fields (`address`, `city`, ...; these are not card fields) is still skipped, as on `main`.
- **Modified file:** `extension/src/content/login-detector-lib.ts` (`shouldSkipForm`).

### F-F2 [Major] CC claim-stealing
- **Action:** fixed at the root (D8). The CVV regex fallback prefers the card block's match, so the CC trigger set and CC fill follow.
- **Tests:** a deny/allow pair in `cc-form-detector.test.ts`.
- **Red proof:** reverting to first-match fails the deny test.
- **Modified file:** `extension/src/content/cc-field-detection-lib.ts` (`detectCreditCardFields`).

### F-S1 [Minor] Plan C2 wording
- **Action:** C2 now states that without a card number only `cc-*` fields are members; this is the actual, safer behaviour.
- **Test:** a test with a standalone `cc-csc` field (member) and a plain password (not a member).
- **Modified files:** the plan; `extension/src/__tests__/content/login-field-eligibility.test.ts`.

### F-S2 [Minor] Twin `scopeForm`
- **Action:** a hinted field of the card form no longer scopes the twin's search, as on the content side.
- **Test:** a parity test with a hint on the card number, where the card form holds an eligible `pin`.
- **Red proof:** the unvetted hint fails the test.
- **Modified file:** `extension/src/background/direct-autofill.ts` (`scopeForm`).

---

# Code Review: login-detection-skips-cc-fields
Date: 2026-10-11
Review round: 2

## Changes from Previous Round
Round 1's fixes (`10164156b`):
- **F-F1, F-S1, F-S2:** resolved and verified.
- **F-F2:** resolved for its scenario. Its inverse layout is F-F3.
- **Testing:** all four new tests were verified non-vacuous by tracing their reverts. F-S1's test pins a behaviour that has no code fix to revert.

## Functionality Findings
- **F-F3 [Major, narrow precondition]** — The block-preferring CVV claim picks an in-block decoy when the genuine CVV sits outside the block. **Disposition:** recorded as known gap D9, with no code change. The two fields cannot be told apart from markup, and the proposed alternative picks the same field for this layout.

## Security Findings
- **F-S3 [Major as filed, R42/R43]** — `shouldSkipForm`'s exclusion used `ccFormFields`, which also contains stray `cc-*` fields with no card number. A page could therefore make a registration form pass as a login form by tagging its fields. Excluding a field there is not the safe direction.
  - The orchestrator's view on severity: the registration heuristic is not a boundary, because a page already controls its field names. The fix is applied regardless, because the member set was the wrong one for this consumer.
- **Q1, Q3:** no regression. The combined-single-form CVV order is unchanged from `main` (in D9).
- **Adjacent:** `findPasswordInputs` excluding a page-declared `cc-csc` confirm-password field is C2 by design. A page that declares its own field a card field controls that outcome either way.

## Testing Findings
No findings.

## Recurring Issue Check
### Functionality expert
R3/R34/R42/R48/R49 F-F3 · R10 Checked — `cardBlock` hoisted, no cycle · NF3 Checked — cost in the same class, same cadence · others N/A or checked
### Security expert
R42/R43 F-S3 · R48 Checked — one shared `cardBlock` · R49 Checked · RS5 Checked · RT1/RT7/RT9/RT10 Checked · others N/A
### Testing expert
RT1/RT2/RT3/RT6/RT7/RT9/RT10/RT11 Checked · others N/A

## Resolution Status

### F-S3 [Major] Registration heuristic anchored on the wrong member set
- **Action:** a new `ccCardBlockFields(root)` holds the card number plus its in-block neighbours, anchored on a detected card number; there is no `cc-*` fallback. `ccFormFields` = `ccCardBlockFields` ∪ `cc-*` fields. `shouldSkipForm` now drops only `ccCardBlockFields(document)`.
- **Test:** a new-password signup form whose phone field carries a spurious `cc-name` is still skipped, with a plain login form as the control.
  - The detector debounces for 2 s after a send, so the signup is submitted first and the test asserts exactly one `LOGIN_DETECTED`, the login password.
  - The first draft, which submitted the control first, passed vacuously: the control's send debounced the signup submit. The red proof caught it.
- **Red proof:** `ccForm()` restored in `shouldSkipForm` → the test fails.
- **Modified files:** `extension/src/content/cc-field-detection-lib.ts`, `extension/src/content/login-detector-lib.ts`, `extension/src/__tests__/content/login-capture-cc.test.ts`.

### F-F3 [Major] Inverse claim layout
- **Action:** D9 (known gap). No code change.
