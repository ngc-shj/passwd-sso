# Code Review: extension-detector-dedup
Date: 2026-07-24
Review round: 1 (final)

## Changes from Previous Round
Initial code review (three expert agents on the implemented branch). Phase 2 self-R-check baseline in place; this round is incremental verification.

## Functionality Findings
**No findings.** All 7 verification points pass (independently re-ran `npx vitest run` → 915 pass, `npm run build` → success):
1. 34 findFieldBy* call sites (cc 12, identity 22) all pass isUsableField; signature not weakened (isUsable required, un-defaulted — INV-C1-c).
2. 6 helpers gone from both detectors; resolveOpacity defined exactly once (INV-C1-d); findKanaField/findPlainNameField/findConfNumCvvInForm correctly kept local.
3. isElementVisible (moved) still omits clipPath/transform — distinct from isElementVisuallySafe (SC3), behavior-preserving.
4. getHintString assembly order byte-identical to main (name→id→placeholder→aria-label→label[for]→closest label).
5. aria-label null-guard change behavior-identical (same truthy guard, same value, getAttribute side-effect-free).
6. All 11 Implementation Checklist entries appear in the diff.
7. autofill.js deletion behavior-neutral: no executeScript files/content_scripts referenced it; git shows `D` not `R` (refactor-phase-verify move-only check safe).

## Security Findings
**No findings.** No credential-leak, no fail-open, #717 fillable-type allowlist + frame gate preserved:
1. `isUsable` required & un-defaulted in both shared finders; no hardcoded permissive fallback.
2. Per-detector predicates distinct: cc FILLABLE_INPUT_TYPES includes `password` (CVV), identity excludes it; each passes its own isUsableField. No swap/share.
3. manifest.config.ts: autofill.js removed from web_accessible_resources → attack-surface tightening (net-positive); token-bridge.js + webauthn-interceptor.js remain.
4. New about:blank test genuinely drives the !frameHost fail-closed branch (extractHost rejects `about:` protocol → null → return false), asserts no credential write.
5. autofill.js was verified-dead: only content_script is form-detector.ts→autofill-lib.ts; all executeScript files:[] target form-detector.js; zero live references.

## Testing Findings
**No findings.** 130 pass / 0 fail across the 4 affected suites:
1. Added !frameHost test: drives the branch, asserts credential-write mutation (inputs[1].value === ""), **RED-proven** by the reviewer independently (flipped autofill-lib.ts:17 return false→true on a scratchpad copy → failed with "secret"; production restored byte-clean).
2. Deleted autofill-js-sync.test.ts: no coverage gap — it pinned the now-deleted autofill.js twin text (RT4 guard); with the twin gone, autofill-lib.ts is single source, gate behaviorally covered by autofill.test.ts's 5 cases.
3. Removed c11 case: obsolete twin-sync check; the AUTOFILL_FILL value-pin survives at c11:29; autofill-lib.ts imports the constant directly (drift impossible by construction).
4. 5 new exports covered transitively via detectCreditCardFields/detectIdentityFields (autocomplete + regex + radio-reject + password-admit paths) + tsc-enforced required-predicate signature. Standalone test not warranted for a pure move.
5. Detector test files (cc-form-detector.test.ts, identity-form-detector.test.ts) NOT modified — clean behavior-preservation evidence.

## Adjacent Findings
- [Security → Testing] The two deleted ?raw sync tests were RT9/RT4 twin-drift guards; deleting them is correct and required (the .js twin they guarded no longer exists). Not a lost control — the frame gate is now single-source, behaviorally tested. No action.

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
- R1: OK (no re-duplication; resolveOpacity single def)
- R2: OK (getHintString order, aria-label guard, isElementVisible logic all behavior-identical; suite green unchanged)
- R3: OK (unresolvable-origin fail-closed now covered; predicate required)
- R17: OK (reuses resolveOpacity, extractHost/isHostMatch)
- R22: OK (isElementVisible kept distinct from isElementVisuallySafe)
- R42: OK (all 34 sites migrated, counts match plan, positive-assertion clean, tsc/build confirm no orphan)

### Security expert
- R3: OK (!frameHost→false gate intact and now tested)
- R42: OK (both detector call-site sets converted; grep confirms all carry isUsableField)
- R43: OK (no boundary widened; web_accessible narrowed; fillable sets unchanged; predicate required)
- RS3: OK (no new permissive default; shared helper has no hardcoded predicate)
- RS5: OK (no control weakened; attack surface reduced)
- RT9: OK (.js twin eliminated → drift collapsed to single source; frame gate one impl + behavioral fail-closed test)

### Testing expert
- RT1: OK (window.top/location mocked with configurable + finally restore; about:blank is valid new URL())
- RT5: OK (no vacuous assertions; new assertion mutation-based, RED-proven)
- RT6: OK (5 new exports transitively covered; standalone not warranted for pure move)
- RT7: OK (RED-proven by flipping autofill-lib.ts:17 on scratchpad; production restored byte-clean)
- RT8: OK (asserts inputs[1].value === "", not status)
- RT9: OK (twin deleted at root; obsolete guards correctly removed, not left vacuous-green; webauthn-interceptor twin guard untouched)

## Environment Verification Report
Phase 1 declared VE1 (verifiable-local) and VE2 (verifiable-CI), no blocked-deferred paths.
- VE1 — `verified-local`: `npx vitest run` (915 pass) executed by all three reviewers + orchestrator.
- VE2 — `verified-local`: `cd extension && npm run build` (tsc && vite) succeeded.
No blocked-deferred paths.

## Resolution Status
No findings across all three experts in Round 1. No fixes required. Review converged in one round (Phase 2 self-R-check baseline made Round 1 incremental verification).
